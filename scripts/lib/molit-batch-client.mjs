import {
  buildBuildingHubUrl,
  buildRtmsUrl,
  parseRtmsXml,
} from "../../functions/_shared/molit.js";

const APT_LIST_BY_DONG_ENDPOINT =
  "https://apis.data.go.kr/1613000/AptListService3/getLegaldongAptList3";
const APT_LIST_BY_SIDO_ENDPOINT =
  "https://apis.data.go.kr/1613000/AptListService3/getSidoAptList3";
const APT_BASIS_ENDPOINT =
  "https://apis.data.go.kr/1613000/AptBasisInfoServiceV4/getAphusBassInfoV4";
const PERMIT_ENDPOINTS = {
  "building-permit": "https://apis.data.go.kr/1613000/ArchPmsHubService",
  "housing-permit": "https://apis.data.go.kr/1613000/HsPmsHubService",
};
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
      return fetchAptList({
        endpoint: APT_LIST_BY_DONG_ENDPOINT,
        filterName: "bjdCode",
        filterValue: bjdCode,
        fallbackBjdCode: bjdCode,
      });
    },

    async fetchAptListForSido(sidoCode) {
      return fetchAptList({
        endpoint: APT_LIST_BY_SIDO_ENDPOINT,
        filterName: "sidoCode",
        filterValue: sidoCode,
      });
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

    async fetchBuildingHubPage(operation, source, pageNo = 1, pageSize = 1000) {
      const url = buildBuildingHubUrl({
        serviceKey,
        operation,
        params: {
          ...source,
          pageNo: String(pageNo),
          numOfRows: String(pageSize),
        },
      });
      const payload = await fetchJsonWithRetry(url, {
        fetchImpl,
        onRequest,
        timeoutMs,
        operation,
      });
      const body = assertApiSuccess(payload, `BuildingHUB ${operation}`);
      return {
        items: normalizeItems(body.items || body.item),
        totalCount: Math.max(0, Number(body.totalCount || 0)),
        returnedPageSize: Math.max(0, Number(body.numOfRows || pageSize)),
      };
    },

    async fetchPermitRows(service, operation, source, pageSize = 1000) {
      const endpoint = PERMIT_ENDPOINTS[service];
      if (!endpoint) throw new Error(`Unknown permit service: ${service}`);
      const items = [];
      let pageNo = 1;
      let totalCount = Number.POSITIVE_INFINITY;
      let returnedPageSize = pageSize;

      while (items.length < totalCount) {
        const url = new URL(`${endpoint}/${operation}`);
        url.searchParams.set("serviceKey", serviceKey);
        Object.entries(source || {}).forEach(([key, value]) => {
          if (value !== null && value !== undefined && String(value).trim()) {
            url.searchParams.set(key, String(value));
          }
        });
        url.searchParams.set("_type", "json");
        url.searchParams.set("pageNo", String(pageNo));
        url.searchParams.set("numOfRows", String(pageSize));
        const payload = await fetchJsonWithRetry(url, {
          fetchImpl,
          onRequest,
          timeoutMs,
          operation,
          requestContext: { service, pageNo, pageSize },
        });
        const body = assertApiSuccess(payload, `${service} ${operation}`);
        const pageItems = normalizeItems(body.items || body.item);
        items.push(...pageItems);
        totalCount = Math.max(0, Number(body.totalCount || items.length));
        returnedPageSize = Math.max(
          1,
          Number(body.numOfRows || pageItems.length || pageSize)
        );
        if (!pageItems.length || items.length >= totalCount) break;
        pageNo += 1;
      }

      return {
        items,
        totalCount: Number.isFinite(totalCount) ? totalCount : items.length,
        pageCount: pageNo,
        returnedPageSize,
      };
    },
  };

  async function fetchAptList({
    endpoint,
    filterName,
    filterValue,
    fallbackBjdCode = "",
  }) {
    const rows = [];
    let pageNo = 1;
    let totalCount = Number.POSITIVE_INFINITY;
    const numOfRows = 1000;

    while (rows.length < totalCount) {
      const url = new URL(endpoint);
      url.searchParams.set("serviceKey", serviceKey);
      url.searchParams.set(filterName, filterValue);
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
        bjdCode: String(item.bjdCode || fallbackBjdCode),
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
  }
}

async function fetchJsonWithRetry(
  url,
  { fetchImpl, onRequest, timeoutMs, operation, requestContext = {} }
) {
  let lastError;
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt += 1) {
    if (attempt > 0) await sleep(RETRY_DELAYS[attempt - 1]);
    onRequest({ ...requestContext, operation, attempt: attempt + 1 });
    try {
      const response = await fetchImpl(url.toString(), {
        headers: { accept: "application/json, text/plain, */*" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      if (!response.ok) {
        const error = new Error(`${operation} responded with HTTP ${response.status}.`);
        error.upstreamStatus = response.status;
        error.retryable = RETRYABLE_STATUSES.has(response.status);
        throw error;
      }
      return text.trim() ? JSON.parse(text) : {};
    } catch (error) {
      lastError = sanitizeFetchError(error, operation, requestContext);
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
        error.upstreamStatus = response.status;
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

function sanitizeFetchError(error, operation, requestContext = {}) {
  const isTimeout = error?.name === "TimeoutError" || error?.name === "AbortError";
  const result = new Error(
    isTimeout ? `${operation} timed out.` : error?.message || `${operation} failed.`
  );
  result.retryable = error?.retryable !== false;
  result.details = {
    operation,
    pageNo: Math.max(1, Number(requestContext.pageNo) || 1),
    upstreamStatus: Math.max(0, Number(error?.upstreamStatus) || 0) || null,
    resultCode: isTimeout ? "TIMEOUT" : "UNKNOWN_ERROR",
    resultMessage: result.message,
    retryable: result.retryable,
  };
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
