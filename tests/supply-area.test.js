import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSupplyProfile,
  calculateWeightedSupplyPpy,
  consumeBuildingAreaRows,
  createCollectionState,
  findSupplyGroup,
  isApartmentExclusivePurpose,
  isResidentialCommonPurpose,
  matchesApartmentComponent,
} from "../functions/_shared/supply-area.js";

test("주거공용과 기타공용 용도를 구분한다", () => {
  assert.equal(isResidentialCommonPurpose("벽체"), true);
  assert.equal(isResidentialCommonPurpose("부대시설 계단실통로"), true);
  assert.equal(isResidentialCommonPurpose("대피소 지층대피소"), true);
  assert.equal(isResidentialCommonPurpose("지하주차장"), false);
  assert.equal(isResidentialCommonPurpose("커뮤니티 로비"), false);
});

test("아파트 전유면적만 포함하고 도시형 생활주택과 오피스텔은 제외한다", () => {
  assert.equal(isApartmentExclusivePurpose("공동주택 아파트"), true);
  assert.equal(isApartmentExclusivePurpose("공동주택"), true);
  assert.equal(
    isApartmentExclusivePurpose("공동주택 아파트-도시형생활주택"),
    false
  );
  assert.equal(isApartmentExclusivePurpose("업무시설 오피스텔"), false);
});

test("표제부와 전유부 PK가 달라도 선택한 아파트 건물의 면적만 집계한다", () => {
  const apartmentRows = [
    {
      ...row("apartment-unit-pk", "전유", 84.9, "공동주택", "아파트", "101동"),
      bldNm: "서초센트럴아이파크 101동",
    },
    {
      ...row("apartment-unit-pk", "공용", 25.1, "", "계단실", "101동"),
      bldNm: "서초센트럴아이파크 101동",
    },
  ];
  const officetelRows = [
    {
      ...row("officetel-unit-pk", "전유", 59.9, "업무시설", "오피스텔", "업무동"),
      bldNm: "서초센트럴아이파크 업무동",
    },
    {
      ...row("officetel-unit-pk", "공용", 15.1, "", "계단실", "업무동"),
      bldNm: "서초센트럴아이파크 업무동",
    },
  ];
  const rows = [...apartmentRows, ...officetelRows];
  const state = consumeBuildingAreaRows(createCollectionState(), rows, {
    isFinal: true,
    apartmentComponents: [
      {
        managementPk: "apartment-title-pk",
        buildingName: "서초센트럴아이파크 101동",
        dongName: "101동",
      },
    ],
  });
  const profile = buildSupplyProfile({
    complexKey: "mixed-complex",
    source: {},
    collectionState: state,
  });

  assert.equal(profile.unitCount, 1);
  assert.equal(profile.sourceRows, rows.length);
  assert.equal(profile.filteredRows, officetelRows.length);
  assert.equal(profile.groups[0].label, "84타입");
});

test("선택한 아파트 동과 다른 아파트 건물은 구성요소 필터에서 제외한다", () => {
  const selected = [
    {
      managementPk: "title-101",
      buildingName: "테스트아파트 101동",
      dongName: "101동",
    },
  ];
  assert.equal(
    matchesApartmentComponent(
      [{ bldNm: "테스트아파트 101동", dongNm: "101동" }],
      selected
    ),
    true
  );
  assert.equal(
    matchesApartmentComponent(
      [{ bldNm: "다른아파트 201동", dongNm: "201동" }],
      selected
    ),
    false
  );
});

test("페이지 경계를 넘는 세대 행을 한 세대로 합친다", () => {
  let state = createCollectionState();
  state = consumeBuildingAreaRows(state, [
    row("unit-1", "전유", 84.95, "아파트", "", "101동"),
    row("unit-1", "공용", 20, "벽체", "", "101동"),
  ]);
  assert.equal(state.processedUnits, 0);

  state = consumeBuildingAreaRows(
    state,
    [
      row("unit-1", "공용", 7.9, "계단실", "", "101동"),
      row("unit-1", "공용", 30, "주차장", "지하주차장", "101동"),
      row("unit-2", "전유", 84.95, "아파트", "", "102동"),
      row("unit-2", "공용", 26.77, "벽체", "", "102동"),
    ],
    { isFinal: true }
  );

  assert.equal(state.processedUnits, 2);
  assert.equal(state.patterns.length, 2);
  assert.equal(state.patterns[0].supplyArea, 112.85);
  assert.equal(state.patterns[1].supplyArea, 111.72);
});

test("84타입 공급평당가를 공급면적별 세대수로 가중한다", () => {
  const profile = buildSupplyProfile({
    complexKey: "test-complex",
    source: {},
    collectionState: {
      patterns: [
        pattern("101동", 84.95, 111.72, 3),
        pattern("102동", 84.95, 112.85, 7),
      ],
      processedRows: 20,
      processedUnits: 10,
      skippedUnits: 0,
      carryRows: [],
      warnings: [],
    },
  });
  const group = findSupplyGroup(profile, 84.99);
  const expected =
    (3 / 10) * (100000 / (111.72 / 3.305785)) +
    (7 / 10) * (100000 / (112.85 / 3.305785));

  assert.equal(group.id, "84");
  assert.equal(group.unitCount, 10);
  assert.ok(Math.abs(calculateWeightedSupplyPpy(100000, group) - expected) < 0.01);
  assert.notEqual(
    calculateWeightedSupplyPpy(100000, group),
    100000 / (group.representativeSupplyArea / 3.305785)
  );
});

test("대형 비표준 면적은 단지별 인접 범위로 묶는다", () => {
  const profile = buildSupplyProfile({
    complexKey: "mixed-large-complex",
    source: {},
    collectionState: {
      patterns: [
        pattern("101동", 110.12, 140, 10),
        pattern("102동", 110.87, 141, 10),
        pattern("103동", 111.03, 142, 10),
        pattern("104동", 113.1, 145, 10),
        pattern("105동", 115.02, 148, 10),
      ],
      processedRows: 50,
      processedUnits: 50,
      skippedUnits: 0,
      carryRows: [],
      warnings: [],
    },
  });

  assert.deepEqual(
    profile.groups.map((group) => group.label),
    ["110·111타입", "113타입", "115타입"]
  );
});

test("동 정보가 있으면 해당 동의 공급면적 가중치를 우선한다", () => {
  const profile = buildSupplyProfile({
    complexKey: "dong-weight-complex",
    source: {},
    collectionState: {
      patterns: [
        pattern("101동", 84.95, 111.72, 5),
        pattern("102동", 84.95, 112.85, 5),
      ],
      processedRows: 20,
      processedUnits: 10,
      skippedUnits: 0,
      carryRows: [],
      warnings: [],
    },
  });
  const group = profile.groups[0];
  const result = calculateWeightedSupplyPpy(100000, group, "101동");
  const expected = 100000 / (111.72 / 3.305785);
  assert.ok(Math.abs(result - expected) < 0.01);
});

test("여러 지번에서 같은 건축물대장 관리번호가 반복되어도 한 세대로 집계한다", () => {
  const duplicateRows = [
    row("duplicate-unit", "전유", 84.95, "아파트", "", "101동"),
    row("duplicate-unit", "공용", 26.77, "", "계단실", "101동"),
  ];
  let state = createCollectionState();
  state = consumeBuildingAreaRows(state, duplicateRows, { isFinal: true });
  state = consumeBuildingAreaRows(state, duplicateRows, { isFinal: true });

  const profile = buildSupplyProfile({
    complexKey: "multi-lot-dedup-complex",
    source: {},
    collectionState: state,
  });

  assert.equal(profile.unitCount, 1);
  assert.equal(profile.groups[0].unitCount, 1);
});

test("collection checkpoints keep unit identifiers and patterns compact", () => {
  const rows = [];
  for (let index = 0; index < 3000; index += 1) {
    const unitKey = `11680-10000-${String(index).padStart(10, "0")}`;
    rows.push(
      row(unitKey, "전유", 84.95, "아파트", "", "101동"),
      row(unitKey, "공용", 26.77, "", "계단실", "101동")
    );
  }

  const state = consumeBuildingAreaRows(createCollectionState(), rows, { isFinal: true });

  assert.equal(state.processedUnits, 3000);
  assert.equal(state.seenUnitHashes.length, 3000);
  assert.equal(state.patterns.length, 1);
  assert.equal("components" in state.patterns[0], false);
  assert.ok(state.patterns[0].key.length < 20);
  assert.ok(JSON.stringify(state).length < 100000);
});

test("the same building-register PK is separated by dong and unit number", () => {
  const rows = [
    { ...row("building-pk", "전유", 84.95, "아파트", "", "101동"), hoNm: "101호" },
    { ...row("building-pk", "공용", 26.77, "", "계단실", "101동"), hoNm: "101호" },
    { ...row("building-pk", "전유", 59.98, "아파트", "", "101동"), hoNm: "102호" },
    { ...row("building-pk", "공용", 20.02, "", "계단실", "101동"), hoNm: "102호" },
  ];

  const state = consumeBuildingAreaRows(createCollectionState(), rows, { isFinal: true });

  assert.equal(state.processedUnits, 2);
  assert.equal(state.patterns.length, 2);
  assert.equal(state.seenUnitHashes.length, 2);
});

test("unfinished page rows are persisted with calculation fields only", () => {
  const rows = [
    {
      ...row("building-pk", "전유", 84.95, "아파트", "", "101동"),
      hoNm: "101호",
      unusedLargeField: "x".repeat(100000),
    },
    {
      ...row("building-pk", "공용", 26.77, "", "계단실", "101동"),
      hoNm: "101호",
      unusedLargeField: "x".repeat(100000),
    },
  ];

  const state = consumeBuildingAreaRows(createCollectionState(), rows);

  assert.equal(state.carryRows.length, 2);
  assert.equal("unusedLargeField" in state.carryRows[0], false);
  assert.ok(JSON.stringify(state).length < 5000);
});

test("legacy stored patterns are compacted before the next checkpoint", () => {
  const legacyState = {
    ...createCollectionState(),
    patterns: [
      {
        ...pattern("101동", 84.95, 111.72, 1),
        components: [{ purpose: "계단실", area: 26.77, included: true }],
      },
    ],
  };

  const state = consumeBuildingAreaRows(legacyState, [], { isFinal: true });

  assert.equal(state.processedUnits, 0);
  assert.equal("components" in state.patterns[0], false);
  assert.match(state.patterns[0].key, /^h:[0-9a-z]+$/);
});

function row(key, useType, area, mainPurpose, detailPurpose, dong) {
  return {
    mgmBldrgstPk: key,
    exposPubuseGbCdNm: useType,
    area,
    mainPurpsCdNm: mainPurpose,
    etcPurps: detailPurpose,
    dongNm: dong,
    hoNm: key,
  };
}

function pattern(dong, exclusiveArea, supplyArea, unitCount) {
  return {
    key: `${dong}-${exclusiveArea}-${supplyArea}`,
    dong,
    exclusiveArea,
    residentialCommonArea: supplyArea - exclusiveArea,
    supplyArea,
    unitCount,
    components: [],
  };
}
