import { writeFile } from "node:fs/promises";

const SERVICE_KEY = process.env.MOLIT_SERVICE_KEY || "";
const REPORT_PATH = process.env.PERMIT_PROBE_REPORT_PATH || "permit-probe-report.json";
const RETRY_DELAYS = [0, 5_000, 15_000, 30_000];
const source = {
  sigunguCd: process.env.PERMIT_PROBE_SIGUNGU_CD || "11740",
  bjdongCd: process.env.PERMIT_PROBE_BJDONG_CD || "10300",
  platGbCd: process.env.PERMIT_PROBE_PLAT_GB_CD || "0",
  bun: process.env.PERMIT_PROBE_BUN || "0514",
  ji: process.env.PERMIT_PROBE_JI || "0000",
};

const endpoints = [
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
];

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
  const url = new URL(`${baseUrl}/${operation}`);
  url.searchParams.set("serviceKey", SERVICE_KEY);
  Object.entries(source).forEach(([key, value]) => url.searchParams.set(key, value));
  url.searchParams.set("_type", "json");
  url.searchParams.set("pageNo", "1");
  url.searchParams.set("numOfRows", "1000");

  const response = await fetch(url, {
    headers: { accept: "application/json, text/plain, */*" },
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  const payload = parsePayload(text);
  const header = payload?.response?.header || {};
  const body = payload?.response?.body || {};
  const items = normalizeItems(body.items || body.item);
  const resultCode = String(header.resultCode || extractXml(text, "resultCode") || "");
  const resultMessage = String(
    header.resultMsg ||
      extractXml(text, "resultMsg") ||
      extractXml(text, "returnAuthMsg") ||
      ""
  );

  return {
    service,
    operation,
    ok: response.ok && (!resultCode || ["00", "000"].includes(resultCode)),
    httpStatus: response.status,
    resultCode,
    resultMessage,
    totalCount: Math.max(0, Number(body.totalCount || 0)),
    returnedRows: items.length,
    fields: [...new Set(items.flatMap((item) => Object.keys(item || {})))].sort(),
    samples: items.slice(0, 20).map(sanitizeItem),
    responsePreview: items.length ? "" : compactText(text),
  };
}

function parsePayload(text) {
  try {
    return JSON.parse(text);
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
