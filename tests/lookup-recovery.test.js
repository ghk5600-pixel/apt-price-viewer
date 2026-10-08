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

test("탭 사이 거래 캐시는 단지별로 동기화하고 오래된 결과가 덮어쓰지 못한다", () => {
  const values = new Map();
  const localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const context = vm.createContext({
    Date,
    Array,
    localStorage,
    TRADE_CACHE_KEY_PREFIX: "test-trade-",
    COMPLEXES: [{ id: "a" }, { id: "b" }],
    transactionsByComplex: {},
  });
  vm.runInContext(functionsBetween("function normalizeStoredTradeStatus", "function loadCustomComplexes"), context);
  const newer = {
    id: "a", realTransactions: [{ priceEok: 16 }], tradeStatus: "loaded",
    lastTradeSync: "2026-10-08T01:00:00Z", lastFullTradeSync: "2026-10-01T01:00:00Z",
    lastTradeAttempt: "2026-10-08T00:59:00Z",
  };
  context.complex = newer;
  assert.equal(vm.runInContext("saveTradeCache(complex)", context), true);
  context.complex = {
    ...newer, realTransactions: [{ priceEok: 15 }],
    lastTradeSync: "2026-10-07T01:00:00Z", lastTradeAttempt: "2026-10-07T00:59:00Z",
  };
  assert.equal(vm.runInContext("saveTradeCache(complex)", context), false);
  assert.equal(JSON.parse(values.get("test-trade-a")).realTransactions[0].priceEok, 16);
  assert.equal(vm.runInContext('syncStoredTradeCache("a")', context), true);
  assert.equal(context.COMPLEXES[0].realTransactions[0].priceEok, 16);
  assert.equal(context.transactionsByComplex.a[0].priceEok, 16);
  assert.equal(values.has("test-trade-b"), false);
});

test("두 탭의 같은 단지 갱신은 잠금 뒤 기한을 다시 확인해 한 번만 조회한다", async () => {
  let lockQueue = Promise.resolve();
  let fetchCount = 0;
  const complex = { id: "a", due: true };
  const context = vm.createContext({
    Promise,
    COMPLEXES: [complex],
    navigator: { locks: { request: (_name, callback) => {
      const result = lockQueue.then(callback);
      lockQueue = result.catch(() => {});
      return result;
    } } },
    syncStoredTradeCache: () => {},
    getTradeRefreshMode: (item) => item.due ? "recent" : null,
    performRealTransactionsRefresh: async () => {
      fetchCount += 1;
      complex.due = false;
    },
  });
  vm.runInContext(functionsBetween("async function refreshRealTransactionsForComplex", "async function performRealTransactionsRefresh"), context);
  await vm.runInContext('Promise.all([refreshRealTransactionsForComplex("a", {onlyIfDue:true}), refreshRealTransactionsForComplex("a", {onlyIfDue:true})])', context);
  assert.equal(fetchCount, 1);
});

test("실거래는 한국 시간 매일 최근 3개월, 1일·15일에는 전체를 조회한다", () => {
  const context = vm.createContext({ Date, Number, Intl, TRADE_RETRY_INTERVAL_MS: 24 * 60 * 60 * 1000 });
  vm.runInContext(functionsBetween("function getKoreaToday", "const MAX_FAVORITES"), context);
  vm.runInContext(functionsBetween("function getLatestTradeRefreshBoundary", "async function refreshAptIdentityInfoForComplex"), context);
  context.complex = { tradeStatus: "loaded", lastTradeSync: "2026-10-08T00:00:00Z", lastFullTradeSync: "2026-10-01T00:00:00Z" };
  assert.equal(vm.runInContext('getTradeRefreshMode(complex, new Date("2026-10-08T10:00:00Z"))', context), null);
  assert.equal(vm.runInContext('getTradeRefreshMode(complex, new Date("2026-10-09T00:00:00Z"))', context), "recent");
  assert.equal(vm.runInContext('getTradeRefreshMode(complex, new Date("2026-10-14T14:59:59Z"))', context), "recent");
  assert.equal(vm.runInContext('getTradeRefreshMode(complex, new Date("2026-10-14T15:00:00Z"))', context), "full");
  context.complex.lastTradeSync = "2026-10-14T15:01:00Z";
  context.complex.lastFullTradeSync = "2026-10-14T15:01:00Z";
  assert.equal(vm.runInContext('getTradeRefreshMode(complex, new Date("2026-10-15T00:00:00Z"))', context), null);
  assert.equal(vm.runInContext('getTradeRefreshMode(complex, new Date("2026-10-17T15:00:00Z"))', context), "recent");
  context.complex = { tradeStatus: "loaded", lastTradeSync: "2026-10-03T00:00:00Z", lastFullTradeSync: "2026-10-01T00:00:00Z" };
  assert.equal(vm.runInContext('getTradeRefreshMode(complex, new Date("2026-10-18T00:00:00Z"))', context), "full");
  context.complex = { tradeStatus: "error", realTransactions: [{}], lastTradeSync: "2026-10-08T00:00:00Z", lastFullTradeSync: "2026-10-01T00:00:00Z", lastTradeAttempt: "2026-10-14T15:05:00Z" };
  assert.equal(vm.runInContext('getTradeRefreshMode(complex, new Date("2026-10-14T16:00:00Z"))', context), null);
  assert.equal(vm.runInContext('getTradeRefreshMode(complex, new Date("2026-10-15T16:00:00Z"))', context), "full");
  context.complex = { tradeStatus: "error", realTransactions: [], lastTradeAttempt: "2026-10-14T15:05:00Z" };
  assert.equal(vm.runInContext('getTradeRefreshMode(complex, new Date("2026-10-14T16:00:00Z"))', context), null);
  assert.equal(vm.runInContext('getTradeRefreshMode(complex, new Date("2026-10-15T16:00:00Z"))', context), "full");
});

test("갱신일에는 모든 관심단지의 거래만 순차 조회한다", async () => {
  const calls = [];
  const context = vm.createContext({
    state: { favorites: ["a", "b", "c"], selectedComplexId: "b", tradeRefreshRunning: false },
    COMPLEXES: ["a", "b", "c"].map((id) => ({ id, source: "kakao" })),
    isUserRegisteredSource: () => true,
    getTradeRefreshMode: () => "recent",
    refreshRealTransactionsForComplex: async (id, options) => calls.push({ id, tradesOnly: options.tradesOnly }),
    Promise,
  });
  vm.runInContext(functionsBetween("async function refreshDueFavoriteTrades", "function getLatestTradeRefreshBoundary"), context);
  await vm.runInContext("refreshDueFavoriteTrades()", context);
  assert.deepEqual(calls, [
    { id: "b", tradesOnly: true },
    { id: "a", tradesOnly: true },
    { id: "c", tradesOnly: true },
  ]);
});

test("부분 갱신은 조회한 월을 교체하고 다른 월의 거래를 보존한다", () => {
  const context = vm.createContext({ Set });
  vm.runInContext(functionsBetween("function mergeRefreshedTransactions", "function enrichComplexLocationFromKakao"), context);
  context.existing = [
    { month: "2026-08", date: "2026-08-02", priceEok: 12 },
    { month: "2026-09", date: "2026-09-30", priceEok: 15 },
    { month: "2026-10", date: "2026-10-01", priceEok: 13 },
  ];
  context.refreshed = [{ month: "2026-09", date: "2026-09-30", priceEok: 16 }];
  const merged = vm.runInContext('mergeRefreshedTransactions(existing, refreshed, ["2026-09", "2026-10"], ["2026-08", "2026-09", "2026-10"])', context);
  assert.deepEqual(Array.from(merged, (tx) => tx.priceEok), [12, 16]);
});

test("월별 국토부 요청은 화면 전체에서 최대 네 개만 동시에 실행한다", async () => {
  let active = 0;
  let peak = 0;
  const context = vm.createContext({
    Promise,
    RTMS_MAX_CONCURRENT_MONTHS: 4,
    rtmsMonthQueue: [],
    fetchRtmsMonth: async ({ dealYmd }) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return [{ dealYmd }];
    },
  });
  vm.runInContext('let activeRtmsMonths = 0;', context);
  vm.runInContext(functionsBetween("async function fetchRtmsItemsForComplex", "async function fetchRtmsMonth"), context);
  const result = await vm.runInContext('Promise.all([fetchRtmsItemsForComplex({legalDongCode:"26350"}, ["2026-01","2026-02","2026-03","2026-04"]), fetchRtmsItemsForComplex({legalDongCode:"26350"}, ["2026-05","2026-06","2026-07","2026-08"])])', context);
  assert.equal(peak, 4);
  assert.equal(result.flatMap((item) => item.monthly).length, 8);
  assert.equal(result.flatMap((item) => item.failedMonths).length, 0);
});

test("월별 조회가 일부 실패해도 성공한 월만 교체하고 실패한 월은 보존한다", async () => {
  const context = vm.createContext({
    Promise,
    Set,
    RTMS_MAX_CONCURRENT_MONTHS: 4,
    rtmsMonthQueue: [],
    fetchRtmsMonth: async ({ dealYmd }) => {
      if (dealYmd === "202609") throw new Error("일시 장애");
      return [{ dealYmd }];
    },
  });
  vm.runInContext('let activeRtmsMonths = 0;', context);
  vm.runInContext(functionsBetween("async function fetchRtmsItemsForComplex", "async function fetchRtmsMonth"), context);
  vm.runInContext(functionsBetween("function mergeRefreshedTransactions", "function enrichComplexLocationFromKakao"), context);
  const result = await vm.runInContext('fetchRtmsItemsForComplex({legalDongCode:"26350"}, ["2026-08","2026-09","2026-10"])', context);
  assert.deepEqual(Array.from(result.monthly, ({ month }) => month), ["2026-08", "2026-10"]);
  assert.deepEqual(Array.from(result.failedMonths), ["2026-09"]);
  context.existing = [
    { month: "2026-08", date: "2026-08-02", priceEok: 12 },
    { month: "2026-09", date: "2026-09-30", priceEok: 15 },
    { month: "2026-10", date: "2026-10-01", priceEok: 13 },
  ];
  context.refreshed = [{ month: "2026-10", date: "2026-10-02", priceEok: 16 }];
  context.successfulMonths = result.monthly.map(({ month }) => month);
  const merged = vm.runInContext('mergeRefreshedTransactions(existing, refreshed, successfulMonths, ["2026-08", "2026-09", "2026-10"])', context);
  assert.deepEqual(Array.from(merged, (tx) => tx.priceEok), [15, 16]);
});

test("마린시티자이 9월 거래는 단지명과 84타입으로 매칭된다", () => {
  const context = vm.createContext({});
  vm.runInContext(functionsBetween("function isRtmsItemMatch", "function rtmsItemToTransaction"), context);
  vm.runInContext(functionsBetween("function normalizeApartmentName", "function updateTradeTags"), context);
  vm.runInContext(functionsBetween("function normalize(value)", "function stringSimilarity"), context);
  vm.runInContext(functionsBetween("function getAreaGroupId", "function getAvailableAreaGroupMetas"), context);
  vm.runInContext('const AREA_GROUPS = [{id:"84",min:83,max:85}];', context);
  context.complex = { name: "마린시티자이아파트", dong: "우동", lotNumber: "1405-1" };
  context.item = { aptNm: "마린시티자이", umdNm: "우동", jibun: "1405-1" };
  assert.equal(vm.runInContext("isRtmsItemMatch(complex, item)", context), true);
  assert.equal(vm.runInContext("getAreaGroupId(84.7798)", context), "84");
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

test("읍 아래 리가 포함된 실거래를 단지명과 지번으로 안전하게 매칭한다", () => {
  const context = vm.createContext({});
  vm.runInContext(functionsBetween("function isRtmsItemMatch", "function rtmsItemToTransaction"), context);
  vm.runInContext(functionsBetween("function normalizeApartmentName", "function updateTradeTags"), context);
  vm.runInContext(functionsBetween("function normalize(value)", "function stringSimilarity"), context);

  const cases = [
    {
      complex: {
        name: "중흥S-클래스 에듀포레",
        kaptName: "중흥S-클래스 에듀포레",
        dong: "산동읍",
        lotNumber: "1116",
      },
      item: {
        aptNm: "구미확장단지중흥S-클래스에듀포레",
        umdNm: "산동읍 인덕리",
        jibun: "1116",
      },
    },
    {
      complex: {
        name: "우미린센트럴파크",
        kaptName: "우미린센트럴파크",
        dong: "산동읍",
        lotNumber: "1383",
      },
      item: {
        aptNm: "우미린센트럴파크",
        umdNm: "산동읍 신당리",
        jibun: "1383",
      },
    },
  ];

  for (const { complex, item } of cases) {
    context.complex = complex;
    context.item = item;
    assert.equal(vm.runInContext("isRtmsItemMatch(complex, item)", context), true);
  }
});

test("부모 읍만 같은 다른 리의 동명 단지는 지번이 다르면 매칭하지 않는다", () => {
  const context = vm.createContext({
    complex: {
      name: "우미린센트럴파크",
      dong: "산동읍",
      lotNumber: "1383",
    },
    item: {
      aptNm: "우미린센트럴파크",
      umdNm: "산동읍 다른리",
      jibun: "999",
    },
  });
  vm.runInContext(functionsBetween("function isRtmsItemMatch", "function rtmsItemToTransaction"), context);
  vm.runInContext(functionsBetween("function normalizeApartmentName", "function updateTradeTags"), context);
  vm.runInContext(functionsBetween("function normalize(value)", "function stringSimilarity"), context);

  assert.equal(vm.runInContext("isRtmsItemMatch(complex, item)", context), false);

  context.complex.legalDongName = "산동읍 신당리";
  context.item.jibun = "1383";
  assert.equal(vm.runInContext("isRtmsItemMatch(complex, item)", context), false);
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
