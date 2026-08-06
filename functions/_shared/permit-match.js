const APARTMENT_PURPOSE_MARKERS = ["아파트", "공동주택", "주상복합"];
const NON_APARTMENT_MARKERS = [
  "오피스텔",
  "도시형생활주택",
  "청년안심주택",
  "공공임대",
  "국민임대",
  "행복주택",
];

export function resolvePermitSourcesFromBasisRows({
  rows,
  metadata = {},
  requestedSource = {},
  maxSources = 8,
}) {
  const ranked = (Array.isArray(rows) ? rows : [])
    .map((row) => scorePermitBasisRow(row, metadata, requestedSource))
    .filter((candidate) => candidate.accepted)
    .sort(
      (left, right) =>
        right.score - left.score ||
        Math.abs(left.householdDifference ?? Number.MAX_SAFE_INTEGER) -
          Math.abs(right.householdDifference ?? Number.MAX_SAFE_INTEGER)
    );
  const unique = new Map();
  for (const candidate of ranked) {
    const key = sourceKey(candidate.source);
    if (!key || unique.has(key)) continue;
    unique.set(key, candidate);
    if (unique.size >= maxSources) break;
  }
  return {
    sources: [...unique.values()].map((candidate) => candidate.source),
    candidates: [...unique.values()].map((candidate) => ({
      source: candidate.source,
      score: round(candidate.score, 4),
      reasons: candidate.reasons,
      buildingName: candidate.buildingName,
      projectName: candidate.projectName,
      households: candidate.households,
      householdDifference: candidate.householdDifference,
      approvalDate: candidate.approvalDate,
      purpose: candidate.purpose,
      managementPk: String(candidate.row?.mgmPmsrgstPk || ""),
    })),
  };
}

export function scorePermitBasisRow(row, metadata = {}, requestedSource = {}) {
  const source = sourceFromPermitRow(row);
  const targetName = normalizeName(metadata.complexName);
  const buildingName = String(row?.bldNm || "").trim();
  const projectName = String(row?.splotNm || "").trim();
  const rowName = normalizeName(`${buildingName} ${projectName}`);
  const expectedHouseholds = positiveInteger(metadata.expectedHouseholds);
  const households = positiveInteger(
    row?.hhldCnt ?? row?.hoCnt ?? row?.fmlyCnt
  );
  const householdDifference =
    expectedHouseholds && households ? households - expectedHouseholds : null;
  const householdRate =
    expectedHouseholds && households
      ? Math.abs(householdDifference) / expectedHouseholds
      : null;
  const approvalDate = normalizeDate(
    row?.useAprDay || row?.realStcnsDay || row?.archPmsDay
  );
  const targetDate = normalizeDate(metadata.approvalDate);
  const dateDifferenceDays = dateDistanceDays(approvalDate, targetDate);
  const purpose = `${row?.mainPurpsCdNm || ""} ${row?.etcPurps || ""}`.trim();
  const normalizedPurpose = normalizeText(purpose);
  const nameSimilarity = textSimilarity(rowName, targetName);
  const sameRequestedLot = sameSource(source, requestedSource);
  const reasons = [];
  let score = 0;

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

  if (householdRate !== null) {
    if (householdDifference === 0) {
      score += 0.34;
      reasons.push("세대수 일치");
    } else if (householdRate <= 0.01) {
      score += 0.3;
      reasons.push("세대수 1% 이내");
    } else if (householdRate <= 0.05) {
      score += 0.16;
      reasons.push("세대수 5% 이내");
    }
  }

  if (dateDifferenceDays !== null) {
    if (dateDifferenceDays <= 31) {
      score += 0.24;
      reasons.push("사용승인일 31일 이내");
    } else if (dateDifferenceDays <= 366) {
      score += 0.14;
      reasons.push("사용승인일 1년 이내");
    }
  }

  const apartmentPurpose = APARTMENT_PURPOSE_MARKERS.some((marker) =>
    normalizedPurpose.includes(normalizeText(marker))
  );
  const excludedPurpose =
    !apartmentPurpose &&
    NON_APARTMENT_MARKERS.some((marker) =>
      normalizedPurpose.includes(normalizeText(marker))
    );
  if (apartmentPurpose && !excludedPurpose) {
    score += 0.1;
    reasons.push("아파트 용도");
  }
  if (sameRequestedLot) {
    score += 0.08;
    reasons.push("대표 지번 일치");
  }

  const strongName =
    rowName && targetName &&
    (rowName.includes(targetName) || targetName.includes(rowName) || nameSimilarity >= 0.72);
  const strongFacts =
    householdRate !== null &&
    householdRate <= 0.01 &&
    dateDifferenceDays !== null &&
    dateDifferenceDays <= 366;
  const accepted =
    isCompleteSource(source) &&
    !excludedPurpose &&
    score >= 0.52 &&
    (strongName || strongFacts);

  return {
    row,
    source,
    score,
    accepted,
    reasons,
    buildingName,
    projectName,
    households,
    householdDifference,
    approvalDate,
    purpose,
  };
}

function sourceFromPermitRow(row = {}) {
  return {
    sigunguCd: String(row.sigunguCd || "").trim(),
    bjdongCd: String(row.bjdongCd || "").trim(),
    platGbCd: String(row.platGbCd ?? "0").trim() || "0",
    bun: normalizeLotPart(row.bun),
    ji: normalizeLotPart(row.ji),
  };
}

function normalizeLotPart(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  return text.padStart(4, "0");
}

function isCompleteSource(source) {
  return Boolean(source.sigunguCd && source.bjdongCd && source.bun && source.ji);
}

function sameSource(left, right = {}) {
  return sourceKey(left) === sourceKey({
    sigunguCd: String(right.sigunguCd || "").trim(),
    bjdongCd: String(right.bjdongCd || "").trim(),
    platGbCd: String(right.platGbCd ?? "0").trim() || "0",
    bun: normalizeLotPart(right.bun),
    ji: normalizeLotPart(right.ji),
  });
}

function sourceKey(source) {
  if (!isCompleteSource(source)) return "";
  return [
    source.sigunguCd,
    source.bjdongCd,
    source.platGbCd || "0",
    source.bun,
    source.ji,
  ].join("-");
}

function normalizeName(value) {
  return normalizeText(value)
    .replace(/아파트/g, "")
    .trim();
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^0-9a-z가-힣]/g, "");
}

function textSimilarity(left, right) {
  if (!left || !right) return 0;
  if (left === right) return 1;
  const leftPairs = bigrams(left);
  const rightPairs = bigrams(right);
  if (!leftPairs.length || !rightPairs.length) return 0;
  const counts = new Map();
  for (const pair of leftPairs) counts.set(pair, (counts.get(pair) || 0) + 1);
  let intersection = 0;
  for (const pair of rightPairs) {
    const count = counts.get(pair) || 0;
    if (!count) continue;
    intersection += 1;
    counts.set(pair, count - 1);
  }
  return (2 * intersection) / (leftPairs.length + rightPairs.length);
}

function bigrams(value) {
  if (value.length < 2) return [value];
  const pairs = [];
  for (let index = 0; index < value.length - 1; index += 1) {
    pairs.push(value.slice(index, index + 2));
  }
  return pairs;
}

function positiveInteger(value) {
  const number = Math.round(Number(value) || 0);
  return number > 0 ? number : null;
}

function normalizeDate(value) {
  const digits = String(value || "").replace(/\D/g, "").slice(0, 8);
  return /^\d{8}$/.test(digits) ? digits : "";
}

function dateDistanceDays(left, right) {
  if (!left || !right) return null;
  const leftDate = Date.UTC(
    Number(left.slice(0, 4)),
    Number(left.slice(4, 6)) - 1,
    Number(left.slice(6, 8))
  );
  const rightDate = Date.UTC(
    Number(right.slice(0, 4)),
    Number(right.slice(4, 6)) - 1,
    Number(right.slice(6, 8))
  );
  return Math.round(Math.abs(leftDate - rightDate) / 86_400_000);
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
