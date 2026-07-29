import test from "node:test";
import assert from "node:assert/strict";
import { onRequestGet } from "../functions/api/supply-profile.js";

test("최초 조회를 페이지 단위로 저장하고 다음 조회에서 완성한다", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const pageNo = Number(new URL(url).searchParams.get("pageNo"));
    const items =
      pageNo === 1
        ? [
            row("unit-api-1", "전유", 84.95, "아파트"),
            row("unit-api-1", "공용", 27.9, "벽체"),
            row("unit-api-2", "전유", 84.95, "아파트"),
          ]
        : [row("unit-api-2", "공용", 26.77, "계단실")];
    return new Response(
      JSON.stringify({
        response: {
          header: { resultCode: "00", resultMsg: "OK" },
          body: { items: { item: items }, totalCount: 101, pageNo, numOfRows: 100 },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  try {
    const url =
      "http://localhost/api/supply-profile?complexKey=api-test-complex" +
      "&sigunguCd=11680&bjdongCd=11400&platGbCd=0&bun=0743&ji=0000&batchSize=1";
    const first = await onRequestGet({ request: new Request(url), env: { MOLIT_SERVICE_KEY: "test" } });
    const firstPayload = await first.json();
    assert.equal(first.status, 202);
    assert.equal(firstPayload.status, "building");
    assert.equal(firstPayload.completedPages, 1);

    const second = await onRequestGet({ request: new Request(url), env: { MOLIT_SERVICE_KEY: "test" } });
    const secondPayload = await second.json();
    assert.equal(second.status, 200);
    assert.equal(secondPayload.status, "ready");
    assert.equal(secondPayload.storage, "memory");
    assert.equal(secondPayload.profile.unitCount, 2);
    assert.equal(secondPayload.profile.groups[0].id, "84");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function row(key, useType, area, purpose) {
  return {
    mgmBldrgstPk: key,
    exposPubuseGbCdNm: useType,
    area,
    mainPurpsCdNm: purpose,
    etcPurps: "",
    dongNm: "101동",
  };
}
