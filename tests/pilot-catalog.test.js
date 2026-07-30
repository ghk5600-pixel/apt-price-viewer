import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPilotCatalogEntry,
  isApartmentType,
  parseCsv,
  parseLotAddress,
  selectSeoulLegalDongs,
  sortPilotCatalog,
} from "../scripts/lib/pilot-catalog.mjs";

test("법정동 CSV의 BOM과 따옴표 필드를 읽고 서울의 10자리 동 코드만 선택한다", () => {
  const records = parseCsv(
    "\uFEFF법정동코드,시도명,시군구명,읍면동명,리명,순위,생성일자\r\n" +
      '1168010300,서울특별시,강남구,"개포동",,1,20260630\r\n' +
      "1100000000,서울특별시,,,,1,20260630\r\n" +
      "4113510900,경기도,성남시 분당구,삼평동,,1,20260630\r\n"
  );

  assert.deepEqual(selectSeoulLegalDongs(records), [
    {
      bjdCode: "1168010300",
      sidoName: "서울특별시",
      sigunguName: "강남구",
      eupmyeondongName: "개포동",
    },
  ]);
});

test("2020년 이후 200세대 이상 아파트와 주상복합을 시험 대상에 포함한다", () => {
  const candidate = {
    kaptCode: "A10000001",
    kaptName: "시험단지",
    bjdCode: "1168010300",
    as1: "서울특별시",
    as2: "강남구",
    as3: "개포동",
  };
  const base = {
    ...candidate,
    kaptUsedate: "20200101",
    kaptdaCnt: "200",
    kaptDongCnt: "2",
    codeAptNm: "주상복합",
    kaptAddr: "서울특별시 강남구 개포동 12-3",
    doroJuso: "서울특별시 강남구 시험로 1",
  };

  const included = buildPilotCatalogEntry(candidate, base, "2026-07-30T00:00:00.000Z");
  assert.equal(included.eligible, true);
  assert.equal(included.platGbCd, "0");
  assert.equal(included.bun, "0012");
  assert.equal(included.ji, "0003");
  assert.equal(included.households, 200);

  const old = buildPilotCatalogEntry(candidate, { ...base, kaptUsedate: "20191231" });
  assert.deepEqual(old.exclusionReasons, ["built-before-2020"]);

  const small = buildPilotCatalogEntry(candidate, { ...base, kaptdaCnt: "199" });
  assert.deepEqual(small.exclusionReasons, ["under-200-households"]);

  const nonApartment = buildPilotCatalogEntry(candidate, {
    ...base,
    codeAptNm: "오피스텔",
  });
  assert.deepEqual(nonApartment.exclusionReasons, ["non-apartment"]);
});

test("일반 지번과 산 지번을 건축HUB 요청 형식으로 변환한다", () => {
  assert.deepEqual(parseLotAddress("서울특별시 강남구 개포동 1281", "개포동"), {
    platGbCd: "0",
    bun: "1281",
    ji: "0000",
  });
  assert.deepEqual(parseLotAddress("서울특별시 종로구 평창동 산 6-12", "평창동"), {
    platGbCd: "1",
    bun: "0006",
    ji: "0012",
  });
  assert.equal(parseLotAddress("서울특별시 강남구 개포동", "개포동"), null);
});

test("최신 준공일, 세대수, K-apt 코드 순서로 우선순위를 정한다", () => {
  const sorted = sortPilotCatalog([
    { approvalDate: "20220101", households: 300, kaptCode: "C" },
    { approvalDate: "20230101", households: 200, kaptCode: "B" },
    { approvalDate: "20230101", households: 500, kaptCode: "A" },
  ]);
  assert.deepEqual(
    sorted.map((item) => [item.kaptCode, item.priorityRank]),
    [
      ["A", 1],
      ["B", 2],
      ["C", 3],
    ]
  );
});

test("혼합 건물 중 주상복합은 포함하고 비주거 시설은 제외한다", () => {
  assert.equal(isApartmentType("아파트"), true);
  assert.equal(isApartmentType("주상복합"), true);
  assert.equal(isApartmentType("도시형 생활주택(아파트)"), true);
  assert.equal(isApartmentType("오피스텔"), false);
  assert.equal(isApartmentType("상가"), false);
});
