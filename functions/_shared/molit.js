const RTMS_API_ENDPOINT = "https://apis.data.go.kr/1613000/RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade";
const APT_LIST_API_ENDPOINT = "https://apis.data.go.kr/1613000/AptListService3/getLegaldongAptList3";
const APT_BASIS_API_ENDPOINT = "https://apis.data.go.kr/1613000/AptBasisInfoServiceV4";
const BUILDING_HUB_API_ENDPOINT = "https://apis.data.go.kr/1613000/BldRgstHubService";

export function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": init.cacheControl || "no-store",
      ...(init.headers || {}),
    },
  });
}

export function errorJson(message, status = 400) {
  return json({ error: message }, { status });
}

export function requireServiceKey(env) {
  const serviceKey = env?.MOLIT_SERVICE_KEY || env?.RTMS_SERVICE_KEY || "";
  if (!serviceKey) {
    throw new Error("MOLIT_SERVICE_KEY is not configured.");
  }
  return serviceKey;
}

export function getSearchParam(request, key, fallback = "") {
  return new URL(request.url).searchParams.get(key) || fallback;
}

export function assertRequired(params) {
  const missing = Object.entries(params)
    .filter(([, value]) => value === null || value === undefined || value === "")
    .map(([key]) => key);
  if (missing.length) {
    throw new Error(`Missing required parameter: ${missing.join(", ")}`);
  }
}

export async function fetchJsonApi(url) {
  const response = await fetch(url.toString(), {
    headers: { accept: "application/json, text/plain, */*" },
  });
  if (!response.ok) {
    throw new Error(`MOLIT API responded with ${response.status}.`);
  }
  const text = await response.text();
  if (!text.trim()) return {};
  return JSON.parse(text);
}

export async function fetchTextApi(url) {
  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`MOLIT API responded with ${response.status}.`);
  }
  return response.text();
}

export function normalizeItems(items) {
  if (!items) return [];
  const item = items.item || items;
  if (!item) return [];
  return Array.isArray(item) ? item : [item];
}

export function buildAptListUrl({ serviceKey, bjdCode, pageNo = "1", numOfRows = "200" }) {
  const url = new URL(APT_LIST_API_ENDPOINT);
  url.searchParams.set("serviceKey", serviceKey);
  url.searchParams.set("bjdCode", bjdCode);
  url.searchParams.set("pageNo", pageNo);
  url.searchParams.set("numOfRows", numOfRows);
  return url;
}

export function buildAptBasisUrl({ serviceKey, operation, kaptCode }) {
  const url = new URL(`${APT_BASIS_API_ENDPOINT}/${operation}`);
  url.searchParams.set("serviceKey", serviceKey);
  url.searchParams.set("kaptCode", kaptCode);
  return url;
}

export function buildBuildingHubUrl({ serviceKey, operation, params }) {
  const url = new URL(`${BUILDING_HUB_API_ENDPOINT}/${operation}`);
  url.searchParams.set("serviceKey", serviceKey);
  url.searchParams.set("sigunguCd", params.sigunguCd);
  url.searchParams.set("bjdongCd", params.bjdongCd);
  url.searchParams.set("platGbCd", params.platGbCd || "0");
  url.searchParams.set("bun", params.bun);
  url.searchParams.set("ji", params.ji);
  url.searchParams.set("_type", "json");
  url.searchParams.set("numOfRows", params.numOfRows || "100");
  url.searchParams.set("pageNo", params.pageNo || "1");
  return url;
}

export function buildRtmsUrl({ serviceKey, lawdCd, dealYmd, pageNo = "1", numOfRows = "1000" }) {
  const url = new URL(RTMS_API_ENDPOINT);
  url.searchParams.set("serviceKey", serviceKey);
  url.searchParams.set("LAWD_CD", lawdCd);
  url.searchParams.set("DEAL_YMD", dealYmd);
  url.searchParams.set("pageNo", pageNo);
  url.searchParams.set("numOfRows", numOfRows);
  return url;
}

export function parseRtmsXml(xmlText) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xmlText))) {
    const itemText = match[1];
    items.push({
      aptNm: textFromXml(itemText, "aptNm"),
      buildYear: textFromXml(itemText, "buildYear"),
      dealAmount: textFromXml(itemText, "dealAmount"),
      dealDay: textFromXml(itemText, "dealDay"),
      dealMonth: textFromXml(itemText, "dealMonth"),
      dealYear: textFromXml(itemText, "dealYear"),
      excluUseAr: textFromXml(itemText, "excluUseAr"),
      floor: textFromXml(itemText, "floor"),
      jibun: textFromXml(itemText, "jibun"),
      sggCd: textFromXml(itemText, "sggCd"),
      umdNm: textFromXml(itemText, "umdNm"),
      aptDong: textFromXml(itemText, "aptDong"),
    });
  }
  return items;
}

function textFromXml(xmlText, tagName) {
  const match = xmlText.match(new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`));
  return match ? decodeXml(match[1].trim()) : "";
}

function decodeXml(value) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
