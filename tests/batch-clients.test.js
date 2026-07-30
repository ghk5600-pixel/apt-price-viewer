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
