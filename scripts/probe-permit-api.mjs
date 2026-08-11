import { writeFile } from "node:fs/promises";
import { parseJsonPreservingLongIntegers } from "../functions/_shared/molit.js";

const SERVICE_KEY = process.env.MOLIT_SERVICE_KEY || "";
const REPORT_PATH = process.env.PERMIT_PROBE_REPORT_PATH || "permit-probe-report.json";
const RETRY_DELAYS = [0, 5_000, 15_000, 30_000];
const omitLot = process.env.PERMIT_PROBE_OMIT_LOT === "1";
const source = {
  sigunguCd: process.env.PERMIT_PROBE_SIGUNGU_CD || "11740",
  bjdongCd: process.env.PERMIT_PROBE_BJDONG_CD || "10300",
};
if (!omitLot) {
  source.platGbCd = process.env.PERMIT_PROBE_PLAT_GB_CD || "0";
  source.bun = process.env.PERMIT_PROBE_BUN || "0514";
  source.ji = process.env.PERMIT_PROBE_JI || "0000";
}

const endpoints = [
  {
    service: "building-permit",
    operation: "getApBasisOulnInfo",
    baseUrl: "https://apis.data.go.kr/1613000/ArchPmsHubService",
    discovery: true,
  },
  {
    service: "housing-permit",
    operation: "getHpBasisOulnInfo",
    baseUrl: "https://apis.data.go.kr/1613000/HsPmsHubService",
    discovery: true,
  },
  {
    service: "building-permit",
    operation: "getApHsTpInfo",
    baseUrl: "https://apis.data.go.kr/1613000/ArchPmsHubService",
  },
  {
    service: "building-permit",
    operation: "getApExposPubuseAreaInfo",
    baseUrl: "https://apis.data.go.kr/1613000/ArchPmsHubService",
  },
  {
    service: "housing-permit",
    operation: "getHpMgmCoopTpOulnInfo",
    baseUrl: "https://apis.data.go.kr/1613000/HsPmsHubService",
  },
  {
    service: "housing-permit",
    operation: "getHpExposPubuseAreaInfo",
    baseUrl: "https://apis.data.go.kr/1613000/HsPmsHubService",
  },
].filter((endpoint) => !omitLot || endpoint.discovery);

if (!SERVICE_KEY) throw new Error("MOLIT_SERVICE_KEY is required.");

const startedAt = new Date().toISOString();
const results = [];
for (const endpoint of endpoints) {
  const result = await probeWithRetry(endpoint);
  results.push(result);
  console.log(
    `${endpoint.operation}: HTTP ${result.httpStatus}, ` +
      `result=${result.resultCode || "-"}, rows=${result.returnedRows}/${result.totalCount}`
  );
}

const report = {
  version: "v2026.08.05-01-rc.1",
  startedAt,
  finishedAt: new Date().toISOString(),
  source,
  omitLot,
  results,
};
await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");

if (!results.some((result) => result.ok)) process.exitCode = 2;

async function probeWithRetry(endpoint) {
  let lastError;
  for (let attempt = 0; attempt < RETRY_DELAYS.length; attempt += 1) {
    if (RETRY_DELAYS[attempt]) await sleep(RETRY_DELAYS[attempt]);
    try {
      return {
        ...(await probeEndpoint(endpoint)),
        attempts: attempt + 1,
      };
    } catch (error) {
      lastError = error;
      console.warn(
        `${endpoint.operation}: ${attempt + 1}차 연결 실패 - ${error.message}`
      );
    }
  }
  return {
    service: endpoint.service,
    operation: endpoint.operation,
    ok: false,
    httpStatus: 0,
    resultCode: "NETWORK_ERROR",
    resultMessage: lastError?.message || "Permit API request failed.",
    totalCount: 0,
    returnedRows: 0,
    fields: [],
    samples: [],
    responsePreview: "",
    attempts: RETRY_DELAYS.length,
  };
}

async function probeEndpoint({ service, operation, baseUrl }) {
  const items = [];
  let pageNo = 1;
  let totalCount = Number.POSITIVE_INFINITY;
  let responseStatus = 0;
  let resultCode = "";
  let resultMessage = "";
  let responsePreview = "";

  while (items.length < totalCount) {
    const url = new URL(`${baseUrl}/${operation}`);
    url.searchParams.set("serviceKey", SERVICE_KEY);
    Object.entries(source).forEach(([key, value]) => url.searchParams.set(key, value));
    url.searchParams.set("_type", "json");
    url.searchParams.set("pageNo", String(pageNo));
    url.searchParams.set("numOfRows", "1000");

    const response = await fetch(url, {
      headers: { accept: "application/json, text/plain, */*" },
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    const payload = parsePayload(text);
    const header = payload?.response?.header || {};
    const body = payload?.response?.body || {};
    const pageItems = normalizeItems(body.items || body.item);
    responseStatus = response.status;
    resultCode = String(header.resultCode || extractXml(text, "resultCode") || "");
    resultMessage = String(
      header.resultMsg ||
        extractXml(text, "resultMsg") ||
        extractXml(text, "returnAuthMsg") ||
        ""
    );
    responsePreview = pageItems.length ? "" : compactText(text);
    if (!response.ok || (resultCode && !["00", "000"].includes(resultCode))) break;
    items.push(...pageItems);
    totalCount = Math.max(0, Number(body.totalCount || items.length));
    if (!pageItems.length || items.length >= totalCount) break;
    pageNo += 1;
  }

  return {
    service,
    operation,
    ok: responseStatus >= 200 && responseStatus < 300 &&
      (!resultCode || ["00", "000"].includes(resultCode)),
    httpStatus: responseStatus,
    resultCode,
    resultMessage,
    totalCount: Number.isFinite(totalCount) ? totalCount : 0,
    returnedRows: items.length,
    fields: [...new Set(items.flatMap((item) => Object.keys(item || {})))].sort(),
    records: items.slice(0, 2_000).map(sanitizeItem),
    responsePreview,
  };
}

function parsePayload(text) {
  try {
    return parseJsonPreservingLongIntegers(text);
  } catch {
    return {};
  }
}

function normalizeItems(items) {
  const item = items?.item || items;
  if (!item) return [];
  return Array.isArray(item) ? item : [item];
}

function sanitizeItem(item) {
  return Object.fromEntries(
    Object.entries(item || {}).filter(([, value]) => value !== null && value !== "")
  );
}

function extractXml(text, tagName) {
  const match = String(text || "").match(
    new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`)
  );
  return match ? match[1].trim() : "";
}

function compactText(text) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, 500);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
