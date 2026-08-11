export const LEDGER_MATCH_VERSION =
  "building-ledger-match-v3-apartment-unit-filter";

const TITLE_OPERATIONS = ["getBrRecapTitleInfo", "getBrTitleInfo"];
const ATTACHED_LOT_OPERATION = "getBrAtchJibunInfo";
const DISCOVERY_PAGE_SIZE = 1000;
const MAX_DISCOVERY_PAGES = 20;
const MAX_RESOLVED_SOURCES = 24;
const EXCLUDED_HOUSING_MARKERS = [
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
];
const NON_APARTMENT_COMPONENT_MARKERS = [
  "오피스텔",
  "업무시설",
  "판매시설",
  "근린생활시설",
  "생활숙박시설",
  "다세대주택",
  "연립주택",
  "기숙사",
];
const NON_APARTMENT_NAME_MARKERS = [
  "상가",
  "오피스텔",
  "업무시설",
  "판매시설",
  "근린생활시설",
];

export async function resolveBuildingLedgerSources({
  requestedSource,
  metadata = {},
  fetchPage,
  maxPages = MAX_DISCOVERY_PAGES,
}) {
  if (typeof fetchPage !== "function") {
    throw new Error("Building ledger fetchPage is required.");
  }

  const evidence = [];
  const rows = [];
  const requested = normalizeSource(requestedSource);

  for (const operation of TITLE_OPERATIONS) {
    const page = await fetchPage(operation, requested, 1, DISCOVERY_PAGE_SIZE);
    evidence.push(discoveryEvidence(operation, "exact-lot", page));
    rows.push(
      ...page.items.map((row) => ({
        row,
        operation,
        scope: "exact-lot",
        exactSource: sameSource(sourceFromRow(row), requested),
      }))
    );
  }

  const attachedAtRequested = await fetchPage(
    ATTACHED_LOT_OPERATION,
    requested,
    1,
    DISCOVERY_PAGE_SIZE
  );
  evidence.push(discoveryEvidence(ATTACHED_LOT_OPERATION, "exact-lot", attachedAtRequested));
  const attachedSources = uniqueSources(
    attachedAtRequested.items.flatMap((row) => sourcesFromAttachedRow(row, requested))
  );

  for (const source of attachedSources) {
    if (sameSource(source, requested)) continue;
    const page = await fetchPage("getBrTitleInfo", source, 1, DISCOVERY_PAGE_SIZE);
    evidence.push(discoveryEvidence("getBrTitleInfo", "attached-lot", page, source));
    rows.push(
      ...page.items.map((row) => ({
        row,
        operation: "getBrTitleInfo",
        scope: "attached-lot",
        exactSource: true,
      }))
    );
  }

  let ranked = rankCandidates(rows, metadata, requested);
  if (!hasConfidentCandidate(ranked)) {
    const legalDongSource = {
      sigunguCd: requested.sigunguCd,
      bjdongCd: requested.bjdongCd,
    };
    for (const operation of TITLE_OPERATIONS) {
      const discovery = await fetchAllPages(
        operation,
        legalDongSource,
        fetchPage,
        maxPages
      );
      evidence.push({
        ...discoveryEvidence(operation, "legal-dong", discovery),
        truncated: discovery.truncated,
      });
      rows.push(
        ...discovery.items.map((row) => ({
          row,
          operation,
          scope: "legal-dong",
          exactSource: sameSource(sourceFromRow(row), requested),
        }))
      );
    }
    ranked = rankCandidates(rows, metadata, requested);
  }

  const selected = selectApartmentCandidates(ranked);
  if (!selected.length) {
    const apartmentCandidates = ranked.filter((candidate) =>
      isSelectableApartmentComponent(candidate.row)
    );
    return {
      status: "not-found",
      version: LEDGER_MATCH_VERSION,
      requestedSource: requested,
      metadata: normalizeMetadata(metadata),
      sources: [],
      managementPks: [],
      candidates: ranked.slice(0, 10).map(toCandidateSummary),
      evidence,
      reasonCode: apartmentCandidates.length
        ? "APARTMENT_COMPONENT_MATCH_UNCERTAIN"
        : "APARTMENT_COMPONENT_NOT_FOUND",
      reason: apartmentCandidates.length
        ? "아파트 용도의 건축물대장은 찾았지만 단지명·주소·사용승인일의 일치도가 부족합니다."
        : "동일 단지에서 공동주택(아파트) 용도의 건축물대장 관리번호를 찾지 못했습니다.",
    };
  }

  const selectedSources = uniqueSources(selected.map((candidate) => candidate.source));
  for (const source of selectedSources.slice(0, 8)) {
    const page = await fetchPage(
      ATTACHED_LOT_OPERATION,
      source,
      1,
      DISCOVERY_PAGE_SIZE
    );
    evidence.push(discoveryEvidence(ATTACHED_LOT_OPERATION, "matched-lot", page, source));
  }

  return {
    status: "matched",
    version: LEDGER_MATCH_VERSION,
    requestedSource: requested,
    metadata: normalizeMetadata(metadata),
    sources: selectedSources.slice(0, MAX_RESOLVED_SOURCES),
    managementPks: Array.from(
      new Set(selected.map((candidate) => String(candidate.row.mgmBldrgstPk || "")).filter(Boolean))
    ),
    components: selected.map(toComponentSelector),
    candidates: selected.map(toCandidateSummary),
    excludedComponents: ranked
      .filter((candidate) => !selected.includes(candidate))
      .slice(0, 20)
      .map(toCandidateSummary),
    evidence,
    matchedAt: new Date().toISOString(),
  };
}

export function scoreBuildingLedgerRow(row, metadata = {}, requestedSource = {}) {
  const normalizedMetadata = normalizeMetadata(metadata);
  const source = sourceFromRow(row);
  const requested = normalizeSource(requestedSource);
  const rowName = normalizeBuildingName(row?.bldNm || row?.etcPurps || "");
  const targetName = normalizeBuildingName(normalizedMetadata.complexName);
  const rowRoadAddress = normalizeAddress(row?.newPlatPlc || "");
  const targetRoadAddress = normalizeAddress(normalizedMetadata.roadAddress);
  const rowLotAddress = normalizeAddress(row?.platPlc || "");
  const targetLotAddress = normalizeAddress(normalizedMetadata.lotAddress);
  const exactSource = sameSource(source, requested);

  let score = 0;
  const reasons = [];
  const nameSimilarity = textSimilarity(rowName, targetName);
  if (targetName && rowName) {
    if (rowName === targetName) {
      score += 0.62;
      reasons.push("단지명 일치");
    } else if (rowName.includes(targetName) || targetName.includes(rowName)) {
      score += 0.55;
      reasons.push("단지명 포함");
    } else if (nameSimilarity >= 0.65) {
      score += 0.42 * nameSimilarity;
      reasons.push(`단지명 유사 ${Math.round(nameSimilarity * 100)}%`);
    }
  }

  const roadSimilarity = textSimilarity(rowRoadAddress, targetRoadAddress);
  if (targetRoadAddress && rowRoadAddress) {
    if (rowRoadAddress === targetRoadAddress) {
      score += 0.3;
      reasons.push("도로명주소 일치");
    } else if (
      rowRoadAddress.includes(targetRoadAddress) ||
      targetRoadAddress.includes(rowRoadAddress)
    ) {
      score += 0.24;
      reasons.push("도로명주소 포함");
    } else if (roadSimilarity >= 0.75) {
      score += 0.16 * roadSimilarity;
      reasons.push("도로명주소 유사");
    }
  }

  if (targetLotAddress && rowLotAddress && rowLotAddress.includes(targetLotAddress)) {
    score += 0.14;
    reasons.push("지번주소 일치");
  }
  if (exactSource) {
    score += 0.28;
    reasons.push("대표 지번 일치");
  }

  const expectedHouseholds = positiveInteger(normalizedMetadata.expectedHouseholds);
  const ledgerHouseholds = firstPositiveInteger(
    row?.hhldCnt,
    row?.totHhldCnt,
    row?.householdCnt
  );
  let householdRatio = null;
  if (expectedHouseholds && ledgerHouseholds) {
    householdRatio = Math.min(expectedHouseholds, ledgerHouseholds) /
      Math.max(expectedHouseholds, ledgerHouseholds);
    if (householdRatio >= 0.95) {
      score += 0.16;
      reasons.push("세대수 일치");
    } else if (householdRatio >= 0.75) {
      score += 0.08;
      reasons.push("세대수 유사");
    }
  }

  const targetApprovalDate = normalizeDate(normalizedMetadata.approvalDate);
  const ledgerApprovalDate = normalizeDate(row?.useAprDay || row?.useAprDate);
  let approvalYearDifference = null;
  if (targetApprovalDate && ledgerApprovalDate) {
    approvalYearDifference = Math.abs(
      Number(targetApprovalDate.slice(0, 4)) - Number(ledgerApprovalDate.slice(0, 4))
    );
    if (approvalYearDifference === 0) {
      score += 0.1;
      reasons.push("사용승인연도 일치");
    } else if (approvalYearDifference === 1) {
      score += 0.04;
      reasons.push("사용승인연도 인접");
    }
  }

  const componentType = classifyBuildingComponent(row);
  if (isApartmentComponentType(componentType)) {
    score += 0.05;
    reasons.push("아파트 용도");
  }

  return {
    score: Math.min(1, round(score, 6)),
    reasons,
    nameRequired: Boolean(targetName),
    nameSimilarity: round(nameSimilarity, 6),
    roadSimilarity: round(roadSimilarity, 6),
    householdRatio: householdRatio === null ? null : round(householdRatio, 6),
    approvalYearDifference,
    componentType,
    source,
  };
}

export function classifyBuildingComponent(row) {
  const mainPurpose = normalizeText(row?.mainPurpsCdNm || "");
  const etcPurpose = normalizeText(row?.etcPurps || "");
  const purpose = `${mainPurpose}${etcPurpose}`;
  if (!purpose) return "unknown";

  const hasApartment = purpose.includes("아파트");
  const hasCommunalHousing =
    mainPurpose.includes("공동주택") || etcPurpose === "공동주택";
  const hasExcludedHousing = EXCLUDED_HOUSING_MARKERS.some((marker) =>
    purpose.includes(marker)
  );
  const hasNonApartment = NON_APARTMENT_COMPONENT_MARKERS.some((marker) =>
    purpose.includes(marker)
  );
  if (hasApartment && hasExcludedHousing) return "apartment-mixed-housing";
  if (hasApartment && hasNonApartment) return "apartment-mixed-use";
  if (hasApartment) return "apartment";
  if (hasExcludedHousing) return "excluded-housing";
  if (hasCommunalHousing && !hasNonApartment) return "apartment-generic";
  return hasNonApartment ? "non-apartment" : "unknown";
}

export function sourceFromRow(row, fallback = {}) {
  return normalizeSource({
    sigunguCd: row?.sigunguCd || fallback.sigunguCd,
    bjdongCd: row?.bjdongCd || fallback.bjdongCd,
    platGbCd: row?.platGbCd ?? fallback.platGbCd,
    bun: row?.bun ?? fallback.bun,
    ji: row?.ji ?? fallback.ji,
  });
}

function sourcesFromAttachedRow(row, fallback) {
  const sources = [sourceFromRow(row, fallback)];
  const attached = normalizeSource({
    sigunguCd:
      row?.atchSigunguCd || row?.relSigunguCd || row?.sigunguCd || fallback.sigunguCd,
    bjdongCd:
      row?.atchBjdongCd || row?.relBjdongCd || row?.bjdongCd || fallback.bjdongCd,
    platGbCd:
      row?.atchPlatGbCd ?? row?.relPlatGbCd ?? row?.platGbCd ?? fallback.platGbCd,
    bun: row?.atchBun ?? row?.relBun,
    ji: row?.atchJi ?? row?.relJi,
  });
  if (attached.bun && attached.ji) sources.push(attached);
  return sources;
}

async function fetchAllPages(operation, source, fetchPage, maxPages) {
  const items = [];
  let totalCount = Number.POSITIVE_INFINITY;
  let pageNo = 1;
  while (items.length < totalCount && pageNo <= maxPages) {
    const page = await fetchPage(operation, source, pageNo, DISCOVERY_PAGE_SIZE);
    items.push(...page.items);
    totalCount = Math.max(0, Number(page.totalCount || items.length));
    if (!page.items.length || items.length >= totalCount) break;
    pageNo += 1;
  }
  return {
    items,
    totalCount: Number.isFinite(totalCount) ? totalCount : items.length,
    returnedPageSize: DISCOVERY_PAGE_SIZE,
    pages: pageNo,
    truncated: items.length < totalCount,
  };
}

function rankCandidates(entries, metadata, requestedSource) {
  const deduplicated = new Map();
  for (const entry of entries) {
    const source = sourceFromRow(entry.row, requestedSource);
    if (!isCompleteSource(source)) continue;
    const scoring = scoreBuildingLedgerRow(entry.row, metadata, requestedSource);
    const candidate = {
      ...entry,
      ...scoring,
      source,
      exactSource: entry.exactSource || sameSource(source, requestedSource),
    };
    const key = String(entry.row?.mgmBldrgstPk || sourceKey(source));
    const previous = deduplicated.get(key);
    if (!previous || candidate.score > previous.score) deduplicated.set(key, candidate);
  }
  return [...deduplicated.values()].sort(
    (left, right) =>
      right.score - left.score ||
      Number(right.exactSource) - Number(left.exactSource) ||
      sourceKey(left.source).localeCompare(sourceKey(right.source))
  );
}

function hasConfidentCandidate(ranked) {
  return ranked.some((candidate) => isConfidentCandidate(candidate));
}

function selectApartmentCandidates(ranked) {
  const apartmentCandidates = ranked.filter((candidate) =>
    isSelectableApartmentComponent(candidate.row)
  );
  if (!apartmentCandidates.length) return [];
  const buildingCandidates = apartmentCandidates.filter(
    (candidate) => candidate.operation === "getBrTitleInfo"
  );
  const selectionPool = buildingCandidates.length
    ? buildingCandidates
    : apartmentCandidates;

  const contextAnchor = ranked.find((candidate) => isConfidentCandidate(candidate));
  const apartmentAnchor =
    selectionPool.find((candidate) => isConfidentCandidate(candidate)) ||
    selectionPool.find((candidate) => isApartmentRescueCandidate(candidate));
  const anchor = contextAnchor || apartmentAnchor;
  if (!anchor) return [];

  return selectionPool.filter((candidate) => {
    if (!isRelatedCandidate(candidate, anchor)) return false;
    return (
      isConfidentCandidate(candidate) ||
      isApartmentRescueCandidate(candidate) ||
      sameSource(candidate.source, anchor.source)
    );
  });
}

function isSelectableApartmentComponent(row) {
  return isApartmentComponentType(classifyBuildingComponent(row));
}

function isApartmentRescueCandidate(candidate) {
  const buildingName = normalizeBuildingName(
    candidate.row?.bldNm || candidate.row?.etcPurps || ""
  );
  if (
    candidate.componentType === "apartment-generic" &&
    NON_APARTMENT_NAME_MARKERS.some((marker) =>
      buildingName.includes(normalizeBuildingName(marker))
    )
  ) {
    return false;
  }
  if (candidate.nameSimilarity >= 0.45 && candidate.exactSource) return true;
  if (
    candidate.exactSource &&
    candidate.roadSimilarity >= 0.85 &&
    candidate.approvalYearDifference === 0
  ) {
    return true;
  }
  return (
    candidate.exactSource &&
    candidate.approvalYearDifference === 0 &&
    Number(candidate.householdRatio || 0) >= 0.5
  );
}

function isApartmentComponentType(componentType) {
  return [
    "apartment",
    "apartment-generic",
    "apartment-mixed-use",
    "apartment-mixed-housing",
  ].includes(componentType);
}

function toComponentSelector(candidate) {
  return {
    managementPk: String(candidate.row?.mgmBldrgstPk || ""),
    buildingName: String(candidate.row?.bldNm || ""),
    dongName: String(candidate.row?.dongNm || ""),
    purpose: [
      String(candidate.row?.mainPurpsCdNm || "").trim(),
      String(candidate.row?.etcPurps || "").trim(),
    ]
      .filter(Boolean)
      .join(" / "),
    componentType:
      candidate.componentType || classifyBuildingComponent(candidate.row),
    source: candidate.source,
  };
}

function isRelatedCandidate(candidate, anchor) {
  if (sameSource(candidate.source, anchor.source)) return true;
  if (
    candidate.roadSimilarity >= 0.85 &&
    anchor.roadSimilarity >= 0.85
  ) {
    return true;
  }
  return (
    candidate.nameSimilarity >= 0.65 &&
    anchor.nameSimilarity >= 0.65
  );
}

function selectCandidates(ranked) {
  const best = ranked.find((candidate) => isConfidentCandidate(candidate));
  if (!best) return [];
  const bestName = normalizeBuildingName(best.row?.bldNm || best.row?.etcPurps || "");
  const bestRoad = normalizeAddress(best.row?.newPlatPlc || "");
  return ranked.filter((candidate) => {
    if (!isConfidentCandidate(candidate)) return false;
    if (candidate.score < best.score - 0.14) return false;
    const candidateName = normalizeBuildingName(
      candidate.row?.bldNm || candidate.row?.etcPurps || ""
    );
    const candidateRoad = normalizeAddress(candidate.row?.newPlatPlc || "");
    return (
      candidate.exactSource ||
      (bestName && candidateName && textSimilarity(bestName, candidateName) >= 0.72) ||
      (bestRoad && candidateRoad && textSimilarity(bestRoad, candidateRoad) >= 0.9)
    );
  });
}

function isConfidentCandidate(candidate) {
  const hasStrongName = candidate.nameSimilarity >= 0.65;
  const hasStrongRoad = candidate.roadSimilarity >= 0.85;
  if (candidate.nameRequired) {
    return hasStrongName && candidate.score >= 0.46;
  }
  if (hasStrongName) return candidate.score >= 0.46;
  if (hasStrongRoad) return candidate.score >= 0.42;
  return candidate.exactSource && candidate.score >= 0.33;
}

function toCandidateSummary(candidate) {
  return {
    managementPk: String(candidate.row?.mgmBldrgstPk || ""),
    buildingName: String(candidate.row?.bldNm || ""),
    dongName: String(candidate.row?.dongNm || ""),
    lotAddress: String(candidate.row?.platPlc || ""),
    roadAddress: String(candidate.row?.newPlatPlc || ""),
    approvalDate: normalizeDate(candidate.row?.useAprDay || candidate.row?.useAprDate),
    purpose: [
      String(candidate.row?.mainPurpsCdNm || "").trim(),
      String(candidate.row?.etcPurps || "").trim(),
    ]
      .filter(Boolean)
      .join(" / "),
    households: firstPositiveInteger(
      candidate.row?.hhldCnt,
      candidate.row?.totHhldCnt,
      candidate.row?.householdCnt
    ),
    source: candidate.source,
    operation: candidate.operation,
    scope: candidate.scope,
    score: candidate.score,
    componentType:
      candidate.componentType || classifyBuildingComponent(candidate.row),
    reasons: candidate.reasons,
  };
}

function discoveryEvidence(operation, scope, page, source = null) {
  return {
    operation,
    scope,
    source: source ? normalizeSource(source) : null,
    totalCount: Math.max(0, Number(page?.totalCount) || 0),
    returnedRows: Array.isArray(page?.items) ? page.items.length : 0,
    pages: Math.max(1, Number(page?.pages) || 1),
  };
}

function uniqueSources(sources) {
  const unique = new Map();
  for (const source of sources) {
    const normalized = normalizeSource(source);
    if (!isCompleteSource(normalized)) continue;
    unique.set(sourceKey(normalized), normalized);
  }
  return [...unique.values()];
}

function normalizeSource(source = {}) {
  return {
    sigunguCd: String(source.sigunguCd || "").trim(),
    bjdongCd: String(source.bjdongCd || "").trim(),
    platGbCd: String(source.platGbCd ?? "0").trim() || "0",
    bun: normalizeLotPart(source.bun),
    ji: normalizeLotPart(source.ji),
  };
}

function normalizeMetadata(metadata = {}) {
  return {
    complexName: String(metadata.complexName || "").trim(),
    roadAddress: String(metadata.roadAddress || "").trim(),
    lotAddress: String(metadata.lotAddress || "").trim(),
    approvalDate: normalizeDate(metadata.approvalDate),
    expectedHouseholds: positiveInteger(metadata.expectedHouseholds),
  };
}

function normalizeLotPart(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  const number = Number(text);
  return Number.isFinite(number) ? String(Math.max(0, number)).padStart(4, "0") : text;
}

function normalizeBuildingName(value) {
  return normalizeText(value)
    .replace(/^e편한세상/g, "이편한세상")
    .replace(/공동주택/g, "")
    .replace(/주상복합/g, "")
    .replace(/아파트/g, "")
    .replace(/신축공사/g, "")
    .replace(/재건축/g, "")
    .replace(/재개발/g, "");
}

function normalizeAddress(value) {
  return normalizeText(value)
    .replace(/서울특별시|서울시/g, "")
    .replace(/번지/g, "")
    .replace(/외\d*필지/g, "")
    .replace(/일대/g, "");
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function normalizeDate(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length >= 8 ? digits.slice(0, 8) : digits;
}

function textSimilarity(left, right) {
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) {
    return Math.min(left.length, right.length) / Math.max(left.length, right.length);
  }
  const leftBigrams = bigrams(left);
  const rightBigrams = bigrams(right);
  if (!leftBigrams.length || !rightBigrams.length) return 0;
  const rightCounts = new Map();
  rightBigrams.forEach((value) => rightCounts.set(value, (rightCounts.get(value) || 0) + 1));
  let intersection = 0;
  leftBigrams.forEach((value) => {
    const count = rightCounts.get(value) || 0;
    if (count > 0) {
      intersection += 1;
      rightCounts.set(value, count - 1);
    }
  });
  return (2 * intersection) / (leftBigrams.length + rightBigrams.length);
}

function bigrams(value) {
  if (value.length < 2) return [value];
  const result = [];
  for (let index = 0; index < value.length - 1; index += 1) {
    result.push(value.slice(index, index + 2));
  }
  return result;
}

function sourceKey(source) {
  return [
    source.sigunguCd,
    source.bjdongCd,
    source.platGbCd || "0",
    source.bun,
    source.ji,
  ].join(":");
}

function sameSource(left, right) {
  if (!isCompleteSource(left) || !isCompleteSource(right)) return false;
  return sourceKey(left) === sourceKey(right);
}

function isCompleteSource(source) {
  return Boolean(source?.sigunguCd && source?.bjdongCd && source?.bun && source?.ji);
}

function firstPositiveInteger(...values) {
  for (const value of values) {
    const parsed = positiveInteger(value);
    if (parsed) return parsed;
  }
  return null;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : null;
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}
