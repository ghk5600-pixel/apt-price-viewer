export const SUPPLY_CALCULATION_VERSION =
  "supply-model-v11-permit-discovery-first";
export const SQUARE_METERS_PER_PYEONG = 3.305785;

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
  "공공임대",
  "국민임대",
  "영구임대",
  "행복주택",
  "장기전세",
  "매입임대",
  "오피스텔",
  "업무시설",
  "판매시설",
  "근린생활시설",
  "생활숙박시설",
  "다세대주택",
  "연립주택",
  "기숙사",
];

export function createCollectionState() {
  return {
    carryRows: [],
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
  const incomingRows = sourceRows.map(compactAreaRow);
  const combinedRows = [...state.carryRows, ...incomingRows]
    .sort((left, right) => unitRowKey(left).localeCompare(unitRowKey(right)));
  const groups = groupContiguousRows(combinedRows);
  const isFinal = Boolean(options.isFinal);
  const processCount = isFinal ? groups.length : Math.max(0, groups.length - 1);
  const patternIndex = new Map(state.patterns.map((pattern) => [pattern.key, pattern]));
  const seenUnitHashes = new Set(state.seenUnitHashes);

  for (let index = 0; index < processCount; index += 1) {
    const unitKey = unitRowKey(groups[index][0]);
    const unitHash = unitKey ? hashUnitKey(unitKey) : "";
    if (unitHash && seenUnitHashes.has(unitHash)) continue;
    if (unitHash) seenUnitHashes.add(unitHash);
    if (!isSelectedApartmentUnit(groups[index], apartmentComponents)) {
      state.filteredRows += groups[index].length;
      state.skippedUnits += 1;
      continue;
    }
    const unit = buildUnitPattern(groups[index]);
    if (!unit) {
      state.skippedUnits += 1;
      continue;
    }
    mergeUnitPattern(state.patterns, patternIndex, unit);
    state.processedUnits += 1;
  }

  state.seenUnitHashes = [...seenUnitHashes];
  state.carryRows = isFinal || !groups.length ? [] : groups[groups.length - 1];
  state.sourceRows += sourceRows.length;
  state.processedRows += sourceRows.length;
  return state;
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
  provenance = null,
}) {
  const patterns = (Array.isArray(inputPatterns) ? inputPatterns : [])
    .map((pattern) => ({
      ...pattern,
      exclusiveArea: Number(pattern?.exclusiveArea) || 0,
      residentialCommonArea: Number(pattern?.residentialCommonArea) || 0,
      supplyArea: Number(pattern?.supplyArea) || 0,
      unitCount: Math.max(0, Math.round(Number(pattern?.unitCount) || 0)),
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
  profile.householdValidation = buildHouseholdValidation({
    expectedHouseholds,
    profileUnitCount: profile.unitCount,
    processedUnits,
    skippedUnits,
  });
  return profile;
}

export function buildHouseholdValidation({
  expectedHouseholds,
  profileUnitCount,
  processedUnits = 0,
  skippedUnits = 0,
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
  return {
    status:
      Math.abs(difference) <= toleranceHouseholds ? "matched" : "mismatch",
    expectedHouseholds: expected,
    collectedHouseholds: collected,
    observedLedgerUnits: observed,
    difference,
    coverageRate: round(collected / expected, 6),
    toleranceHouseholds,
    exactMatch,
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
  const hasResidentialTerm = RESIDENTIAL_COMMON_TERMS.some((term) => purpose.includes(term));
  const hasExcludedTerm = NON_RESIDENTIAL_TERMS.some((term) => purpose.includes(term));
  return hasResidentialTerm && !hasExcludedTerm;
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
    patterns: Array.isArray(state.patterns) ? state.patterns.map(compactStoredPattern) : [],
    processedRows: Number(state.processedRows) || 0,
    sourceRows: Number(state.sourceRows) || Number(state.processedRows) || 0,
    filteredRows: Number(state.filteredRows) || 0,
    processedUnits: Number(state.processedUnits) || 0,
    skippedUnits: Number(state.skippedUnits) || 0,
    seenUnitHashes: normalizeSeenUnitHashes(state),
    warnings: Array.isArray(state.warnings) ? state.warnings : [],
  };
}

function groupContiguousRows(rows) {
  const groups = [];
  let currentKey = "";
  let currentRows = [];

  rows.forEach((row) => {
    const key = unitRowKey(row);
    if (!key) return;
    if (currentRows.length && key !== currentKey) {
      groups.push(currentRows);
      currentRows = [];
    }
    currentKey = key;
    currentRows.push(row);
  });
  if (currentRows.length) groups.push(currentRows);
  return groups;
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

function isSelectedApartmentUnit(rows, apartmentComponents) {
  const exclusiveRows = rows.filter(
    (row) => normalizeText(row.exposPubuseGbCdNm) === "전유"
  );
  if (
    !exclusiveRows.some((row) =>
      isApartmentExclusivePurpose(rowPurpose(row))
    )
  ) {
    return false;
  }
  return matchesApartmentComponent(rows, apartmentComponents);
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

function buildUnitPattern(rows) {
  if (!rows.length) return null;
  const exclusiveRows = rows.filter((row) => normalizeText(row.exposPubuseGbCdNm) === "전유");
  const apartmentRows = exclusiveRows
    .filter((row) => isApartmentExclusivePurpose(rowPurpose(row)))
    .filter((row) => toArea(row.area) > 10)
    .sort((a, b) => toArea(b.area) - toArea(a.area));
  const exclusiveRow = apartmentRows[0];
  if (!exclusiveRow) return null;

  const exclusiveArea = toArea(exclusiveRow.area);
  const commonComponents = rows
    .filter((row) => normalizeText(row.exposPubuseGbCdNm) === "공용")
    .map((row) => {
      const purpose = rowPurpose(row);
      const area = toArea(row.area);
      return {
        purpose,
        area,
        included: area > 0 && isResidentialCommonPurpose(purpose),
      };
    })
    .filter((component) => component.area >= 0);
  const residentialCommonArea = commonComponents
    .filter((component) => component.included)
    .reduce((sum, component) => sum + component.area, 0);
  if (residentialCommonArea <= 0) return null;

  return {
    dong: String(exclusiveRow.dongNm || rows[0]?.dongNm || "").trim(),
    exclusiveArea: round(exclusiveArea, 4),
    residentialCommonArea: round(residentialCommonArea, 4),
    supplyArea: round(exclusiveArea + residentialCommonArea, 4),
    unitCount: 1,
    components: commonComponents,
  };
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
