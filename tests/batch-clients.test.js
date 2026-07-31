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
      purgeRunScope: "seoul-sale-apartment-built-from-2020-households-200",
    }
  );

  assert.equal(calls.length, 3);
  assert.equal(calls[0].params.length, 26);
  assert.equal(calls[0].params[8], "분양");
  assert.equal(calls[0].params[20], "seoul-sale-apartment-v2");
  assert.match(calls[1].sql, /DELETE FROM supply_profile_cache/);
  assert.match(calls[1].sql, /json_each/);
  assert.deepEqual(calls[1].params, [
    "seoul-sale-apartment-v2",
    "seoul-sale-apartment-built-from-2020-households-200",
  ]);
  assert.match(calls[2].sql, /DELETE FROM supply_batch_catalog/);
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
