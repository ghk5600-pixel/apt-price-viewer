export const SUPPLY_CALCULATION_VERSION =
  "supply-model-v15-rental-inclusive";
export const SQUARE_METERS_PER_PYEONG = 3.305785;
export const MIN_SUPPLY_TO_EXCLUSIVE_RATIO = 1.1;
export const MAX_SUPPLY_TO_EXCLUSIVE_RATIO = 1.8;
const MAX_SHELTER_COMPONENT_TO_EXCLUSIVE_RATIO = 0.5;

export const STANDARD_AREA_GROUPS = [
  { id: "59", label: "59타입", min: 58, max: 60, target: 59, method: "standard" },
  { id: "74", label: "74타입", min: 73, max: 75, target: 74, method: "standard" },
  { id: "84", label: "84타입", min: 83, max: 85, target: 84, method: "standard" },
];

const RESIDENTIAL_COMMON_TERMS = [
  "계단",
  "복도",
  "홀",
  "현관",
  "승강기",
  "엘리베이터",
  "코아",
  "코어",
  "로비",
  "라운지",
  "벽체",
];

const NON_RESIDENTIAL_TERMS = [
  "관리",
  "경비",
  "보육",
  "어린이",
  "노인",
  "경로",
  "독서",
  "회의",
  "주민",
  "커뮤니티",
  "주차",
  "기계",
  "전기",
  "발전",
  "펌프",
  "변전",
  "급수",
  "저수",
  "정화",
  "쓰레기",
  "근린",
  "판매",
  "상가",
  "문화",
  "스튜디오",
  "아트",
  "도서",
  "열람",
  "생태",
  "학습",
  "화장실",
  "창고",
  "공조",
  "방재",
  "mdf",
  "휀룸",
  "체육",
  "운동",
  "수영",
  "사우나",
  "골프",
  "게스트",
  "세탁",
  "공중정원",
  "아이돌봄",
  "인포",
  "행사",
  "건강",
  "창업",
  "지역",
];

const EXCLUDED_APARTMENT_UNIT_MARKERS = [
  "도시형생활주택",
  "소형주택",
  "청년안심주택",
  "역세권청년주택",
  "오피스텔",
  "업무시설",
  "판매시설",
  "근린생활시설",
  "생활숙박시설",
  "다세대주택",
  "연립주택",
  "기숙사",
];

const RENTAL_APARTMENT_UNIT_MARKERS = [
  "공공임대",
  "국민임대",
  "영구임대",
  "행복주택",
  "장기전세",
  "매입임대",
  "민간임대",
  "기타임대",
];

export function createCollectionState() {
  return {
    carryRows: [],
    pendingUnits: [],
    patterns: [],
    processedRows: 0,
    sourceRows: 0,
    filteredRows: 0,
    processedUnits: 0,
    skippedUnits: 0,
    seenUnitHashes: [],
    warnings: [],
  };
}

export function consumeBuildingAreaRows(inputState, rows, options = {}) {
  const state = normalizeCollectionState(inputState);
  const sourceRows = Array.isArray(rows) ? rows : [];
  const apartmentComponents = normalizeApartmentComponents(
    options.apartmentComponents
  );
  const incomingRows = [...state.carryRows, ...sourceRows.map(compactAreaRow)];
  const isFinal = Boolean(options.isFinal);
  const patternIndex = new Map(state.patterns.map((pattern) => [pattern.key, pattern]));
  const seenUnitHashes = new Set(state.seenUnitHashes);
  const pendingUnitIndex = new Map(
    state.pendingUnits.map((unit) => [unit.key, unit])
  );

  incomingRows.forEach((row) => {
    const unitKey = unitRowKey(row);
    if (!unitKey) return;
    const unitHash = hashUnitKey(unitKey);
    if (seenUnitHashes.has(unitHash)) return;
    let unit = pendingUnitIndex.get(unitHash);
    if (!unit) {
      unit = createPendingUnit(unitHash);
      state.pendingUnits.push(unit);
      pendingUnitIndex.set(unitHash, unit);
    }
    consumePendingUnitRow(unit, row);
  });

  if (isFinal) {
    const shelterAreaMedians = buildShelterAreaMedians(state.pendingUnits);
    state.pendingUnits.forEach((unit) => {
      seenUnitHashes.add(unit.key);
      if (!unit.exclusiveArea || !matchesPendingUnitComponent(unit, apartmentComponents)) {
        state.filteredRows += unit.rowCount;
        state.skippedUnits += 1;
        return;
      }
      const residentialCommonArea = normalizeResidentialCommonArea(
        unit.exclusiveArea,
        unit.residentialCommonArea,
        unit.shelterCommonAreas,
        shelterAreaMedians.get(exclusiveAreaMedianKey(unit.exclusiveArea))
      );
      if (residentialCommonArea <= 0) {
        state.skippedUnits += 1;
        return;
      }
      mergeUnitPattern(state.patterns, patternIndex, {
        dong: unit.exclusiveDongName || unit.dongNames[0] || "",
        exclusiveArea: round(unit.exclusiveArea, 4),
        residentialCommonArea: round(residentialCommonArea, 4),
        supplyArea: round(unit.exclusiveArea + residentialCommonArea, 4),
        unitCount: 1,
        rentalUnitCount: unit.isRentalApartment ? 1 : 0,
        components: [],
      });
      state.processedUnits += 1;
    });
    state.pendingUnits = [];
  }

  state.seenUnitHashes = [...seenUnitHashes];
  state.carryRows = [];
  state.sourceRows += sourceRows.length;
  state.processedRows += sourceRows.length;
  return state;
}

function createPendingUnit(key) {
  return {
    key,
    rowCount: 0,
    buildingNames: [],
    dongNames: [],
    exclusiveArea: 0,
    exclusiveDongName: "",
    residentialCommonArea: 0,
    shelterCommonAreas: [],
    isRentalApartment: false,
  };
}

function consumePendingUnitRow(unit, row) {
  unit.rowCount += 1;
  addUniqueValue(unit.buildingNames, String(row?.bldNm || "").trim());
  addUniqueValue(unit.dongNames, String(row?.dongNm || "").trim());
  const usage = normalizeText(row?.exposPubuseGbCdNm);
  const area = toArea(row?.area);
  if (isRentalApartmentPurpose(rowPurpose(row))) {
    unit.isRentalApartment = true;
  }
  if (
    usage === "전유" &&
    area > 10 &&
    isApartmentExclusivePurpose(rowPurpose(row)) &&
    area > unit.exclusiveArea
  ) {
    unit.exclusiveArea = area;
    unit.exclusiveDongName = String(row?.dongNm || "").trim();
  }
  if (
    usage === "공용" &&
    area > 0 &&
    isResidentialCommonPurpose(rowPurpose(row))
  ) {
    unit.residentialCommonArea += area;
    if (normalizeText(rowPurpose(row)).includes("대피소")) {
      unit.shelterCommonAreas.push(area);
    }
  }
}

function buildShelterAreaMedians(units) {
  const valuesByExclusiveArea = new Map();
  units.forEach((unit) => {
    const exclusiveArea = Number(unit?.exclusiveArea) || 0;
    if (exclusiveArea <= 0) return;
    const key = exclusiveAreaMedianKey(exclusiveArea);
    const values = valuesByExclusiveArea.get(key) || [];
    (unit.shelterCommonAreas || []).forEach((areaValue) => {
      const area = Number(areaValue) || 0;
      if (
        area > 0 &&
        area / exclusiveArea < MAX_SHELTER_COMPONENT_TO_EXCLUSIVE_RATIO
      ) {
        values.push(area);
      }
    });
    if (values.length) valuesByExclusiveArea.set(key, values);
  });
  return new Map(
    [...valuesByExclusiveArea].map(([key, values]) => [key, median(values)])
  );
}

function normalizeResidentialCommonArea(
  exclusiveArea,
  residentialCommonArea,
  shelterCommonAreas = [],
  shelterAreaMedian = 0
) {
  let normalizedArea = Number(residentialCommonArea) || 0;
  (shelterCommonAreas || []).forEach((areaValue) => {
    const area = Number(areaValue) || 0;
    if (
      exclusiveArea > 0 &&
      area / exclusiveArea >= MAX_SHELTER_COMPONENT_TO_EXCLUSIVE_RATIO
    ) {
      normalizedArea -= area;
      if (shelterAreaMedian > 0) normalizedArea += shelterAreaMedian;
    }
  });
  return Math.max(0, normalizedArea);
}

function exclusiveAreaMedianKey(value) {
  return (Number(value) || 0).toFixed(2);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function matchesPendingUnitComponent(unit, apartmentComponents) {
  const rows = [
    ...unit.buildingNames.map((bldNm) => ({ bldNm, dongNm: "" })),
    ...unit.dongNames.map((dongNm) => ({ bldNm: "", dongNm })),
  ];
  return matchesApartmentComponent(rows, apartmentComponents);
}

function addUniqueValue(values, value) {
  if (value && !values.includes(value)) values.push(value);
}

export function buildSupplyProfile({
  complexKey,
  source,
  collectionState,
  expectedHouseholds = null,
  calculatedAt = new Date().toISOString(),
}) {
  const state = normalizeCollectionState(collectionState);
  return buildSupplyProfileFromPatterns({
    complexKey,
    source,
    patterns: state.patterns,
    expectedHouseholds,
    calculatedAt,
    processedRows: state.processedRows,
    sourceRows: state.sourceRows,
    filteredRows: state.filteredRows,
    processedUnits: state.processedUnits,
    skippedUnits: state.skippedUnits,
    rentalHouseholds: state.rentalHouseholds,
  });
}

export function buildSupplyProfileFromPatterns({
  complexKey,
  source,
  patterns: inputPatterns,
  expectedHouseholds = null,
  calculatedAt = new Date().toISOString(),
  processedRows = 0,
  sourceRows = 0,
  filteredRows = 0,
  processedUnits = 0,
  skippedUnits = 0,
  rentalHouseholds = 0,
  provenance = null,
}) {
  const patterns = (Array.isArray(inputPatterns) ? inputPatterns : [])
    .map((pattern) => ({
      ...pattern,
      exclusiveArea: Number(pattern?.exclusiveArea) || 0,
      residentialCommonArea: Number(pattern?.residentialCommonArea) || 0,
      supplyArea: Number(pattern?.supplyArea) || 0,
      unitCount: Math.max(0, Math.round(Number(pattern?.unitCount) || 0)),
      rentalUnitCount: Math.max(
        0,
        Math.min(
          Math.round(Number(pattern?.unitCount) || 0),
          Math.round(Number(pattern?.rentalUnitCount) || 0)
        )
      ),
    }))
    .filter((pattern) => pattern.unitCount > 0 && pattern.exclusiveArea > 0 && pattern.supplyArea > pattern.exclusiveArea)
    .sort((a, b) => a.exclusiveArea - b.exclusiveArea || a.supplyArea - b.supplyArea);
  const assignments = assignPatternsToGroups(patterns);
  const groups = assignments
    .map(({ meta, patterns: groupPatterns }) => buildAreaGroup(meta, groupPatterns))
    .filter(Boolean)
    .sort((a, b) => a.targetExclusiveArea - b.targetExclusiveArea);

  const profile = {
    complexKey,
    calculationVersion: SUPPLY_CALCULATION_VERSION,
    calculatedAt,
    source,
    unitCount: patterns.reduce((sum, pattern) => sum + pattern.unitCount, 0),
    patternCount: patterns.length,
    processedRows: Number(processedRows) || 0,
    sourceRows: Number(sourceRows) || Number(processedRows) || 0,
    filteredRows: Number(filteredRows) || 0,
    skippedUnits: Number(skippedUnits) || 0,
    groups,
  };
  if (provenance) profile.provenance = provenance;
  profile.rentalHouseholds = Math.min(
    profile.unitCount,
    Math.max(
      0,
      Math.round(
        Number(rentalHouseholds) ||
          patterns.reduce((sum, pattern) => sum + pattern.rentalUnitCount, 0)
      )
    )
  );
  profile.saleOrUnknownHouseholds = profile.unitCount - profile.rentalHouseholds;
  profile.householdValidation = buildHouseholdValidation({
    expectedHouseholds,
    profileUnitCount: profile.unitCount,
    processedUnits,
    skippedUnits,
    rentalHouseholds: profile.rentalHouseholds,
  });
  profile.areaValidation = buildAreaValidation(patterns);
  return profile;
}

export function buildHouseholdValidation({
  expectedHouseholds,
  profileUnitCount,
  processedUnits = 0,
  skippedUnits = 0,
  rentalHouseholds = 0,
}) {
  const expected = positiveInteger(expectedHouseholds);
  const collected = Math.max(0, Math.round(Number(profileUnitCount) || 0));
  const observed = Math.max(
    collected,
    Math.round(Number(processedUnits) || 0) + Math.round(Number(skippedUnits) || 0)
  );

  if (!expected) {
    return {
      status: "unavailable",
      expectedHouseholds: null,
      collectedHouseholds: collected,
      observedLedgerUnits: observed,
      difference: null,
      coverageRate: null,
      toleranceHouseholds: null,
      exactMatch: null,
    };
  }

  const difference = collected - expected;
  const toleranceHouseholds =
    expected >= 200 ? Math.max(2, Math.ceil(expected * 0.01)) : 0;
  const exactMatch = difference === 0;
  const rental = Math.min(collected, Math.max(0, Math.round(Number(rentalHouseholds) || 0)));
  return {
    status: exactMatch ? (rental > 0 ? "rental-included" : "matched") : "mismatch",
    expectedHouseholds: expected,
    collectedHouseholds: collected,
    rentalHouseholds: rental,
    saleOrUnknownHouseholds: collected - rental,
    observedLedgerUnits: observed,
    difference,
    coverageRate: round(collected / expected, 6),
    toleranceHouseholds,
    exactMatch,
  };
}

export function buildAreaValidation(inputPatterns) {
  const issues = (Array.isArray(inputPatterns) ? inputPatterns : [])
    .map((pattern) => {
      const exclusiveArea = Number(pattern?.exclusiveArea) || 0;
      const supplyArea = Number(pattern?.supplyArea) || 0;
      const ratio = exclusiveArea > 0 ? supplyArea / exclusiveArea : 0;
      if (
        ratio >= MIN_SUPPLY_TO_EXCLUSIVE_RATIO &&
        ratio <= MAX_SUPPLY_TO_EXCLUSIVE_RATIO
      ) {
        return null;
      }
      return {
        dong: String(pattern?.dong || ""),
        exclusiveArea: round(exclusiveArea, 4),
        supplyArea: round(supplyArea, 4),
        unitCount: Math.max(0, Math.round(Number(pattern?.unitCount) || 0)),
        ratio: round(ratio, 6),
        reason:
          ratio < MIN_SUPPLY_TO_EXCLUSIVE_RATIO
            ? "supply-ratio-too-low"
            : "supply-ratio-too-high",
      };
    })
    .filter(Boolean);

  return {
    status: issues.length ? "mismatch" : "matched",
    minSupplyRatio: MIN_SUPPLY_TO_EXCLUSIVE_RATIO,
    maxSupplyRatio: MAX_SUPPLY_TO_EXCLUSIVE_RATIO,
    issueCount: issues.length,
    issues: issues.slice(0, 20),
  };
}

export function findSupplyGroup(profile, exclusiveArea) {
  const area = Number(exclusiveArea);
  if (!Number.isFinite(area) || !profile?.groups?.length) return null;

  const standard = profile.groups.find(
    (group) => group.method === "standard" && area >= group.exclusiveMin && area < group.exclusiveMax
  );
  if (standard) return standard;

  let best = null;
  let bestDifference = Number.POSITIVE_INFINITY;
  profile.groups.forEach((group) => {
    (group.exclusiveValues || []).forEach((value) => {
      const difference = Math.abs(area - Number(value));
      if (difference < bestDifference) {
        best = group;
        bestDifference = difference;
      }
    });
  });
  return bestDifference <= 0.25 ? best : null;
}

export function calculateWeightedSupplyPpy(dealAmountManwon, group, apartmentDong = "") {
  const amount = Number(dealAmountManwon);
  if (!Number.isFinite(amount) || amount <= 0 || !group) return null;
  const normalizedDong = normalizeDongName(apartmentDong);
  const dongFactor = normalizedDong ? group.dongFactors?.[normalizedDong] : null;
  const factor = Number(dongFactor?.factor || group.factor);
  if (!Number.isFinite(factor) || factor <= 0) return null;
  return amount * factor;
}

export function isResidentialCommonPurpose(value) {
  const purpose = normalizeText(value);
  if (!purpose) return false;
  if (purpose.includes("대피")) return true;
  const residentialTermCount = countMatchedTerms(
    purpose,
    RESIDENTIAL_COMMON_TERMS
  );
  const nonResidentialTermCount = countMatchedTerms(
    purpose,
    NON_RESIDENTIAL_TERMS
  );
  return (
    residentialTermCount > 0 &&
    residentialTermCount > nonResidentialTermCount
  );
}

export function isApartmentExclusivePurpose(value) {
  const purpose = normalizeText(value);
  if (!purpose) return false;
  if (
    EXCLUDED_APARTMENT_UNIT_MARKERS.some((marker) =>
      purpose.includes(marker)
    )
  ) {
    return false;
  }
  return purpose.includes("아파트") || purpose === "공동주택";
}

function isRentalApartmentPurpose(value) {
  const purpose = normalizeText(value);
  return RENTAL_APARTMENT_UNIT_MARKERS.some((marker) => purpose.includes(marker));
}

export function matchesApartmentComponent(rows, components) {
  const selectors = normalizeApartmentComponents(components);
  if (!selectors.length) return true;

  const rowBuildingNames = new Set(
    rows
      .map((row) => normalizeComponentName(row?.bldNm))
      .filter(Boolean)
  );
  const rowDongNames = new Set(
    rows
      .map((row) => normalizeDongName(row?.dongNm))
      .filter(Boolean)
  );
  const namedSelectors = selectors.filter(
    (selector) => selector.buildingName || selector.dongName
  );
  if (!namedSelectors.length || (!rowBuildingNames.size && !rowDongNames.size)) {
    return true;
  }
  const hasComparableName = namedSelectors.some(
    (selector) =>
      (selector.buildingName && rowBuildingNames.size) ||
      (selector.dongName && rowDongNames.size)
  );
  if (!hasComparableName) return true;

  return namedSelectors.some((selector) => {
    const buildingMatch =
      selector.buildingName &&
      [...rowBuildingNames].some(
        (rowName) =>
          rowName === selector.buildingName ||
          rowName.includes(selector.buildingName) ||
          selector.buildingName.includes(rowName)
      );
    const dongMatch =
      selector.dongName && rowDongNames.has(selector.dongName);
    return Boolean(buildingMatch || dongMatch);
  });
}

export function normalizeDongName(value) {
  return normalizeText(value)
    .replace(/제/g, "")
    .replace(/동$/g, "")
    .replace(/^0+/, "");
}

function normalizeCollectionState(inputState) {
  const state = inputState && typeof inputState === "object" ? inputState : createCollectionState();
  return {
    carryRows: Array.isArray(state.carryRows) ? state.carryRows.map(compactAreaRow) : [],
    pendingUnits: Array.isArray(state.pendingUnits)
      ? state.pendingUnits.map(normalizePendingUnit)
      : [],
    patterns: Array.isArray(state.patterns) ? state.patterns.map(compactStoredPattern) : [],
    processedRows: Number(state.processedRows) || 0,
    sourceRows: Number(state.sourceRows) || Number(state.processedRows) || 0,
    filteredRows: Number(state.filteredRows) || 0,
    processedUnits: Number(state.processedUnits) || 0,
    skippedUnits: Number(state.skippedUnits) || 0,
    rentalHouseholds: Number(state.rentalHouseholds) || 0,
    seenUnitHashes: normalizeSeenUnitHashes(state),
    warnings: Array.isArray(state.warnings) ? state.warnings : [],
  };
}

function normalizePendingUnit(unit) {
  return {
    key: String(unit?.key || ""),
    rowCount: Math.max(0, Math.round(Number(unit?.rowCount) || 0)),
    buildingNames: uniqueStrings(unit?.buildingNames),
    dongNames: uniqueStrings(unit?.dongNames),
    exclusiveArea: toArea(unit?.exclusiveArea),
    exclusiveDongName: String(unit?.exclusiveDongName || "").trim(),
    residentialCommonArea: toArea(unit?.residentialCommonArea),
    shelterCommonAreas: (Array.isArray(unit?.shelterCommonAreas)
      ? unit.shelterCommonAreas
      : []
    )
      .map(toArea)
      .filter((area) => area > 0),
    isRentalApartment: Boolean(unit?.isRentalApartment),
  };
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || "").trim()).filter(Boolean))];
}

function unitRowKey(row) {
  const managementPk = String(row?.mgmBldrgstPk || "").trim();
  const unitNumber = String(row?.hoNm || "").trim();
  if (!managementPk || !unitNumber) return "";
  return [managementPk, normalizeDongName(row?.dongNm), unitNumber].join("::");
}

function compactAreaRow(row) {
  return {
    mgmBldrgstPk: String(row?.mgmBldrgstPk || ""),
    bldNm: String(row?.bldNm || ""),
    dongNm: String(row?.dongNm || ""),
    hoNm: String(row?.hoNm || ""),
    exposPubuseGbCdNm: String(row?.exposPubuseGbCdNm || ""),
    area: Number(row?.area) || 0,
    mainPurpsCdNm: String(row?.mainPurpsCdNm || ""),
    etcPurps: String(row?.etcPurps || ""),
  };
}

function normalizeApartmentComponents(components) {
  return (Array.isArray(components) ? components : [])
    .map((component) => ({
      managementPk: String(component?.managementPk || "").trim(),
      buildingName: normalizeComponentName(component?.buildingName),
      dongName: normalizeDongName(component?.dongName),
      componentType: String(component?.componentType || "").trim(),
    }))
    .filter(
      (component) =>
        component.managementPk || component.buildingName || component.dongName
    );
}

function normalizeComponentName(value) {
  return normalizeText(value)
    .replace(/공동주택/g, "")
    .replace(/주상복합/g, "")
    .replace(/아파트/g, "");
}

function mergeUnitPattern(patterns, patternIndex, unit) {
  const componentSignature = unit.components
    .map((component) => `${component.purpose}:${component.area.toFixed(4)}:${component.included ? 1 : 0}`)
    .sort()
    .join("|");
  const key = hashPatternKey([
    normalizeDongName(unit.dong),
    unit.exclusiveArea.toFixed(4),
    unit.supplyArea.toFixed(4),
    componentSignature,
  ].join("::"));
  const existing = patternIndex.get(key);
  if (existing) {
    existing.unitCount += 1;
    existing.rentalUnitCount =
      Math.max(0, Number(existing.rentalUnitCount) || 0) +
      Math.max(0, Number(unit.rentalUnitCount) || 0);
    return;
  }
  const { components: _components, ...compactUnit } = unit;
  const pattern = { ...compactUnit, key };
  patterns.push(pattern);
  patternIndex.set(key, pattern);
}

function assignPatternsToGroups(patterns) {
  const assignments = [];
  const unassigned = [];

  STANDARD_AREA_GROUPS.forEach((standard) => {
    const matching = patterns.filter(
      (pattern) => pattern.exclusiveArea >= standard.min && pattern.exclusiveArea < standard.max
    );
    if (matching.length) assignments.push({ meta: standard, patterns: matching });
  });

  patterns.forEach((pattern) => {
    const isStandard = STANDARD_AREA_GROUPS.some(
      (group) => pattern.exclusiveArea >= group.min && pattern.exclusiveArea < group.max
    );
    if (!isStandard) unassigned.push(pattern);
  });

  const exclusiveClusters = buildExclusiveClusters(unassigned);
  exclusiveClusters.forEach((cluster) => {
    const min = Math.min(...cluster.map((pattern) => pattern.exclusiveArea));
    const max = Math.max(...cluster.map((pattern) => pattern.exclusiveArea));
    const labelMin = Math.floor(min + 0.000001);
    const labelMax = Math.floor(max + 0.000001);
    const suffix = labelMin === labelMax ? `${labelMin}` : `${labelMin}·${labelMax}`;
    assignments.push({
      meta: {
        id: `dynamic-${labelMin}-${labelMax}`,
        label: `${suffix}타입`,
        min,
        max,
        target: weightedAverage(cluster, "exclusiveArea"),
        method: "dynamic",
      },
      patterns: cluster,
    });
  });
  return assignments;
}

function buildExclusiveClusters(patterns) {
  const sorted = patterns.slice().sort((a, b) => a.exclusiveArea - b.exclusiveArea);
  const clusters = [];

  sorted.forEach((pattern) => {
    const current = clusters[clusters.length - 1];
    if (!current) {
      clusters.push([pattern]);
      return;
    }
    const previousArea = current[current.length - 1].exclusiveArea;
    const combined = [...current, pattern];
    const min = combined[0].exclusiveArea;
    const max = combined[combined.length - 1].exclusiveArea;
    const center = weightedAverage(combined, "exclusiveArea");
    const adjacentGap = pattern.exclusiveArea - previousArea;
    const relativeSpan = center > 0 ? (max - min) / center : Number.POSITIVE_INFINITY;
    if (adjacentGap <= 1.5 && relativeSpan <= 0.03) {
      current.push(pattern);
    } else {
      clusters.push([pattern]);
    }
  });
  return clusters;
}

function buildAreaGroup(meta, patterns) {
  const unitCount = patterns.reduce((sum, pattern) => sum + pattern.unitCount, 0);
  if (!unitCount) return null;
  const candidates = buildSupplyCandidates(patterns);
  const factor = weightedFactor(patterns);
  const exclusiveValues = Array.from(new Set(patterns.map((pattern) => pattern.exclusiveArea))).sort((a, b) => a - b);
  const dongFactors = {};
  const dongNames = Array.from(new Set(patterns.map((pattern) => normalizeDongName(pattern.dong)).filter(Boolean)));
  dongNames.forEach((dong) => {
    const dongPatterns = patterns.filter((pattern) => normalizeDongName(pattern.dong) === dong);
    const dongUnitCount = dongPatterns.reduce((sum, pattern) => sum + pattern.unitCount, 0);
    dongFactors[dong] = {
      unitCount: dongUnitCount,
      factor: round(weightedFactor(dongPatterns), 10),
    };
  });

  return {
    id: meta.id,
    label: meta.label,
    method: meta.method,
    exclusiveMin: meta.method === "standard" ? meta.min : Math.min(...exclusiveValues),
    exclusiveMax: meta.method === "standard" ? meta.max : Math.max(...exclusiveValues),
    exclusiveValues,
    targetExclusiveArea: round(weightedAverage(patterns, "exclusiveArea"), 4),
    representativeSupplyArea: round(weightedAverage(patterns, "supplyArea"), 4),
    representativeSupplyPyeong: round(weightedAverage(patterns, "supplyArea") / SQUARE_METERS_PER_PYEONG, 2),
    unitCount,
    candidates,
    factor: round(factor, 10),
    dongFactors,
  };
}

function buildSupplyCandidates(patterns) {
  const candidates = [];
  patterns.forEach((pattern) => {
    let candidate = candidates.find((item) => Math.abs(item.supplyArea - pattern.supplyArea) <= 0.05);
    if (!candidate) {
      candidate = {
        supplyArea: pattern.supplyArea,
        weightedAreaSum: 0,
        unitCount: 0,
      };
      candidates.push(candidate);
    }
    candidate.weightedAreaSum += pattern.supplyArea * pattern.unitCount;
    candidate.unitCount += pattern.unitCount;
    candidate.supplyArea = candidate.weightedAreaSum / candidate.unitCount;
  });
  const total = candidates.reduce((sum, candidate) => sum + candidate.unitCount, 0);
  return candidates
    .map((candidate) => ({
      supplyArea: round(candidate.supplyArea, 4),
      supplyPyeong: round(candidate.supplyArea / SQUARE_METERS_PER_PYEONG, 2),
      unitCount: candidate.unitCount,
      weight: round(candidate.unitCount / total, 6),
    }))
    .sort((a, b) => a.supplyArea - b.supplyArea);
}

function weightedFactor(patterns) {
  const total = patterns.reduce((sum, pattern) => sum + pattern.unitCount, 0);
  if (!total) return 0;
  const reciprocalArea = patterns.reduce(
    (sum, pattern) => sum + (pattern.unitCount / total) / pattern.supplyArea,
    0
  );
  return SQUARE_METERS_PER_PYEONG * reciprocalArea;
}

function weightedAverage(patterns, key) {
  const total = patterns.reduce((sum, pattern) => sum + pattern.unitCount, 0);
  if (!total) return 0;
  return patterns.reduce((sum, pattern) => sum + Number(pattern[key]) * pattern.unitCount, 0) / total;
}

function rowPurpose(row) {
  return `${row?.mainPurpsCdNm || ""} ${row?.etcPurps || ""}`.trim();
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, "");
}

function countMatchedTerms(value, terms) {
  return terms.reduce(
    (count, term) => count + (value.includes(term) ? 1 : 0),
    0
  );
}

function toArea(value) {
  const area = Number(value);
  return Number.isFinite(area) ? area : 0;
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : null;
}

function normalizeSeenUnitHashes(state) {
  if (Array.isArray(state.seenUnitHashes)) return state.seenUnitHashes;
  if (Array.isArray(state.seenUnitKeys)) {
    return state.seenUnitKeys.map((key) => hashUnitKey(String(key || ""))).filter(Boolean);
  }
  return [];
}

function compactStoredPattern(pattern) {
  const { components: _components, ...compactPattern } = pattern || {};
  return {
    ...compactPattern,
    key: hashPatternKey(String(compactPattern.key || "")),
  };
}

function hashPatternKey(value) {
  if (/^h:[0-9a-z]+$/.test(value)) return value;
  return `h:${hashUnitKey(value)}`;
}

function hashUnitKey(value) {
  let hash = 1469598103934665603n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 1099511628211n);
  }
  return hash.toString(36);
}
