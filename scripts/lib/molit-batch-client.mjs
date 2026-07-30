import {
  buildRtmsUrl,
  parseRtmsXml,
} from "../../functions/_shared/molit.js";

const APT_LIST_ENDPOINT =
  "https://apis.data.go.kr/1613000/AptListService3/getLegaldongAptList3";
const APT_BASIS_ENDPOINT =
  "https://apis.data.go.kr/1613000/AptBasisInfoServiceV4/getAphusBassInfoV4";
const RETRY_DELAYS = [1_000, 3_000, 10_000];
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export function createMolitBatchClient({
  serviceKey,
  fetchImpl = globalThis.fetch,
  onRequest = () => {},
  timeoutMs = 30_000,
}) {
  if (!serviceKey) throw new Error("MOLIT_SERVICE_KEY is required.");
  if (typeof fetchImpl !== "function") throw new Error("fetch is not available.");

  return {
    async fetchAptListForDong(bjdCode) {
      const rows = [];
      let pageNo = 1;
      let totalCount = Number.POSITIVE_INFINITY;
      const numOfRows = 200;

      while (rows.length < totalCount) {
        const url = new URL(APT_LIST_ENDPOINT);
        url.searchParams.set("serviceKey", serviceKey);
        url.searchParams.set("bjdCode", bjdCode);
        url.searchParams.set("pageNo", String(pageNo));
        url.searchParams.set("numOfRows", String(numOfRows));
        const payload = await fetchJsonWithRetry(url, {
          fetchImpl,
          onRequest,
          timeoutMs,
          operation: "apt-list",
        });
        const body = assertApiSuccess(payload, "AptList");
        const items = normalizeItems(body.items).map((item) => ({
          kaptCode: String(item.kaptCode || ""),
          kaptName: String(item.kaptName || ""),
          bjdCode: String(item.bjdCode || bjdCode),
          as1: String(item.as1 || ""),
          as2: String(item.as2 || ""),
          as3: String(item.as3 || ""),
          as4: String(item.as4 || ""),
        }));
        rows.push(...items);
        totalCount = Math.max(0, Number(body.totalCount || rows.length));
        if (!items.length || rows.length >= totalCount) break;
        pageNo += 1;
      }
      return rows;
    },

    async fetchAptBasicInfo(kaptCode) {
      const url = new URL(APT_BASIS_ENDPOINT);
      url.searchParams.set("serviceKey", serviceKey);
      url.searchParams.set("kaptCode", kaptCode);
      const payload = await fetchJsonWithRetry(url, {
        fetchImpl,
        onRequest,
        timeoutMs,
        operation: "apt-basis",
      });
      return assertApiSuccess(payload, "AptBasis").item || {};
    },

    async fetchRtmsTrades(lawdCd, dealYmd) {
      const rows = [];
      let pageNo = 1;
      let totalCount = Number.POSITIVE_INFINITY;
      const numOfRows = 1000;

      while (rows.length < totalCount) {
        const url = buildRtmsUrl({
          serviceKey,
          lawdCd,
          dealYmd,
          pageNo: String(pageNo),
          numOfRows: String(numOfRows),
        });
        const xml = await fetchTextWithRetry(url, {
          fetchImpl,
          onRequest,
          timeoutMs,
          operation: "rtms-trade",
        });
        assertXmlApiSuccess(xml, "RTMS");
        const items = parseRtmsXml(xml);
        rows.push(...items);
        totalCount = Math.max(0, Number(textFromXml(xml, "totalCount") || rows.length));
        if (!items.length || rows.length >= totalCount) break;
        pageNo += 1;
      }
      return rows;
    },
  };
}

async function fetchJsonWithRetry(
  url,
  { fetchImpl, onRequest, timeoutMs, operation }
) {
  let lastError;
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt += 1) {
    if (attempt > 0) await sleep(RETRY_DELAYS[attempt - 1]);
    onRequest({ operation, attempt: attempt + 1 });
    try {
      const response = await fetchImpl(url.toString(), {
        headers: { accept: "application/json, text/plain, */*" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      if (!response.ok) {
        const error = new Error(`${operation} responded with HTTP ${response.status}.`);
        error.retryable = RETRYABLE_STATUSES.has(response.status);
        throw error;
      }
      return text.trim() ? JSON.parse(text) : {};
    } catch (error) {
      lastError = sanitizeFetchError(error, operation);
      if (error?.retryable === false || attempt === RETRY_DELAYS.length) break;
    }
  }
  throw lastError;
}

async function fetchTextWithRetry(
  url,
  { fetchImpl, onRequest, timeoutMs, operation }
) {
  let lastError;
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt += 1) {
    if (attempt > 0) await sleep(RETRY_DELAYS[attempt - 1]);
    onRequest({ operation, attempt: attempt + 1 });
    try {
      const response = await fetchImpl(url.toString(), {
        headers: { accept: "application/xml, text/xml, text/plain, */*" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      if (!response.ok) {
        const error = new Error(`${operation} responded with HTTP ${response.status}.`);
        error.retryable = RETRYABLE_STATUSES.has(response.status);
        throw error;
      }
      return text;
    } catch (error) {
      lastError = sanitizeFetchError(error, operation);
      if (error?.retryable === false || attempt === RETRY_DELAYS.length) break;
    }
  }
  throw lastError;
}

function assertApiSuccess(payload, apiName) {
  const header = payload?.response?.header || {};
  const resultCode = String(header.resultCode || "");
  if (resultCode && !["00", "000"].includes(resultCode)) {
    const error = new Error(
      `${apiName} API error ${resultCode}: ${header.resultMsg || "Unknown error"}`
    );
    error.retryable = !["20", "22", "30", "31"].includes(resultCode);
    throw error;
  }
  return payload?.response?.body || {};
}

function assertXmlApiSuccess(xml, apiName) {
  const resultCode = textFromXml(xml, "resultCode");
  if (resultCode && !["00", "000"].includes(resultCode)) {
    const error = new Error(
      `${apiName} API error ${resultCode}: ${textFromXml(xml, "resultMsg") || "Unknown error"}`
    );
    error.retryable = !["20", "22", "30", "31"].includes(resultCode);
    throw error;
  }
}

function normalizeItems(items) {
  const item = items?.item || items;
  if (!item) return [];
  return Array.isArray(item) ? item : [item];
}

function sanitizeFetchError(error, operation) {
  const isTimeout = error?.name === "TimeoutError" || error?.name === "AbortError";
  const result = new Error(
    isTimeout ? `${operation} timed out.` : error?.message || `${operation} failed.`
  );
  result.retryable = error?.retryable !== false;
  return result;
}

function textFromXml(xmlText, tagName) {
  const match = String(xmlText || "").match(
    new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`)
  );
  return match ? match[1].trim() : "";
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
