import { buildSupplyProfileFromPatterns } from "./supply-area.js";

const EXCLUSIVE_CODE = "1";
const COMMON_CODE = "2";
const APARTMENT_PURPOSE_CODE = "02001";
const APARTMENT_HOUSING_TYPE_CODE = "3";
const MATCH_TOLERANCE = 0.02;

export function buildPermitSupplyProfile({
  complexKey,
  source,
  service,
  typeRows,
  areaRows,
  expectedHouseholds = null,
  calculatedAt = new Date().toISOString(),
}) {
  const allTypeRows = Array.isArray(typeRows) ? typeRows : [];
  const allAreaRows = Array.isArray(areaRows) ? areaRows : [];
  const apartmentTypes = allTypeRows
    .filter(isApartmentTypeRow)
    .map(normalizeTypeRow)
    .filter((row) => row.unitCount > 0 && row.exclusiveArea > 0)
    .sort(compareTypeRows);
  const areaPatterns = buildAreaPatterns(allAreaRows);
  const matching = matchTypesToAreaPatterns(apartmentTypes, areaPatterns);
  const patterns = matching.matches.map(({ type, area }) => ({
    dong: "",
    exclusiveArea: round(type.exclusiveArea, 4),
    residentialCommonArea: round(area.residentialCommonArea, 4),
    supplyArea: round(area.supplyArea, 4),
    unitCount: type.unitCount,
    permitType: type.typeLabel,
    permitTypeOutlinePk: area.managementPk,
  }));
  const matchedHouseholds = patterns.reduce(
    (sum, pattern) => sum + pattern.unitCount,
    0
  );

  return buildSupplyProfileFromPatterns({
    complexKey,
    source,
    patterns,
    expectedHouseholds,
    calculatedAt,
    processedRows: allTypeRows.length + allAreaRows.length,
    sourceRows: allTypeRows.length + allAreaRows.length,
    filteredRows:
      allTypeRows.length - apartmentTypes.length +
      allAreaRows.length - areaPatterns.reduce((sum, item) => sum + item.rowCount, 0),
    processedUnits: matchedHouseholds,
    skippedUnits: matching.unmatchedTypes.reduce(
      (sum, row) => sum + row.unitCount,
      0
    ),
    provenance: {
      strategy: "permit-type-weighted",
      service,
      typeOperation:
        service === "housing-permit"
          ? "getHpMgmCoopTpOulnInfo"
          : "getApHsTpInfo",
      areaOperation:
        service === "housing-permit"
          ? "getHpExposPubuseAreaInfo"
          : "getApExposPubuseAreaInfo",
      sourceTypeRows: allTypeRows.length,
      sourceAreaRows: allAreaRows.length,
      apartmentTypeRows: apartmentTypes.length,
      apartmentAreaPatterns: areaPatterns.length,
      matchedTypeRows: matching.matches.length,
      unmatchedTypes: matching.unmatchedTypes.map((row) => ({
        typeLabel: row.typeLabel,
        exclusiveArea: row.exclusiveArea,
        unitCount: row.unitCount,
      })),
      unmatchedAreaPatterns: matching.unmatchedAreas.map((row) => ({
        managementPk: row.managementPk,
        exclusiveArea: row.exclusiveArea,
        supplyArea: row.supplyArea,
      })),
      duplicateMatchMethod: "natural-type-label-and-management-pk-order",
      includedCommonRule:
        "main-apartment-common-plus-apartment-pit-stair",
    },
  });
}

export function isPermitResidentialCommonRow(row) {
  if (String(row?.exposPubuseGbCd || "") !== COMMON_CODE) return false;
  const isMainApartmentCommon =
    String(row?.mainAtchGbCd || "") === "0" &&
    String(row?.purpsCd || "") === APARTMENT_PURPOSE_CODE;
  const purpose = normalizeText(row?.etcPurps);
  const isApartmentPitStair =
    purpose.includes("pit") && purpose.includes("\uacc4\ub2e8");
  return isMainApartmentCommon || isApartmentPitStair;
}

function buildAreaPatterns(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const key = String(row?.mgmTypeOulnPk || "").trim();
    if (!key) continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }

  return [...grouped.entries()]
    .map(([managementPk, groupRows]) => {
      const exclusiveRow = groupRows.find(
        (row) =>
          String(row?.exposPubuseGbCd || "") === EXCLUSIVE_CODE &&
          String(row?.purpsCd || "") === APARTMENT_PURPOSE_CODE
      );
      const exclusiveArea = positiveNumber(exclusiveRow?.area);
      if (!exclusiveArea) return null;
      const includedRows = groupRows.filter(isPermitResidentialCommonRow);
      const residentialCommonArea = includedRows.reduce(
        (sum, row) => sum + positiveNumber(row?.area),
        0
      );
      if (!residentialCommonArea) return null;
      return {
        managementPk,
        exclusiveArea,
        residentialCommonArea,
        supplyArea: exclusiveArea + residentialCommonArea,
        rowCount: groupRows.length,
      };
    })
    .filter(Boolean)
    .sort(compareAreaPatterns);
}

function matchTypesToAreaPatterns(types, areas) {
  const matches = [];
  const unmatchedTypes = [];
  const unusedAreas = new Set(areas);
  const typeGroups = groupByExclusiveArea(types);

  for (const typeGroup of typeGroups) {
    const candidates = areas
      .filter(
        (area) =>
          unusedAreas.has(area) &&
          Math.abs(area.exclusiveArea - typeGroup.exclusiveArea) <=
            MATCH_TOLERANCE
      )
      .sort(compareAreaPatterns);
    const sortedTypes = typeGroup.rows.slice().sort(compareTypeRows);
    for (let index = 0; index < sortedTypes.length; index += 1) {
      const type = sortedTypes[index];
      const area = candidates[index];
      if (!area) {
        unmatchedTypes.push(type);
        continue;
      }
      matches.push({ type, area });
      unusedAreas.delete(area);
    }
  }

  return {
    matches,
    unmatchedTypes,
    unmatchedAreas: [...unusedAreas],
  };
}

function groupByExclusiveArea(rows) {
  const groups = [];
  for (const row of rows) {
    let group = groups.find(
      (item) =>
        Math.abs(item.exclusiveArea - row.exclusiveArea) <= MATCH_TOLERANCE
    );
    if (!group) {
      group = { exclusiveArea: row.exclusiveArea, rows: [] };
      groups.push(group);
    }
    group.rows.push(row);
  }
  return groups.sort((left, right) => left.exclusiveArea - right.exclusiveArea);
}

function isApartmentTypeRow(row) {
  const unitCount = positiveInteger(row?.hhldCnt);
  if (!unitCount) return false;
  const code = String(row?.hsTypeGbCd || "").trim();
  const name = normalizeText(row?.hsTypeGbCdNm);
  return code === APARTMENT_HOUSING_TYPE_CODE || name.includes("\uc544\ud30c\ud2b8");
}

function normalizeTypeRow(row) {
  return {
    typeLabel: String(row?.typeGb || row?.etcType || "").trim(),
    exclusiveArea: positiveNumber(row?.exuseArea),
    unitCount: positiveInteger(row?.hhldCnt),
    rowNumber: positiveInteger(row?.rnum) || Number.MAX_SAFE_INTEGER,
  };
}

function compareTypeRows(left, right) {
  return (
    left.exclusiveArea - right.exclusiveArea ||
    naturalCompare(left.typeLabel, right.typeLabel) ||
    left.rowNumber - right.rowNumber
  );
}

function compareAreaPatterns(left, right) {
  return (
    left.exclusiveArea - right.exclusiveArea ||
    compareNumericText(left.managementPk, right.managementPk)
  );
}

function naturalCompare(left, right) {
  return String(left).localeCompare(String(right), "en", {
    numeric: true,
    sensitivity: "base",
  });
}

function compareNumericText(left, right) {
  try {
    const a = BigInt(String(left));
    const b = BigInt(String(right));
    return a < b ? -1 : a > b ? 1 : 0;
  } catch {
    return naturalCompare(left, right);
  }
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, "");
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}
