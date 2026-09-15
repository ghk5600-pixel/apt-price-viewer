import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { buildAptListUrl, buildAptBasisUrl, fetchJsonApi, parseRtmsXml } from "../functions/_shared/molit.js";

const app = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
function functionsBetween(start, end) { return app.slice(app.indexOf(start), app.indexOf(end)); }

test("한국 시간 월 경계와 연도 변경을 현재 날짜에 반영한다", () => {
  const context = vm.createContext({ Intl, Date });
  vm.runInContext(functionsBetween("function getKoreaToday", "const MAX_FAVORITES"), context);
  assert.equal(vm.runInContext('getKoreaToday(new Date("2026-08-31T15:00:00Z"))', context), "2026-09-01");
  assert.equal(vm.runInContext('getKoreaToday(new Date("2026-12-31T15:00:00Z"))', context), "2027-01-01");
  assert.doesNotMatch(app, /REFERENCE_MONTH/);
  assert.match(app, /parseTransactionDate\(getKoreaToday\(\)\)/);
});

test("새로고침 뒤 저장된 실거래 loading 상태를 다시 조회 가능하게 복구한다", () => {
  const context = vm.createContext({ Array });
  vm.runInContext(
    functionsBetween("function normalizeStoredTradeStatus", "function loadCustomComplexes"),
    context
  );
  assert.equal(
    vm.runInContext('normalizeStoredTradeStatus({tradeStatus:"loading",realTransactions:[]})', context),
    "idle"
  );
  assert.equal(
    vm.runInContext('normalizeStoredTradeStatus({tradeStatus:"loading",realTransactions:[{}]})', context),
    "loaded"
  );
});

test("조회가 끝난 무거래 단지를 매칭 전으로 표시하지 않는다", () => {
  const context = vm.createContext({});
  vm.runInContext(functionsBetween("function formatNoTradeStatus", "function renderChart"), context);
  assert.equal(
    vm.runInContext('formatNoTradeStatus({tradeStatus:"empty"})', context),
    "최근 24개월 거래 없음"
  );
});

test("공식 K-apt v4 목록과 v5 기본정보 주소를 사용한다", () => {
  assert.equal(buildAptListUrl({ serviceKey: "test", bjdCode: "2635010600" }).pathname, "/1613000/AptListService4/getLegaldongAptList4");
  assert.equal(buildAptBasisUrl({ serviceKey: "test", operation: "getAphusBassInfoV5", kaptCode: "test" }).pathname, "/1613000/AptBasisInfoServiceV5/getAphusBassInfoV5");
});

test("마지막 거래 페이지까지 수집하고 해제 거래만 제외한다", async () => {
  const pages = [];
  const context = vm.createContext({
    shouldUseBackendApi: () => true,
    buildRtmsRequestUrl: (args) => args,
    fetch: async ({ pageNo }) => {
      pages.push(pageNo);
      return { ok: true, json: async () => ({ totalCount: 3, items: pageNo === 1 ? [{ id: 1 }, { id: 2, cdealType: "O" }] : [{ id: 3 }] }) };
    },
  });
  vm.runInContext(functionsBetween("async function fetchRtmsMonth", "function buildRtmsRequestUrl"), context);
  const result = await vm.runInContext('fetchRtmsMonth({lawdCd:"26350",dealYmd:"202609"})', context);
  assert.deepEqual(pages, [1, 2]);
  assert.deepEqual(Array.from(result, (row) => row.id), [1, 3]);
});

test("서버 파서는 해제 필드를 보존한다", () => {
  const [item] = parseRtmsXml("<item><aptNm>단지</aptNm><cdealType>O</cdealType><cdealDay>26.09.01</cdealDay></item>");
  assert.equal(item.cdealType, "O");
  assert.equal(item.cdealDay, "26.09.01");
});

test("상류 실패는 오류코드만 전달하고 인증키를 가린다", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('<returnReasonCode>30</returnReasonCode><returnAuthMsg>bad secret-value</returnAuthMsg>', { status: 400 });
  try {
    await assert.rejects(fetchJsonApi(new URL("https://example.test/?serviceKey=secret-value")), (error) => {
      assert.match(error.message, /400.*30/);
      assert.doesNotMatch(error.message, /secret-value/);
      return true;
    });
  } finally { globalThis.fetch = originalFetch; }
});
