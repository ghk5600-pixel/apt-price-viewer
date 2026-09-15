import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildAreaValidation, buildSupplyProfile, consumeBuildingAreaRows, createCollectionState, findSupplyGroup, SUPPLY_CALCULATION_VERSION } from "../functions/_shared/supply-area.js";
import { onRequestGet, shouldResetRecord, formatCollectionError } from "../functions/api/supply-profile.js";

// Public ledger snapshot fetched 2026-09-07: 중동 1788, 해운대로 732.
// Two units; identifiers anonymized, purposes and areas retained verbatim.
const rows = JSON.parse(fs.readFileSync(new URL("./fixtures/haeundae-honors-area.json", import.meta.url), "utf8").replace(/^\uFEFF/, ""));

test("해운대 경남아너스빌 39타입의 실제 공급면적을 페이지 경계에서도 보존한다", () => {
  let state = createCollectionState();
  for (let i = 0; i < rows.length; i += 3) {
    state = consumeBuildingAreaRows(JSON.parse(JSON.stringify(state)), rows.slice(i, i + 3), { isFinal: i + 3 >= rows.length });
  }
  const profile = buildSupplyProfile({ complexKey: "honors", source: {}, collectionState: state, expectedHouseholds: 2 });
  assert.equal(profile.unitCount, 2);
  assert.equal(profile.householdValidation.exactMatch, true);
  assert.equal(profile.areaValidation.status, "matched");
  const small = state.patterns.find(p => p.exclusiveArea === 39.6602);
  assert.equal(small.residentialCommonArea, 36.0131);
  assert.equal(small.supplyArea, 75.6733);
  assert.equal(findSupplyGroup(profile, 39.6602).unitCount, 1);
  assert.equal(findSupplyGroup(profile, 84.9077).unitCount, 1);
});

test("비율 검증은 새 상한 경계와 과소·과대 면적을 구분한다", () => {
  const validate = (exclusiveArea, supplyArea) => buildAreaValidation([{ exclusiveArea, supplyArea, unitCount: 1 }]);
  assert.equal(validate(40, 44).status, "matched");
  assert.equal(validate(40, 80).status, "matched");
  assert.equal(validate(40, 43.9999).issues[0].reason, "supply-ratio-too-low");
  assert.equal(validate(40, 80.0001).issues[0].reason, "supply-ratio-too-high");
});

test("이전 계산 버전의 실패 캐시를 재수집하고 화면 버전도 일치시킨다", () => {
  const request = { sourceSignature: "same" };
  assert.equal(shouldResetRecord({ status: "failed", calculationVersion: "supply-model-v18-common-fallback", sourceSignature: "same" }, request), true);
  const app = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
  assert.equal(app.match(/const SUPPLY_CALCULATION_VERSION = "([^"]+)"/)[1], SUPPLY_CALCULATION_VERSION);
});

test("기대 세대수만 달라져도 정상 공급면적 캐시는 보존한다", () => {
  const record = {
    status: "ready",
    calculationVersion: SUPPLY_CALCULATION_VERSION,
    profile: { unitCount: 828 },
  };
  assert.equal(
    shouldResetRecord(record, { expectedHouseholds: 900, sourceSignature: "same" }),
    false
  );
});

for (const abnormal of [false, true]) {
  test(`공급면적 API: ${abnormal ? "상한 초과는 최종 실패" : "경남아너스빌 실제 면적은 ready"}`, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.__supplyProfileRecords = new Map();
    const input = rows.map(row => abnormal && row.etcPurps === "계단실, 피로티" ? { ...row, area: 100 } : row);
    globalThis.fetch = async (url) => {
      const parsed = new URL(url);
      const items = parsed.pathname.endsWith("/getBrExposPubuseAreaInfo") ? input : [{ mgmBldrgstPk: "honors-title", sigunguCd: "26350", bjdongCd: "10600", platGbCd: "0", bun: "1788", ji: "0000", bldNm: "해운대 경남아너스빌", mainPurpsCdNm: "공동주택" }];
      return new Response(JSON.stringify({ response: { header: { resultCode: "00", resultMsg: "OK" }, body: { items: { item: items }, totalCount: items.length, numOfRows: 1000 } } }));
    };
    try {
      const response = await onRequestGet({ request: new Request(`http://localhost/api/supply-profile?complexKey=honors-${abnormal}&sigunguCd=26350&bjdongCd=10600&platGbCd=0&bun=1788&ji=0000&expectedHouseholds=2`), env: { MOLIT_SERVICE_KEY: "test" } });
      const payload = await response.json();
      assert.equal(response.status, abnormal ? 502 : 200);
      assert.equal(payload.status, abnormal ? "failed" : "ready");
      if (abnormal) {
        assert.equal(payload.errorDetails.resultCode, "ABNORMAL_SUPPLY_AREA");
        assert.equal(payload.errorDetails.retryable, false);
        assert.match(formatCollectionError(payload.errorDetails), /실패/);
        input.splice(0, input.length, ...rows);
        const retryResponse = await onRequestGet({
          request: new Request(`http://localhost/api/supply-profile?complexKey=honors-${abnormal}&sigunguCd=26350&bjdongCd=10600&platGbCd=0&bun=1788&ji=0000&expectedHouseholds=2&retry=1`),
          env: { MOLIT_SERVICE_KEY: "test" },
        });
        assert.equal(retryResponse.status, 200);
        assert.equal((await retryResponse.json()).status, "ready");
      } else {
        assert.equal(payload.profile.unitCount, 2);
        assert.equal(payload.profile.areaValidation.status, "matched");
      }
    } finally {
      globalThis.fetch = originalFetch;
      globalThis.__supplyProfileRecords = new Map();
    }
  });
}
