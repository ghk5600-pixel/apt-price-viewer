import test from "node:test";
import assert from "node:assert/strict";
import { createD1RestClient } from "../scripts/lib/d1-rest-client.mjs";
import { createMolitBatchClient } from "../scripts/lib/molit-batch-client.mjs";

test("K-apt 법정동 단지 목록을 마지막 페이지까지 수집한다", async () => {
  const requests = [];
  const client = createMolitBatchClient({
    serviceKey: "decoding-key",
    onRequest: (request) => requests.push(request),
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      const pageNo = Number(parsed.searchParams.get("pageNo"));
      return apiResponse({
        items: {
          item: {
            kaptCode: `A${pageNo}`,
            kaptName: `시험 ${pageNo}`,
            bjdCode: "1168010300",
          },
        },
        pageNo,
        numOfRows: 200,
        totalCount: 2,
      });
    },
  });

  const items = await client.fetchAptListForDong("1168010300");
  assert.deepEqual(
    items.map((item) => item.kaptCode),
    ["A1", "A2"]
  );
  assert.equal(requests.length, 2);
  assert.deepEqual(
    requests.map((request) => request.operation),
    ["apt-list", "apt-list"]
  );
});

test("K-apt 서울 시도 단지 목록을 CSV 없이 마지막 페이지까지 수집한다", async () => {
  const requestedUrls = [];
  const client = createMolitBatchClient({
    serviceKey: "decoding-key",
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      requestedUrls.push(parsed);
      const pageNo = Number(parsed.searchParams.get("pageNo"));
      return apiResponse({
        items: {
          item: {
            kaptCode: `S${pageNo}`,
            kaptName: `서울 단지 ${pageNo}`,
            bjdCode: `11${pageNo}`,
          },
        },
        pageNo,
        numOfRows: 1000,
        totalCount: 2,
      });
    },
  });

  const items = await client.fetchAptListForSido("11");
  assert.deepEqual(
    items.map((item) => item.kaptCode),
    ["S1", "S2"]
  );
  assert.equal(requestedUrls.length, 2);
  assert.ok(
    requestedUrls.every((url) =>
      url.pathname.endsWith("/getSidoAptList3")
    )
  );
  assert.deepEqual(
    requestedUrls.map((url) => url.searchParams.get("sidoCode")),
    ["11", "11"]
  );
});

test("K-apt 기본정보의 단일 item을 반환한다", async () => {
  const client = createMolitBatchClient({
    serviceKey: "decoding-key",
    fetchImpl: async () =>
      apiResponse({
        item: {
          kaptCode: "A10000001",
          kaptName: "시험단지",
          kaptUsedate: "20240101",
          kaptdaCnt: "500",
        },
      }),
  });

  const item = await client.fetchAptBasicInfo("A10000001");
  assert.equal(item.kaptName, "시험단지");
  assert.equal(item.kaptdaCnt, "500");
});

test("국토부 아파트 매매 실거래를 마지막 페이지까지 수집한다", async () => {
  const requests = [];
  const client = createMolitBatchClient({
    serviceKey: "decoding-key",
    onRequest: (request) => requests.push(request),
    fetchImpl: async (url) => {
      const pageNo = Number(new URL(url).searchParams.get("pageNo"));
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?>
        <response>
          <header><resultCode>000</resultCode><resultMsg>OK</resultMsg></header>
          <body>
            <items><item>
              <aptNm>시험아파트</aptNm>
              <dealAmount>100,000</dealAmount>
              <dealYear>2026</dealYear><dealMonth>7</dealMonth><dealDay>${pageNo}</dealDay>
              <excluUseAr>84.95</excluUseAr><jibun>12-3</jibun><umdNm>개포동</umdNm>
            </item></items>
            <numOfRows>1</numOfRows><pageNo>${pageNo}</pageNo><totalCount>2</totalCount>
          </body>
        </response>`,
        { status: 200, headers: { "content-type": "application/xml" } }
      );
    },
  });

  const items = await client.fetchRtmsTrades("11680", "202607");
  assert.equal(items.length, 2);
  assert.deepEqual(
    items.map((item) => item.dealDay),
    ["1", "2"]
  );
  assert.deepEqual(
    requests.map((request) => request.operation),
    ["rtms-trade", "rtms-trade"]
  );
});

test("건축HUB 표제부의 주용도와 기타용도를 보존한다", async () => {
  const client = createMolitBatchClient({
    serviceKey: "decoding-key",
    fetchImpl: async () =>
      apiResponse({
        items: {
          item: {
            mgmBldrgstPk: "PK-1",
            bldNm: "힐스테이트 남산",
            mainPurpsCdNm: "공동주택",
            etcPurps: "아파트-소형주택(도시형생활주택)",
          },
        },
        numOfRows: 1000,
        totalCount: 1,
      }),
  });

  const page = await client.fetchBuildingHubPage(
    "getBrTitleInfo",
    {
      sigunguCd: "11140",
      bjdongCd: "13600",
      platGbCd: "0",
      bun: "0035",
      ji: "0000",
    },
    1,
    1000
  );
  assert.equal(page.totalCount, 1);
  assert.equal(page.items[0].mainPurpsCdNm, "공동주택");
  assert.match(page.items[0].etcPurps, /도시형생활주택/);
});

test("Cloudflare D1 REST query에 인증 헤더와 바인딩 값을 전달한다", async () => {
  const calls = [];
  const client = createD1RestClient({
    accountId: "account-id",
    databaseId: "database-id",
    apiToken: "api-token",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({
          success: true,
          result: [{ success: true, results: [{ value: "ok" }] }],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    },
  });

  const result = await client.query("SELECT ?1 AS value", ["ok", 200]);
  assert.equal(result.results[0].value, "ok");
  assert.equal(
    calls[0].url,
    "https://api.cloudflare.com/client/v4/accounts/account-id/d1/database/database-id/query"
  );
  assert.equal(calls[0].init.headers.authorization, "Bearer api-token");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    sql: "SELECT ?1 AS value",
    params: ["ok", "200"],
  });
});

test("Cloudflare D1 오류 메시지를 실행 로그에 노출한다", async () => {
  const client = createD1RestClient({
    accountId: "account-id",
    databaseId: "database-id",
    apiToken: "api-token",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          success: false,
          errors: [{ code: 7403, message: "D1 permission denied" }],
        }),
        { status: 403, headers: { "content-type": "application/json" } }
      ),
  });

  await assert.rejects(
    () => client.query("SELECT 1"),
    /D1 permission denied/
  );
});

test("Cloudflare D1 연결 오류를 재시도한 뒤 쿼리를 완료한다", async () => {
  let requestCount = 0;
  const delays = [];
  const client = createD1RestClient({
    accountId: "account-id",
    databaseId: "database-id",
    apiToken: "api-token",
    retryDelays: [25],
    sleepImpl: async (delay) => delays.push(delay),
    fetchImpl: async () => {
      requestCount += 1;
      if (requestCount === 1) throw new TypeError("fetch failed");
      return new Response(
        JSON.stringify({
          success: true,
          result: [{ success: true, results: [{ value: "recovered" }] }],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    },
  });

  const result = await client.query("SELECT 1");
  assert.equal(requestCount, 2);
  assert.deepEqual(delays, [25]);
  assert.equal(result.results[0].value, "recovered");
});

test("기존 2020년대 카탈로그를 새 계산 버전으로 이관한다", async () => {
  const calls = [];
  const client = createD1RestClient({
    accountId: "account-id",
    databaseId: "database-id",
    apiToken: "api-token",
    fetchImpl: async (_url, init) => {
      calls.push(JSON.parse(init.body));
      const isCount = /COUNT\(\*\)/.test(calls.at(-1).sql);
      return new Response(
        JSON.stringify({
          success: true,
          result: [
            {
              success: true,
              results: isCount ? [{ count: 26 }] : [],
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    },
  });

  const count = await client.relabelCatalog({
    fromVersion: "legacy-v7",
    toVersion: "decade-v8",
    catalogScope: "seoul-2020",
    approvalDateFrom: "20200101",
    approvalDateTo: "20291231",
  });

  assert.equal(count, 26);
  assert.match(calls[0].sql, /UPDATE supply_batch_catalog/);
  assert.deepEqual(calls[0].params.slice(0, 3), [
    "legacy-v7",
    "decade-v8",
    "seoul-2020",
  ]);
  assert.match(calls[0].sql, /approval_date >= \?5/);
  assert.match(calls[0].sql, /approval_date <= \?6/);
});

test("검증된 매매형 단지만 선정 버전과 함께 D1 카탈로그로 교체한다", async () => {
  const calls = [];
  const client = createD1RestClient({
    accountId: "account-id",
    databaseId: "database-id",
    apiToken: "api-token",
    fetchImpl: async (_url, init) => {
      calls.push(JSON.parse(init.body));
      return new Response(
        JSON.stringify({ success: true, result: [{ success: true, results: [] }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    },
  });

  await client.replaceCatalog(
    [
      {
        complexKey: "aptlist-A1",
        kaptCode: "A1",
        complexName: "시험아파트",
        bjdCode: "1168010300",
        sidoName: "서울특별시",
        sigunguName: "강남구",
        eupmyeondongName: "개포동",
        apartmentType: "아파트",
        saleType: "분양",
        approvalDate: "20260101",
        households: 500,
        buildingCount: 5,
        lotAddress: "서울특별시 강남구 개포동 12-3",
        roadAddress: "서울특별시 강남구 시험로 1",
        platGbCd: "0",
        bun: "0012",
        ji: "0003",
        tradeMatchCount: 3,
        tradeMatchMethod: "lot+name",
        lastTradeDate: "20260701",
        buildingPurpose: "공동주택 / 아파트",
        buildingPurposeVerified: true,
        priorityRank: 1,
        discoveredAt: "2026-07-31T00:00:00.000Z",
      },
    ],
    "seoul-sale-apartment-v2",
    {
      catalogScope: "seoul-sale-apartment-20200101-20291231-households-200",
    }
  );

  assert.equal(calls.length, 3);
  assert.match(calls[0].sql, /SELECT complex_key/);
  assert.deepEqual(calls[0].params, [
    "seoul-sale-apartment-20200101-20291231-households-200",
    "seoul-sale-apartment-v2",
  ]);
  assert.match(calls[1].sql, /DELETE FROM supply_batch_catalog/);
  assert.doesNotMatch(calls[1].sql, /catalog_version <>/);
  assert.equal(calls[2].params.length, 27);
  assert.equal(calls[2].params[8], "분양");
  assert.equal(calls[2].params[20], "seoul-sale-apartment-v2");
  assert.equal(
    calls[2].params[21],
    "seoul-sale-apartment-20200101-20291231-households-200"
  );
});

test("연대별 카탈로그 교체는 해당 범위에서 빠진 공급면적 캐시만 정리한다", async () => {
  const calls = [];
  const client = createD1RestClient({
    accountId: "account-id",
    databaseId: "database-id",
    apiToken: "api-token",
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body);
      calls.push(request);
      const results = /SELECT complex_key/.test(request.sql)
        ? [{ complex_key: "aptlist-old" }, { complex_key: "aptlist-keep" }]
        : [];
      return new Response(
        JSON.stringify({ success: true, result: [{ success: true, results }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    },
  });

  await client.replaceCatalog(
    [
      {
        complexKey: "aptlist-keep",
        kaptCode: "A-KEEP",
        complexName: "유지 단지",
        bjdCode: "1168010300",
        sidoName: "서울특별시",
        sigunguName: "강남구",
        eupmyeondongName: "개포동",
        apartmentType: "아파트",
        saleType: "분양",
        approvalDate: "20150101",
        households: 500,
        buildingCount: 5,
        lotAddress: "서울특별시 강남구 개포동 12-3",
        roadAddress: "",
        platGbCd: "0",
        bun: "0012",
        ji: "0003",
        tradeMatchCount: 1,
        tradeMatchMethod: "name",
        lastTradeDate: "20260701",
        buildingPurpose: "공동주택 / 아파트",
        buildingPurposeVerified: true,
        priorityRank: 1,
        discoveredAt: "2026-07-31T00:00:00.000Z",
      },
    ],
    "seoul-sale-apartment-v8-20100101-20191231",
    {
      catalogScope: "seoul-sale-apartment-20100101-20191231-households-200",
    }
  );

  const catalogDelete = calls.find((call) =>
    /DELETE FROM supply_batch_catalog/.test(call.sql)
  );
  const cacheDelete = calls.find((call) =>
    /DELETE FROM supply_profile_cache/.test(call.sql)
  );
  assert.ok(catalogDelete);
  assert.doesNotMatch(catalogDelete.sql, /catalog_version <>/);
  assert.deepEqual(JSON.parse(cacheDelete.params[0]), ["aptlist-old"]);
});

test("서울 공통 카탈로그를 준공연대 범위로 조회한다", async () => {
  const calls = [];
  const client = createD1RestClient({
    accountId: "account-id",
    databaseId: "database-id",
    apiToken: "api-token",
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body);
      calls.push(request);
      const results = /COUNT\(\*\)/.test(request.sql)
        ? [{ count: 26 }]
        : [{ complex_key: "aptlist-A1", approval_date: "20260101" }];
      return new Response(
        JSON.stringify({ success: true, result: [{ success: true, results }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    },
  });

  const options = {
    approvalDateFrom: "20200101",
    approvalDateTo: "20291231",
  };
  const count = await client.getCatalogCount(
    "seoul-sale-apartment-master-v1",
    options
  );
  const rows = await client.listCatalog(
    "seoul-sale-apartment-master-v1",
    options
  );

  assert.equal(count, 26);
  assert.equal(rows.length, 1);
  for (const call of calls) {
    assert.match(call.sql, /catalog_version = \?1/);
    assert.match(call.sql, /approval_date >= \?2/);
    assert.match(call.sql, /approval_date <= \?3/);
    assert.deepEqual(call.params, [
      "seoul-sale-apartment-master-v1",
      "20200101",
      "20291231",
    ]);
  }
});

test("공통 카탈로그 재생성은 기존 공급면적 프로필을 보존한다", async () => {
  const calls = [];
  const client = createD1RestClient({
    accountId: "account-id",
    databaseId: "database-id",
    apiToken: "api-token",
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body);
      calls.push(request);
      const results = /SELECT complex_key/.test(request.sql)
        ? [{ complex_key: "aptlist-existing" }]
        : [];
      return new Response(
        JSON.stringify({ success: true, result: [{ success: true, results }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    },
  });

  await client.replaceCatalog([], "seoul-sale-apartment-master-v1", {
    catalogScope: "seoul-sale-apartment-master-households-200",
    replaceAll: true,
  });

  assert.match(calls[0].sql, /SELECT complex_key FROM supply_batch_catalog/);
  assert.equal(calls[0].params.length, 0);
  assert.match(calls[1].sql, /^DELETE FROM supply_batch_catalog$/);
  assert.equal(
    calls.some((call) => /DELETE FROM supply_profile_cache/.test(call.sql)),
    false
  );
});

test("permit API rows are collected through the final page", async () => {
  const requests = [];
  const client = createMolitBatchClient({
    serviceKey: "decoding-key",
    onRequest: (request) => requests.push(request),
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      const pageNo = Number(parsed.searchParams.get("pageNo"));
      return apiResponse({
        items: { item: [{ rnum: pageNo, typeGb: `84-${pageNo}` }] },
        pageNo,
        numOfRows: 1,
        totalCount: 2,
      });
    },
  });

  const result = await client.fetchPermitRows(
    "housing-permit",
    "getHpMgmCoopTpOulnInfo",
    {
      sigunguCd: "11740",
      bjdongCd: "10300",
      platGbCd: "0",
      bun: "0187",
      ji: "0000",
    }
  );

  assert.equal(result.totalCount, 2);
  assert.equal(result.pageCount, 2);
  assert.deepEqual(result.items.map((item) => item.rnum), [1, 2]);
  assert.deepEqual(requests.map((request) => request.pageNo), [1, 2]);
});

test("permit API errors preserve the operation and page", async () => {
  const client = createMolitBatchClient({
    serviceKey: "decoding-key",
    fetchImpl: async () => {
      const error = new TypeError("fetch failed");
      error.retryable = false;
      throw error;
    },
  });

  await assert.rejects(
    () =>
      client.fetchPermitRows(
        "housing-permit",
        "getHpMgmCoopTpOulnInfo",
        {
          sigunguCd: "11215",
          bjdongCd: "10500",
          platGbCd: "0",
          bun: "0695",
          ji: "0000",
        }
      ),
    (error) => {
      assert.equal(error.details.operation, "getHpMgmCoopTpOulnInfo");
      assert.equal(error.details.pageNo, 1);
      assert.equal(error.details.resultMessage, "fetch failed");
      return true;
    }
  );
});

test("master catalog statuses are synchronized and undated rows are finalized", async () => {
  const calls = [];
  const client = createD1RestClient({
    accountId: "account-id",
    databaseId: "database-id",
    apiToken: "api-token",
    fetchImpl: async (_url, init) => {
      calls.push(JSON.parse(init.body));
      return new Response(
        JSON.stringify({ success: true, result: [{ success: true, results: [] }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    },
  });

  await client.syncCatalogProfileStatuses("seoul-sale-apartment-master-v1");
  await client.finalizeUndatedCatalog("seoul-sale-apartment-master-v1");

  assert.match(calls[0].sql, /UPDATE supply_batch_catalog/);
  assert.match(calls[0].sql, /supply_profile_cache/);
  assert.equal(calls[0].params[0], "seoul-sale-apartment-master-v1");
  assert.match(calls[1].sql, /APPROVAL_DATE_MISSING_OR_INVALID/);
  assert.deepEqual(calls[1].params.slice(0, 4), [
    "seoul-sale-apartment-master-v1",
    "supply-model-v7-permit-type-weighted",
    "19000101",
    "20991231",
  ]);
});

function apiResponse(body) {
  return new Response(
    JSON.stringify({
      response: {
        header: { resultCode: "00", resultMsg: "OK" },
        body,
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}
