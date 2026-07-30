import test from "node:test";
import assert from "node:assert/strict";
import {
  attachRtmsMatch,
  buildRecentDealMonths,
  buildPilotCatalogEntry,
  hasExcludedHousingProgram,
  isApartmentType,
  isSaleTenure,
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
    codeSaleNm: "분양",
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
  assert.deepEqual(nonApartment.exclusionReasons, ["unsupported-housing-type"]);
});

test("도시형 생활주택과 임대형 공동주택을 시험 대상에서 제외한다", () => {
  assert.equal(isApartmentType("아파트"), true);
  assert.equal(isApartmentType("주상복합"), true);
  assert.equal(isApartmentType("도시형 생활주택(아파트)"), false);
  assert.equal(isApartmentType("오피스텔"), false);

  assert.equal(isSaleTenure("분양"), true);
  assert.equal(isSaleTenure("분양+임대"), true);
  assert.equal(isSaleTenure("임대"), false);
  assert.equal(
    hasExcludedHousingProgram({
      complexName: "역세권 청년안심주택",
      apartmentType: "아파트",
      saleType: "분양",
    }),
    true
  );
});

test("국토부 아파트 매매 자료를 법정동과 지번 또는 단지명으로 연결한다", () => {
  const entry = {
    eligible: true,
    exclusionReasons: [],
    complexName: "래미안대치팰리스1단지",
    eupmyeondongName: "대치동",
    bun: "0611",
    ji: "0000",
  };
  const matched = attachRtmsMatch(entry, [
    {
      aptNm: "래미안대치팰리스",
      umdNm: "대치동",
      jibun: "611",
      dealYear: "2026",
      dealMonth: "6",
      dealDay: "3",
    },
    {
      aptNm: "다른단지",
      umdNm: "도곡동",
      jibun: "611",
      dealYear: "2026",
      dealMonth: "7",
      dealDay: "1",
    },
  ]);
  assert.equal(matched.eligible, true);
  assert.equal(matched.tradeMatched, true);
  assert.equal(matched.tradeMatchCount, 1);
  assert.equal(matched.tradeMatchMethod, "lot+name");
  assert.equal(matched.lastTradeDate, "20260603");

  const unmatched = attachRtmsMatch(entry, [
    { aptNm: "다른단지", umdNm: "대치동", jibun: "999" },
  ]);
  assert.equal(unmatched.eligible, false);
  assert.deepEqual(unmatched.exclusionReasons, ["no-apartment-sale-trade-match"]);
});

test("검증 기준월부터 최근 24개월을 역순으로 생성한다", () => {
  const months = buildRecentDealMonths(new Date("2026-07-31T00:00:00Z"), 24);
  assert.equal(months.length, 24);
  assert.equal(months[0], "202607");
  assert.equal(months.at(-1), "202408");
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
