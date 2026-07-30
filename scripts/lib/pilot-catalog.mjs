export const PILOT_SIDO_NAME = "서울특별시";
export const PILOT_APPROVAL_DATE = "20200101";
export const PILOT_MIN_HOUSEHOLDS = 200;
export const PILOT_TRADE_LOOKBACK_MONTHS = 24;
export const PILOT_CATALOG_VERSION = "seoul-sale-apartment-v2";

const EXCLUDED_HOUSING_MARKERS = [
  "도시형생활주택",
  "청년안심주택",
  "역세권청년주택",
  "공공임대",
  "국민임대",
  "영구임대",
  "행복주택",
  "장기전세",
  "매입임대",
];

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      row.push(value);
      value = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(value);
      if (row.some((item) => item !== "")) rows.push(row);
      row = [];
      value = "";
    } else {
      value += character;
    }
  }

  if (value || row.length) {
    row.push(value);
    rows.push(row);
  }

  if (!rows.length) return [];
  const headers = rows[0].map((header) => header.replace(/^\uFEFF/, "").trim());
  return rows.slice(1).map((values) =>
    Object.fromEntries(headers.map((header, index) => [header, values[index] || ""]))
  );
}

export function selectSeoulLegalDongs(records) {
  return records
    .filter(
      (record) =>
        record["시도명"] === PILOT_SIDO_NAME &&
        record["시군구명"] &&
        record["읍면동명"] &&
        !record["리명"] &&
        /^\d{10}$/.test(String(record["법정동코드"] || ""))
    )
    .map((record) => ({
      bjdCode: String(record["법정동코드"]),
      sidoName: record["시도명"],
      sigunguName: record["시군구명"],
      eupmyeondongName: record["읍면동명"],
    }))
    .sort((left, right) => left.bjdCode.localeCompare(right.bjdCode));
}

export function buildPilotCatalogEntry(candidate, basicInfo, discoveredAt = new Date().toISOString()) {
  const kaptCode = String(basicInfo.kaptCode || candidate.kaptCode || "").trim();
  const bjdCode = String(basicInfo.bjdCode || candidate.bjdCode || "").trim();
  const approvalDate = normalizeYmd(basicInfo.kaptUsedate);
  const households = parseInteger(basicInfo.kaptdaCnt);
  const apartmentType = String(basicInfo.codeAptNm || "").trim();
  const saleType = String(basicInfo.codeSaleNm || "").trim();
  const complexName = String(basicInfo.kaptName || candidate.kaptName || "").trim();
  const lotAddress = String(basicInfo.kaptAddr || "").trim();
  const lot = parseLotAddress(lotAddress, candidate.as3 || candidate.as4 || "");

  const exclusionReasons = [];
  if (!kaptCode) exclusionReasons.push("missing-kapt-code");
  if (!/^11\d{8}$/.test(bjdCode)) exclusionReasons.push("not-seoul");
  if (approvalDate < PILOT_APPROVAL_DATE) exclusionReasons.push("built-before-2020");
  if (households < PILOT_MIN_HOUSEHOLDS) exclusionReasons.push("under-200-households");
  if (!isApartmentType(apartmentType)) exclusionReasons.push("unsupported-housing-type");
  if (hasExcludedHousingProgram({ complexName, apartmentType, saleType })) {
    exclusionReasons.push("excluded-housing-program");
  }
  if (!isSaleTenure(saleType)) exclusionReasons.push("non-sale-tenure");
  if (!lot) exclusionReasons.push("unmapped-lot");

  const eligible = exclusionReasons.length === 0;
  return {
    eligible,
    exclusionReasons,
    complexKey: kaptCode ? `aptlist-${kaptCode}` : "",
    kaptCode,
    complexName,
    bjdCode,
    sidoName: String(candidate.as1 || PILOT_SIDO_NAME).trim(),
    sigunguName: String(candidate.as2 || "").trim(),
    eupmyeondongName: String(candidate.as3 || candidate.as4 || "").trim(),
    apartmentType,
    saleType,
    approvalDate,
    households,
    buildingCount: parseInteger(basicInfo.kaptDongCnt),
    lotAddress,
    roadAddress: String(basicInfo.doroJuso || "").trim(),
    platGbCd: lot?.platGbCd || "0",
    bun: lot?.bun || "",
    ji: lot?.ji || "",
    tradeMatched: false,
    tradeMatchCount: 0,
    tradeMatchMethod: "",
    lastTradeDate: "",
    discoveredAt,
  };
}

export function attachRtmsMatch(entry, items) {
  if (!entry.eligible) return entry;

  const matches = (Array.isArray(items) ? items : [])
    .map((item) => ({ item, method: getRtmsMatchMethod(entry, item) }))
    .filter((match) => match.method);
  if (!matches.length) {
    return {
      ...entry,
      eligible: false,
      exclusionReasons: [...entry.exclusionReasons, "no-apartment-sale-trade-match"],
    };
  }

  const methods = new Set(matches.map((match) => match.method));
  const lastTradeDate = matches
    .map(({ item }) => formatTradeDate(item))
    .filter(Boolean)
    .sort()
    .at(-1) || "";
  return {
    ...entry,
    tradeMatched: true,
    tradeMatchCount: matches.length,
    tradeMatchMethod:
      methods.has("lot+name") ? "lot+name" : methods.has("lot") ? "lot" : "name",
    lastTradeDate,
  };
}

export function sortPilotCatalog(entries) {
  return entries
    .slice()
    .sort(
      (left, right) =>
        right.approvalDate.localeCompare(left.approvalDate) ||
        right.households - left.households ||
        left.kaptCode.localeCompare(right.kaptCode)
    )
    .map((entry, index) => ({ ...entry, priorityRank: index + 1 }));
}

export function parseLotAddress(address, legalDongName = "") {
  const normalized = String(address || "").replace(/\s+/g, " ").trim();
  if (!normalized) return null;

  let tail = normalized;
  const legalDongIndex = legalDongName ? normalized.lastIndexOf(legalDongName) : -1;
  if (legalDongIndex >= 0) {
    tail = normalized.slice(legalDongIndex + legalDongName.length).trim();
  }

  const match = tail.match(/^(산\s*)?(\d{1,4})(?:-(\d{1,4}))?(?=\s|$)/);
  if (!match) return null;
  return {
    platGbCd: match[1] ? "1" : "0",
    bun: match[2].padStart(4, "0"),
    ji: String(match[3] || "0").padStart(4, "0"),
  };
}

export function isApartmentType(value) {
  const normalized = normalizeText(value);
  if (EXCLUDED_HOUSING_MARKERS.some((marker) => normalized.includes(marker))) {
    return false;
  }
  return normalized === "아파트" || normalized.includes("주상복합");
}

export function isSaleTenure(value) {
  return normalizeText(value).includes("분양");
}

export function hasExcludedHousingProgram({
  complexName = "",
  apartmentType = "",
  saleType = "",
} = {}) {
  const combined = normalizeText(`${complexName} ${apartmentType} ${saleType}`);
  return EXCLUDED_HOUSING_MARKERS.some((marker) => combined.includes(marker));
}

export function buildRecentDealMonths(referenceDate = new Date(), count = PILOT_TRADE_LOOKBACK_MONTHS) {
  const date = referenceDate instanceof Date ? referenceDate : new Date(referenceDate);
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid reference date.");
  const months = [];
  for (let offset = 0; offset < count; offset += 1) {
    const value = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - offset, 1));
    months.push(
      `${value.getUTCFullYear()}${String(value.getUTCMonth() + 1).padStart(2, "0")}`
    );
  }
  return months;
}

function normalizeYmd(value) {
  const digits = String(value || "").replace(/\D/g, "").slice(0, 8);
  return /^\d{8}$/.test(digits) ? digits : "";
}

function parseInteger(value) {
  const number = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function getRtmsMatchMethod(entry, item) {
  const candidateDong = normalizeText(entry.eupmyeondongName);
  const itemDong = normalizeText(item?.umdNm);
  if (!candidateDong || !itemDong || candidateDong !== itemDong) return "";

  const candidateLot = formatLotNumber(entry.bun, entry.ji);
  const itemLot = normalizeLotNumber(item?.jibun);
  const lotMatch = candidateLot && itemLot && candidateLot === itemLot;

  const candidateName = normalizeApartmentName(entry.complexName);
  const itemName = normalizeApartmentName(item?.aptNm);
  const shorterNameLength = Math.min(candidateName.length, itemName.length);
  const longerNameLength = Math.max(candidateName.length, itemName.length);
  const nameMatch =
    candidateName.length >= 3 &&
    itemName.length >= 3 &&
    (candidateName === itemName ||
      ((candidateName.includes(itemName) || itemName.includes(candidateName)) &&
        shorterNameLength / longerNameLength >= 0.65));

  if (lotMatch && nameMatch) return "lot+name";
  if (lotMatch) return "lot";
  if (nameMatch) return "name";
  return "";
}

function normalizeApartmentName(value) {
  return normalizeText(value)
    .replace(/아파트/g, "")
    .replace(/단지/g, "")
    .replace(/맨션/g, "")
    .replace(/[^가-힣a-z0-9]/g, "");
}

function formatLotNumber(bun, ji) {
  const main = String(Number(bun || 0));
  const sub = Number(ji || 0);
  return main && main !== "0" ? (sub ? `${main}-${sub}` : main) : "";
}

function normalizeLotNumber(value) {
  const match = String(value || "").match(/(\d{1,4})(?:-(\d{1,4}))?/);
  if (!match) return "";
  const main = String(Number(match[1]));
  const sub = Number(match[2] || 0);
  return sub ? `${main}-${sub}` : main;
}

function formatTradeDate(item) {
  const year = String(item?.dealYear || "").padStart(4, "0");
  const month = String(item?.dealMonth || "").padStart(2, "0");
  const day = String(item?.dealDay || "").padStart(2, "0");
  return /^\d{8}$/.test(`${year}${month}${day}`) ? `${year}${month}${day}` : "";
}

function normalizeText(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, "");
}
