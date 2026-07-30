import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveBuildingLedgerSources,
  scoreBuildingLedgerRow,
} from "../functions/_shared/building-match.js";
import { buildBuildingHubUrl } from "../functions/_shared/molit.js";

test("대표 지번이 0건이면 같은 법정동에서 단지명으로 다른 지번을 찾는다", async () => {
  const calls = [];
  const requestedSource = source("11650", "10600", "0059", "0010");
  const resolvedSource = source("11650", "10600", "0060", "0001");
  const attachedSource = source("11650", "10600", "0060", "0002");

  const resolution = await resolveBuildingLedgerSources({
    requestedSource,
    metadata: {
      complexName: "오티에르반포",
      roadAddress: "서울특별시 서초구 신반포로 267",
      lotAddress: "서울특별시 서초구 잠원동 59-10",
      approvalDate: "20260605",
      expectedHouseholds: 251,
    },
    fetchPage: async (operation, requested, pageNo) => {
      calls.push({ operation, requested, pageNo });
      if (!requested.bun && operation === "getBrRecapTitleInfo") {
        return page([
          titleRow({
            source: resolvedSource,
            name: "오티에르 반포 아파트",
            roadAddress: "서울특별시 서초구 신반포로 267",
            households: 251,
            approvalDate: "20260605",
          }),
          titleRow({
            source: source("11650", "10600", "0020", "0000"),
            name: "다른반포아파트",
            roadAddress: "서울특별시 서초구 다른로 1",
            households: 500,
            approvalDate: "20200101",
          }),
        ]);
      }
      if (
        operation === "getBrAtchJibunInfo" &&
        requested.bun === resolvedSource.bun
      ) {
        return page([
          {
            ...resolvedSource,
            atchSigunguCd: attachedSource.sigunguCd,
            atchBjdongCd: attachedSource.bjdongCd,
            atchPlatGbCd: attachedSource.platGbCd,
            atchBun: attachedSource.bun,
            atchJi: attachedSource.ji,
          },
        ]);
      }
      return page([]);
    },
  });

  assert.equal(resolution.status, "matched");
  assert.deepEqual(
    resolution.sources.map((item) => `${item.bun}-${item.ji}`),
    ["0060-0001", "0060-0002"]
  );
  assert.equal(resolution.candidates[0].buildingName, "오티에르 반포 아파트");
  assert.ok(
    calls.some(
      (call) =>
        call.operation === "getBrRecapTitleInfo" &&
        !call.requested.bun
    )
  );
});

test("단지명이 일치하면 대표 지번이 달라도 높은 신뢰도로 선택한다", () => {
  const scoring = scoreBuildingLedgerRow(
    titleRow({
      source: source("11740", "10900", "0424", "0001"),
      name: "e편한세상 강동 프레스티지원",
      roadAddress: "서울특별시 강동구 올림픽로78길 37",
      households: 535,
      approvalDate: "20260122",
    }),
    {
      complexName: "이편한세상 강동 프레스티지원",
      roadAddress: "서울특별시 강동구 올림픽로78길 37",
      expectedHouseholds: 535,
      approvalDate: "20260122",
    },
    source("11740", "10900", "0423", "0076")
  );

  assert.ok(scoring.score >= 0.8);
  assert.ok(scoring.reasons.includes("단지명 일치"));
  assert.ok(scoring.reasons.includes("도로명주소 일치"));
});

test("단지명이 다르면 대표 지번이 같아도 동일 단지로 확정하지 않는다", async () => {
  const requestedSource = source("11650", "10600", "0059", "0010");
  const resolution = await resolveBuildingLedgerSources({
    requestedSource,
    metadata: {
      complexName: "오티에르반포",
      roadAddress: "서울특별시 서초구 신반포로 267",
    },
    fetchPage: async (operation, requested) => {
      if (requested.bun && operation === "getBrTitleInfo") {
        return page([
          titleRow({
            source: requestedSource,
            name: "잠원상가",
            roadAddress: "서울특별시 서초구 신반포로 267",
            households: 1,
            approvalDate: "19900101",
          }),
        ]);
      }
      return page([]);
    },
  });

  assert.equal(resolution.status, "not-found");
  assert.deepEqual(resolution.sources, []);
});

test("건축HUB 법정동 탐색 URL에서는 선택항목인 지번을 생략한다", () => {
  const url = buildBuildingHubUrl({
    serviceKey: "test",
    operation: "getBrTitleInfo",
    params: {
      sigunguCd: "11650",
      bjdongCd: "10600",
      pageNo: "1",
      numOfRows: "1000",
    },
  });

  assert.equal(url.searchParams.get("sigunguCd"), "11650");
  assert.equal(url.searchParams.get("bjdongCd"), "10600");
  assert.equal(url.searchParams.has("platGbCd"), false);
  assert.equal(url.searchParams.has("bun"), false);
  assert.equal(url.searchParams.has("ji"), false);
});

function source(sigunguCd, bjdongCd, bun, ji) {
  return { sigunguCd, bjdongCd, platGbCd: "0", bun, ji };
}

function titleRow({ source: rowSource, name, roadAddress, households, approvalDate }) {
  return {
    ...rowSource,
    mgmBldrgstPk: `${rowSource.sigunguCd}-${rowSource.bjdongCd}-${rowSource.bun}-${rowSource.ji}`,
    bldNm: name,
    platPlc: `서울특별시 시험구 시험동 ${Number(rowSource.bun)}-${Number(rowSource.ji)}`,
    newPlatPlc: roadAddress,
    hhldCnt: households,
    useAprDay: approvalDate,
    mainPurpsCdNm: "공동주택",
  };
}

function page(items) {
  return {
    items,
    totalCount: items.length,
    returnedPageSize: 1000,
  };
}
