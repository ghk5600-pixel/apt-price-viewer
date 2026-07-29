import test from "node:test";
import assert from "node:assert/strict";
import { onRequestGet } from "../functions/api/supply-profile.js";

test("첫 페이지부터 한 페이지씩 순차 저장하고 K-apt 세대수를 검증한다", async () => {
  const originalFetch = globalThis.fetch;
  const requestedPages = [];
  globalThis.__supplyProfileRecords = new Map();
  globalThis.fetch = async (url) => {
    const pageNo = Number(new URL(url).searchParams.get("pageNo"));
    requestedPages.push(pageNo);
    const items =
      pageNo === 1
        ? [
            row("unit-api-1", "전유", 84.95, "아파트"),
            row("unit-api-1", "공용", 27.9, "벽체"),
            row("unit-api-2", "전유", 84.95, "아파트"),
          ]
        : [row("unit-api-2", "공용", 26.77, "계단실")];
    return successResponse(items, 101);
  };

  try {
    const url = requestUrl("sequential-complex", { expectedHouseholds: 2 });
    const first = await callApi(url);
    assert.equal(first.response.status, 202);
    assert.equal(first.payload.status, "building");
    assert.equal(first.payload.completedPages, 1);
    assert.equal(first.payload.currentPage, 2);
    assert.deepEqual(requestedPages, [1]);

    const second = await callApi(url);
    assert.equal(second.response.status, 200);
    assert.equal(second.payload.status, "ready");
    assert.equal(second.payload.storage, "memory");
    assert.equal(second.payload.profile.unitCount, 2);
    assert.equal(second.payload.profile.groups[0].id, "84");
    assert.equal(second.payload.validation.status, "matched");
    assert.equal(second.payload.validation.expectedHouseholds, 2);
    assert.deepEqual(requestedPages, [1, 2]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("같은 페이지의 일시적 오류를 자동 재시도한 뒤 성공한다", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.__supplyProfileRecords = new Map();
  globalThis.fetch = async () => {
    attempts += 1;
    if (attempts < 3) {
      return errorResponse(500, "99", "일시적인 건축HUB 내부 오류");
    }
    return successResponse([
      row("retry-unit", "전유", 84.95, "아파트"),
      row("retry-unit", "공용", 26.77, "계단실"),
    ]);
  };

  try {
    const { response, payload } = await callApi(
      requestUrl("retry-success-complex", { expectedHouseholds: 1 })
    );
    assert.equal(response.status, 200);
    assert.equal(payload.status, "ready");
    assert.equal(payload.validation.status, "matched");
    assert.equal(attempts, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("성공한 페이지를 보존하고 실패 페이지부터 이어서 수집한다", async () => {
  const originalFetch = globalThis.fetch;
  const requestedPages = [];
  let allowSecondPage = false;
  globalThis.__supplyProfileRecords = new Map();
  globalThis.fetch = async (url) => {
    const pageNo = Number(new URL(url).searchParams.get("pageNo"));
    requestedPages.push(pageNo);
    if (pageNo === 2 && !allowSecondPage) {
      return errorResponse(500, "99", "두 번째 페이지 임시 장애");
    }
    if (pageNo === 1) {
      return successResponse([
        row("checkpoint-unit-1", "전유", 84.95, "아파트"),
        row("checkpoint-unit-1", "공용", 27.9, "벽체"),
        row("checkpoint-unit-2", "전유", 84.95, "아파트"),
      ], 101);
    }
    return successResponse([row("checkpoint-unit-2", "공용", 26.77, "계단실")], 101);
  };

  try {
    const baseUrl = requestUrl("checkpoint-complex", { expectedHouseholds: 2 });
    const first = await callApi(baseUrl);
    assert.equal(first.payload.completedPages, 1);

    const failed = await callApi(baseUrl);
    assert.equal(failed.response.status, 502);
    assert.equal(failed.payload.status, "failed");
    assert.equal(failed.payload.completedPages, 1);
    assert.equal(failed.payload.failedPage, 2);
    assert.equal(failed.payload.errorDetails.pageNo, 2);
    assert.equal(failed.payload.errorDetails.attempts, 4);
    assert.equal(failed.payload.errorDetails.upstreamStatus, 500);
    assert.equal(failed.payload.errorDetails.resultMessage, "두 번째 페이지 임시 장애");

    allowSecondPage = true;
    const resumed = await callApi(`${baseUrl}&retry=1`);
    assert.equal(resumed.response.status, 200);
    assert.equal(resumed.payload.status, "ready");
    assert.equal(resumed.payload.profile.unitCount, 2);
    assert.equal(resumed.payload.validation.status, "matched");
    assert.deepEqual(requestedPages, [1, 2, 2, 2, 2, 2]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("K-apt 세대수와 수집 세대수 차이를 경고 정보로 반환한다", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.__supplyProfileRecords = new Map();
  globalThis.fetch = async () =>
    successResponse([
      row("mismatch-unit", "전유", 84.95, "아파트"),
      row("mismatch-unit", "공용", 26.77, "계단실"),
    ]);

  try {
    const { response, payload } = await callApi(
      requestUrl("validation-mismatch-complex", { expectedHouseholds: 3 })
    );
    assert.equal(response.status, 200);
    assert.equal(payload.status, "ready");
    assert.equal(payload.validation.status, "mismatch");
    assert.equal(payload.validation.collectedHouseholds, 1);
    assert.equal(payload.validation.expectedHouseholds, 3);
    assert.equal(payload.validation.difference, -2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function requestUrl(complexKey, { expectedHouseholds = 0 } = {}) {
  const url = new URL("http://localhost/api/supply-profile");
  url.searchParams.set("complexKey", complexKey);
  url.searchParams.set("sigunguCd", "11680");
  url.searchParams.set("bjdongCd", "11400");
  url.searchParams.set("platGbCd", "0");
  url.searchParams.set("bun", "0743");
  url.searchParams.set("ji", "0000");
  if (expectedHouseholds) {
    url.searchParams.set("expectedHouseholds", String(expectedHouseholds));
  }
  return url.toString();
}

async function callApi(url) {
  const response = await onRequestGet({
    request: new Request(url),
    env: { MOLIT_SERVICE_KEY: "test" },
  });
  return { response, payload: await response.json() };
}

function successResponse(items, totalCount = items.length) {
  return new Response(
    JSON.stringify({
      response: {
        header: { resultCode: "00", resultMsg: "OK" },
        body: { items: { item: items }, totalCount },
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function errorResponse(status, resultCode, resultMsg) {
  return new Response(
    JSON.stringify({
      response: {
        header: { resultCode, resultMsg },
        body: {},
      },
    }),
    { status, headers: { "content-type": "application/json" } }
  );
}

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
