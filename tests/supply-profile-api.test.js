import test from "node:test";
import assert from "node:assert/strict";
import { onRequestGet } from "../functions/api/supply-profile.js";

test("1000행 페이지를 우선 선택하고 한 페이지씩 순차 저장한다", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.__supplyProfileRecords = new Map();
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    if (!isAreaRequest(parsed)) return discoveryResponse();
    const pageNo = Number(parsed.searchParams.get("pageNo"));
    const numOfRows = Number(parsed.searchParams.get("numOfRows"));
    requests.push({ pageNo, numOfRows });
    const items =
      pageNo === 1
        ? [
            row("unit-api-1", "전유", 84.95, "아파트"),
            row("unit-api-1", "공용", 27.9, "벽체"),
            row("unit-api-2", "전유", 84.95, "아파트"),
          ]
        : [row("unit-api-2", "공용", 26.77, "계단실")];
    return successResponse(items, 1001, numOfRows);
  };

  try {
    const url = requestUrl("sequential-1000-complex", { expectedHouseholds: 2 });
    const first = await callApi(url);
    assert.equal(first.response.status, 202);
    assert.equal(first.payload.status, "building");
    assert.equal(first.payload.pageSize, 1000);
    assert.equal(first.payload.totalPages, 2);
    assert.equal(first.payload.completedPages, 1);
    assert.deepEqual(requests, [{ pageNo: 1, numOfRows: 1000 }]);

    const second = await callApi(url);
    assert.equal(second.response.status, 200);
    assert.equal(second.payload.status, "ready");
    assert.equal(second.payload.profile.unitCount, 2);
    assert.equal(second.payload.profile.groups[0].id, "84");
    assert.equal(second.payload.profile.collection.pageSize, 1000);
    assert.equal(second.payload.validation.status, "matched");
    assert.deepEqual(requests, [
      { pageNo: 1, numOfRows: 1000 },
      { pageNo: 2, numOfRows: 1000 },
    ]);

    const cached = await callApi(url);
    assert.equal(cached.payload.status, "ready");
    assert.equal(cached.payload.profile.collection.pageSize, 1000);
    assert.equal(requests.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("1000행 요청이 실패하면 500행으로 자동 하향한다", async () => {
  const originalFetch = globalThis.fetch;
  const requestedSizes = [];
  globalThis.__supplyProfileRecords = new Map();
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    if (!isAreaRequest(parsed)) return discoveryResponse();
    const numOfRows = Number(parsed.searchParams.get("numOfRows"));
    requestedSizes.push(numOfRows);
    if (numOfRows === 1000) {
      return errorResponse(500, "99", "큰 페이지 요청 처리 실패");
    }
    return successResponse([
      row("fallback-unit", "전유", 84.95, "아파트"),
      row("fallback-unit", "공용", 26.77, "계단실"),
    ], 2, numOfRows);
  };

  try {
    const { response, payload } = await callApi(
      requestUrl("page-size-fallback-complex", { expectedHouseholds: 1 })
    );
    assert.equal(response.status, 200);
    assert.equal(payload.status, "ready");
    assert.equal(payload.profile.collection.pageSize, 500);
    assert.deepEqual(requestedSizes, [1000, 500]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("HTTP 500을 장기 대기로 저장하고 F5 상황에서도 실패 페이지부터 자동 재개한다", async () => {
  const originalFetch = globalThis.fetch;
  const requestedPages = [];
  let allowSecondPage = false;
  globalThis.__supplyProfileRecords = new Map();
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    if (!isAreaRequest(parsed)) return discoveryResponse();
    const pageNo = Number(parsed.searchParams.get("pageNo"));
    const numOfRows = Number(parsed.searchParams.get("numOfRows"));
    requestedPages.push(pageNo);
    if (pageNo === 2 && !allowSecondPage) {
      return errorResponse(500, "99", "두 번째 페이지 임시 장애");
    }
    if (pageNo === 1) {
      return successResponse([
        row("resume-unit-1", "전유", 84.95, "아파트"),
        row("resume-unit-1", "공용", 27.9, "벽체"),
        row("resume-unit-2", "전유", 84.95, "아파트"),
      ], 1001, numOfRows);
    }
    return successResponse([row("resume-unit-2", "공용", 26.77, "계단실")], 1001, numOfRows);
  };

  try {
    const url = requestUrl("automatic-resume-complex", { expectedHouseholds: 2 });
    const first = await callApi(url);
    assert.equal(first.payload.completedPages, 1);

    const paused = await callApi(url);
    assert.equal(paused.response.status, 202);
    assert.equal(paused.payload.status, "paused");
    assert.equal(paused.payload.completedPages, 1);
    assert.equal(paused.payload.failedPage, 2);
    assert.equal(paused.payload.errorDetails.upstreamStatus, 500);
    assert.ok(paused.payload.retryAfterMs >= 4_000);

    const waiting = await callApi(url);
    assert.equal(waiting.payload.status, "paused");
    assert.deepEqual(requestedPages, [1, 2]);

    const storedRecord = globalThis.__supplyProfileRecords.get("automatic-resume-complex");
    storedRecord.nextRetryAt = new Date(Date.now() - 1_000).toISOString();
    allowSecondPage = true;

    const resumed = await callApi(url);
    assert.equal(resumed.response.status, 200);
    assert.equal(resumed.payload.status, "ready");
    assert.equal(resumed.payload.profile.unitCount, 2);
    assert.equal(resumed.payload.validation.status, "matched");
    assert.deepEqual(requestedPages, [1, 2, 2]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("같은 페이지가 반복 실패하면 처리 위치를 유지하고 페이지 크기를 낮춘다", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.__supplyProfileRecords = new Map();
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    if (!isAreaRequest(parsed)) return discoveryResponse();
    const pageNo = Number(parsed.searchParams.get("pageNo"));
    const numOfRows = Number(parsed.searchParams.get("numOfRows"));
    requests.push({ pageNo, numOfRows });
    if (pageNo === 1) {
      return successResponse([
        row("downgrade-unit-1", "전유", 84.95, "아파트"),
        row("downgrade-unit-1", "공용", 27.9, "벽체"),
        row("downgrade-unit-2", "전유", 84.95, "아파트"),
      ], 2001, numOfRows);
    }
    return errorResponse(500, "99", "큰 페이지 반복 장애");
  };

  try {
    const url = requestUrl("page-size-downgrade-complex");
    await callApi(url);

    for (let failure = 0; failure < 3; failure += 1) {
      const result = await callApi(url);
      assert.equal(result.payload.status, "paused");
      if (failure < 2) {
        const record = globalThis.__supplyProfileRecords.get("page-size-downgrade-complex");
        record.nextRetryAt = new Date(Date.now() - 1_000).toISOString();
      } else {
        assert.equal(result.payload.pageSize, 500);
        assert.equal(result.payload.currentPage, 3);
        assert.equal(result.payload.totalPages, 5);
        assert.equal(result.payload.errorDetails.pageSizeDowngradedFrom, 1000);
        assert.equal(result.payload.errorDetails.pageSizeDowngradedTo, 500);
      }
    }

    assert.deepEqual(requests, [
      { pageNo: 1, numOfRows: 1000 },
      { pageNo: 2, numOfRows: 1000 },
      { pageNo: 2, numOfRows: 1000 },
      { pageNo: 2, numOfRows: 1000 },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("K-apt 세대수와 수집 세대수가 다르면 결과 저장을 차단한다", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.__supplyProfileRecords = new Map();
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    if (!isAreaRequest(parsed)) return discoveryResponse();
    const numOfRows = Number(parsed.searchParams.get("numOfRows"));
    return successResponse([
      row("mismatch-unit", "전유", 84.95, "아파트"),
      row("mismatch-unit", "공용", 26.77, "계단실"),
    ], 2, numOfRows);
  };

  try {
    const { response, payload } = await callApi(
      requestUrl("validation-mismatch-complex", { expectedHouseholds: 3 })
    );
    assert.equal(response.status, 502);
    assert.equal(payload.status, "failed");
    assert.equal(payload.errorDetails.resultCode, "HOUSEHOLD_COUNT_MISMATCH");
    assert.match(payload.errorDetails.resultMessage, /K-apt 3세대/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("주상복합에서는 표제부의 아파트 건물과 연결된 아파트 전유부만 집계한다", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.__supplyProfileRecords = new Map();
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    const operation = parsed.pathname.split("/").pop();
    const numOfRows = Number(parsed.searchParams.get("numOfRows"));

    if (operation === "getBrRecapTitleInfo") {
      return successResponse(
        [
          {
            mgmBldrgstPk: "mixed-recap",
            sigunguCd: "11680",
            bjdongCd: "11400",
            platGbCd: "0",
            bun: "0743",
            ji: "0000",
            bldNm: "서초센트럴아이파크",
            newPlatPlc: "서울특별시 강남구 시험로 10",
            hhldCnt: 1,
            mainPurpsCdNm: "공동주택",
            etcPurps: "아파트, 오피스텔, 업무시설",
          },
        ],
        1,
        numOfRows
      );
    }
    if (operation === "getBrTitleInfo") {
      return successResponse(
        [
          {
            mgmBldrgstPk: "apartment-title-pk",
            sigunguCd: "11680",
            bjdongCd: "11400",
            platGbCd: "0",
            bun: "0743",
            ji: "0000",
            bldNm: "서초센트럴아이파크 101동",
            dongNm: "101동",
            newPlatPlc: "서울특별시 강남구 시험로 10",
            mainPurpsCdNm: "공동주택",
            etcPurps: "아파트",
          },
          {
            mgmBldrgstPk: "officetel-title-pk",
            sigunguCd: "11680",
            bjdongCd: "11400",
            platGbCd: "0",
            bun: "0743",
            ji: "0000",
            bldNm: "서초센트럴아이파크 업무동",
            dongNm: "업무동",
            newPlatPlc: "서울특별시 강남구 시험로 10",
            mainPurpsCdNm: "업무시설",
            etcPurps: "오피스텔",
          },
        ],
        2,
        numOfRows
      );
    }
    if (!isAreaRequest(parsed)) return successResponse([], 0, numOfRows);

    return successResponse(
      [
        {
          ...row("apartment-unit-pk", "전유", 84.95, "아파트"),
          bldNm: "서초센트럴아이파크 101동",
          dongNm: "101동",
        },
        {
          ...row("apartment-unit-pk", "공용", 26.77, "계단실"),
          bldNm: "서초센트럴아이파크 101동",
          dongNm: "101동",
        },
        {
          ...row("officetel-unit-pk", "전유", 59.9, "오피스텔"),
          bldNm: "서초센트럴아이파크 업무동",
          dongNm: "업무동",
        },
        {
          ...row("officetel-unit-pk", "공용", 15.1, "계단실"),
          bldNm: "서초센트럴아이파크 업무동",
          dongNm: "업무동",
        },
      ],
      4,
      numOfRows
    );
  };

  try {
    const { response, payload } = await callApi(
      requestUrl("mixed-use-complex", {
        expectedHouseholds: 1,
        complexName: "서초센트럴아이파크",
        roadAddress: "서울특별시 강남구 시험로 10",
      })
    );
    assert.equal(response.status, 200);
    assert.equal(payload.status, "ready");
    assert.deepEqual(payload.profile.source.managementPks, [
      "apartment-title-pk",
    ]);
    assert.equal(payload.profile.unitCount, 1);
    assert.equal(payload.profile.filteredRows, 2);
    assert.equal(payload.validation.status, "matched");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("대표 지번 조회가 0건이어도 같은 법정동의 동일 단지명 지번으로 공급면적을 수집한다", async () => {
  const originalFetch = globalThis.fetch;
  const areaLots = [];
  globalThis.__supplyProfileRecords = new Map();
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    const operation = parsed.pathname.split("/").pop();
    const bun = parsed.searchParams.get("bun") || "";
    const ji = parsed.searchParams.get("ji") || "";
    const numOfRows = Number(parsed.searchParams.get("numOfRows"));

    if (operation === "getBrRecapTitleInfo" && !bun) {
      return successResponse(
        [
          {
            mgmBldrgstPk: "matched-title",
            sigunguCd: "11680",
            bjdongCd: "11400",
            platGbCd: "0",
            bun: "0744",
            ji: "0001",
            bldNm: "테스트래미안",
            newPlatPlc: "서울특별시 강남구 시험로 10",
            hhldCnt: 1,
            useAprDay: "20250101",
            mainPurpsCdNm: "공동주택",
          },
        ],
        1,
        numOfRows
      );
    }
    if (!isAreaRequest(parsed)) return successResponse([], 0, numOfRows);

    areaLots.push(`${bun}-${ji}`);
    return successResponse(
      [
        row("alternate-lot-unit", "전유", 84.95, "아파트"),
        row("alternate-lot-unit", "공용", 26.77, "계단실"),
      ],
      2,
      numOfRows
    );
  };

  try {
    const { response, payload } = await callApi(
      requestUrl("alternate-lot-complex", {
        expectedHouseholds: 1,
        complexName: "테스트래미안",
        roadAddress: "서울특별시 강남구 시험로 10",
        approvalDate: "20250101",
      })
    );
    assert.equal(response.status, 200);
    assert.equal(payload.status, "ready");
    assert.deepEqual(areaLots, ["0744-0001"]);
    assert.equal(payload.profile.source.resolved[0].bun, "0744");
    assert.equal(payload.validation.status, "matched");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("D1 준비값은 국토부 인증키 없이도 모든 사용자에게 즉시 반환한다", async () => {
  const originalFetch = globalThis.fetch;
  let areaRequestCount = 0;
  globalThis.__supplyProfileRecords = new Map();
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    if (!isAreaRequest(parsed)) return discoveryResponse();
    areaRequestCount += 1;
    return successResponse([
      row("shared-cache-unit", "전유", 84.95, "아파트"),
      row("shared-cache-unit", "공용", 26.77, "계단실"),
    ]);
  };

  try {
    const url = requestUrl("shared-ready-complex", { expectedHouseholds: 1 });
    const calculated = await callApi(url);
    assert.equal(calculated.payload.status, "ready");
    assert.equal(calculated.payload.cacheHit, false);

    const response = await onRequestGet({
      request: new Request(url),
      env: {},
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.status, "ready");
    assert.equal(payload.cacheHit, true);
    assert.equal(payload.profile.unitCount, 1);
    assert.equal(areaRequestCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("건축물대장 매칭 실패 때만 주택인허가에서 대체 지번을 찾아 다시 검증한다", async () => {
  const originalFetch = globalThis.fetch;
  const permitRequests = [];
  const areaLots = [];
  globalThis.__supplyProfileRecords = new Map();
  globalThis.fetch = async (url) => {
    const parsed = new URL(url);
    const operation = parsed.pathname.split("/").pop();
    const bun = parsed.searchParams.get("bun") || "";
    const ji = parsed.searchParams.get("ji") || "";
    const numOfRows = Number(parsed.searchParams.get("numOfRows")) || 1000;

    if (operation === "getHpBasisOulnInfo") {
      permitRequests.push(operation);
      return successResponse(
        [
          {
            sigunguCd: "11680",
            bjdongCd: "11400",
            platGbCd: "0",
            bun: "0744",
            ji: "0001",
            bldNm: "허가대체아파트",
            hhldCnt: 1,
            useAprDay: "20250101",
            mainPurpsCdNm: "공동주택",
            etcPurps: "아파트",
          },
        ],
        1,
        numOfRows
      );
    }
    if (operation === "getApBasisOulnInfo") {
      permitRequests.push(operation);
      return successResponse([], 0, numOfRows);
    }
    if (
      ["getBrRecapTitleInfo", "getBrTitleInfo"].includes(operation) &&
      bun === "0744" &&
      ji === "0001"
    ) {
      return successResponse(
        [
          {
            mgmBldrgstPk: "permit-fallback-title",
            sigunguCd: "11680",
            bjdongCd: "11400",
            platGbCd: "0",
            bun: "0744",
            ji: "0001",
            bldNm: "허가대체아파트 101동",
            dongNm: "101동",
            newPlatPlc: "서울특별시 강남구 허가로 10",
            useAprDay: "20250101",
            hhldCnt: 1,
            mainPurpsCdNm: "공동주택",
            etcPurps: "아파트",
          },
        ],
        1,
        numOfRows
      );
    }
    if (operation === "getBrExposPubuseAreaInfo") {
      areaLots.push(`${bun}-${ji}`);
      return successResponse(
        [
          row("permit-fallback-unit", "전유", 84.95, "아파트"),
          row("permit-fallback-unit", "공용", 26.77, "계단실"),
        ],
        2,
        numOfRows
      );
    }
    return successResponse([], 0, numOfRows);
  };

  try {
    const { response, payload } = await callApi(
      requestUrl("permit-lot-fallback-complex", {
        expectedHouseholds: 1,
        complexName: "허가대체아파트",
        roadAddress: "서울특별시 강남구 허가로 10",
        approvalDate: "20250101",
      })
    );
    assert.equal(response.status, 200);
    assert.equal(payload.status, "ready");
    assert.deepEqual(permitRequests, ["getHpBasisOulnInfo"]);
    assert.deepEqual(areaLots, ["0744-0001"]);
    assert.equal(
      payload.profile.source.fallbackRequested.bun,
      "0744"
    );
    assert.equal(
      payload.profile.ledgerMatch.sourceDiscovery.strategy,
      "building-ledger-primary-permit-lot-fallback"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function requestUrl(
  complexKey,
  {
    expectedHouseholds = 0,
    complexName = "",
    roadAddress = "",
    approvalDate = "",
  } = {}
) {
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
  if (complexName) url.searchParams.set("complexName", complexName);
  if (roadAddress) url.searchParams.set("roadAddress", roadAddress);
  if (approvalDate) url.searchParams.set("approvalDate", approvalDate);
  return url.toString();
}

async function callApi(url) {
  const response = await onRequestGet({
    request: new Request(url),
    env: { MOLIT_SERVICE_KEY: "test" },
  });
  return { response, payload: await response.json() };
}

function successResponse(items, totalCount = items.length, numOfRows = 1000) {
  return new Response(
    JSON.stringify({
      response: {
        header: { resultCode: "00", resultMsg: "OK" },
        body: { items: { item: items }, totalCount, numOfRows },
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

function discoveryResponse() {
  return successResponse(
    [
      {
        mgmBldrgstPk: "title-test",
        sigunguCd: "11680",
        bjdongCd: "11400",
        platGbCd: "0",
        bun: "0743",
        ji: "0000",
        bldNm: "시험단지",
        mainPurpsCdNm: "공동주택",
      },
    ],
    1,
    1000
  );
}

function isAreaRequest(url) {
  return url.pathname.endsWith("/getBrExposPubuseAreaInfo");
}

function row(key, useType, area, purpose) {
  return {
    mgmBldrgstPk: key,
    exposPubuseGbCdNm: useType,
    area,
    mainPurpsCdNm: purpose,
    etcPurps: "",
    dongNm: "101동",
    hoNm: key,
  };
}
