export const PILOT_SIDO_NAME = "서울특별시";
export const PILOT_APPROVAL_DATE = "20200101";
export const PILOT_MIN_HOUSEHOLDS = 200;

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
  const lotAddress = String(basicInfo.kaptAddr || "").trim();
  const lot = parseLotAddress(lotAddress, candidate.as3 || candidate.as4 || "");

  const exclusionReasons = [];
  if (!kaptCode) exclusionReasons.push("missing-kapt-code");
  if (!/^11\d{8}$/.test(bjdCode)) exclusionReasons.push("not-seoul");
  if (approvalDate < PILOT_APPROVAL_DATE) exclusionReasons.push("built-before-2020");
  if (households < PILOT_MIN_HOUSEHOLDS) exclusionReasons.push("under-200-households");
  if (!isApartmentType(apartmentType)) exclusionReasons.push("non-apartment");
  if (!lot) exclusionReasons.push("unmapped-lot");

  const eligible = exclusionReasons.length === 0;
  return {
    eligible,
    exclusionReasons,
    complexKey: kaptCode ? `aptlist-${kaptCode}` : "",
    kaptCode,
    complexName: String(basicInfo.kaptName || candidate.kaptName || "").trim(),
    bjdCode,
    sidoName: String(candidate.as1 || PILOT_SIDO_NAME).trim(),
    sigunguName: String(candidate.as2 || "").trim(),
    eupmyeondongName: String(candidate.as3 || candidate.as4 || "").trim(),
    apartmentType,
    approvalDate,
    households,
    buildingCount: parseInteger(basicInfo.kaptDongCnt),
    lotAddress,
    roadAddress: String(basicInfo.doroJuso || "").trim(),
    platGbCd: lot?.platGbCd || "0",
    bun: lot?.bun || "",
    ji: lot?.ji || "",
    discoveredAt,
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
  const normalized = String(value || "").replace(/\s+/g, "");
  return normalized.includes("아파트") || normalized.includes("주상복합");
}

function normalizeYmd(value) {
  const digits = String(value || "").replace(/\D/g, "").slice(0, 8);
  return /^\d{8}$/.test(digits) ? digits : "";
}

function parseInteger(value) {
  const number = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}
