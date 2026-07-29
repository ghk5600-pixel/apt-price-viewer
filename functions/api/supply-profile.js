import {
  assertRequired,
  buildBuildingHubUrl,
  errorJson,
  getSearchParam,
  json,
  normalizeItems,
  requireServiceKey,
} from "../_shared/molit.js";
import {
  SUPPLY_CALCULATION_VERSION,
  buildHouseholdValidation,
  buildSupplyProfile,
  consumeBuildingAreaRows,
  createCollectionState,
} from "../_shared/supply-area.js";
import { createSupplyProfileStore } from "../_shared/supply-store.js";

const BUILDING_AREA_OPERATION = "getBrExposPubuseAreaInfo";
const PAGE_SIZE = 100;
const LEASE_MILLISECONDS = 45_000;
const PAGE_FETCH_ATTEMPTS = 4;
const PAGE_FETCH_TIMEOUT_MILLISECONDS = 15_000;
const RETRY_BASE_MILLISECONDS = 400;
const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export async function onRequestGet({ request, env }) {
  try {
    const serviceKey = requireServiceKey(env);
    const requestData = parseRequest(request);
    const store = await createSupplyProfileStore(env);
    let record = await store.get(requestData.complexKey);

    if (!record || shouldResetRecord(record, requestData)) {
      record = createRecord(requestData);
      await store.put(requestData.complexKey, record);
    } else if (requestData.expectedHouseholds) {
      record.expectedHouseholds = requestData.expectedHouseholds;
    }

    if (record.status === "ready") {
      const changed = syncHouseholdValidation(record);
      if (changed) {
        record.updatedAt = new Date().toISOString();
        await store.put(requestData.complexKey, record);
      }
      return profileResponse(record, store.mode);
    }

    if (record.status === "failed") {
      if (!requestData.retry) {
        return progressResponse(record, store.mode, 502);
      }
      resetFailedRecord(record);
    }

    const now = Date.now();
    const leaseUntil = Date.parse(record.leaseUntil || "");
    if (Number.isFinite(leaseUntil) && leaseUntil > now) {
      return progressResponse(record, store.mode);
    }

    record.leaseUntil = new Date(now + LEASE_MILLISECONDS).toISOString();
    record.updatedAt = new Date().toISOString();
    await store.put(requestData.complexKey, record);

    try {
      record = await advanceCollection(record, serviceKey);
      record.error = "";
      record.errorDetails = null;
      record.failedPage = null;
    } catch (error) {
      const details = normalizeErrorDetails(error, Number(record.nextPage) || 1);
      record.status = "failed";
      record.failedPage = details.pageNo;
      record.errorDetails = details;
      record.error = formatCollectionError(details);
    }

    record.leaseUntil = "";
    record.updatedAt = new Date().toISOString();
    await store.put(requestData.complexKey, record);

    return record.status === "ready"
      ? profileResponse(record, store.mode)
      : progressResponse(record, store.mode, record.status === "failed" ? 502 : 202);
  } catch (error) {
    const message = error.message || "Supply profile request failed.";
    return errorJson(message, message.startsWith("Missing required parameter:") ? 400 : 500);
  }
}

function parseRequest(request) {
  const complexKey = getSearchParam(request, "complexKey");
  const source = {
    sigunguCd: getSearchParam(request, "sigunguCd"),
    bjdongCd: getSearchParam(request, "bjdongCd"),
    platGbCd: getSearchParam(request, "platGbCd", "0"),
    bun: getSearchParam(request, "bun"),
    ji: getSearchParam(request, "ji"),
  };
  assertRequired({
    complexKey,
    sigunguCd: source.sigunguCd,
    bjdongCd: source.bjdongCd,
    bun: source.bun,
    ji: source.ji,
  });

  return {
    complexKey,
    source,
    sourceSignature: JSON.stringify(source),
    expectedHouseholds: positiveInteger(getSearchParam(request, "expectedHouseholds")),
    retry: getSearchParam(request, "retry") === "1",
  };
}

function createRecord(requestData) {
  const now = new Date().toISOString();
  return {
    complexKey: requestData.complexKey,
    calculationVersion: SUPPLY_CALCULATION_VERSION,
    source: requestData.source,
    sourceSignature: requestData.sourceSignature,
    expectedHouseholds: requestData.expectedHouseholds,
    status: "building",
    nextPage: 1,
    totalPages: null,
    totalRows: null,
    lastSuccessfulPage: 0,
    collectionState: createCollectionState(),
    profile: null,
    error: "",
    errorDetails: null,
    failedPage: null,
    leaseUntil: "",
    createdAt: now,
    updatedAt: now,
    fetchedAt: "",
  };
}

function shouldResetRecord(record, requestData) {
  return (
    record.calculationVersion !== SUPPLY_CALCULATION_VERSION ||
    record.sourceSignature !== requestData.sourceSignature
  );
}

async function advanceCollection(record, serviceKey) {
  const pageNo = Math.max(1, Number(record.nextPage) || 1);
  const page = await fetchBuildingAreaPageWithRetry(serviceKey, record.source, pageNo);

  if (!record.totalPages) {
    record.totalRows = page.totalCount;
    record.totalPages = Math.max(1, Math.ceil(page.totalCount / PAGE_SIZE));
  }

  const totalPages = Math.max(1, Number(record.totalPages) || 1);
  if (pageNo > totalPages) {
    throw createCollectionError({
      pageNo,
      attempts: 1,
      resultCode: "PAGE_OUT_OF_RANGE",
      resultMessage: `전체 ${totalPages}페이지보다 큰 페이지를 요청했습니다.`,
      retryable: false,
    });
  }

  record.collectionState = consumeBuildingAreaRows(record.collectionState, page.items, {
    isFinal: pageNo === totalPages,
  });
  record.lastSuccessfulPage = pageNo;
  record.nextPage = pageNo + 1;

  if (pageNo === totalPages) {
    record.profile = buildSupplyProfile({
      complexKey: record.complexKey,
      source: record.source,
      collectionState: record.collectionState,
      expectedHouseholds: record.expectedHouseholds,
    });
    if (!record.profile.groups.length) {
      throw createCollectionError({
        pageNo,
        attempts: page.attempts,
        resultCode: "NO_RESIDENTIAL_UNITS",
        resultMessage: "공급면적 그룹을 생성할 수 있는 공동주택 세대가 없습니다.",
        retryable: false,
      });
    }
    record.status = "ready";
    record.fetchedAt = new Date().toISOString();
  } else {
    record.status = "building";
  }

  return record;
}

async function fetchBuildingAreaPageWithRetry(serviceKey, source, pageNo) {
  let lastError;

  for (let attempt = 1; attempt <= PAGE_FETCH_ATTEMPTS; attempt += 1) {
    try {
      const page = await fetchBuildingAreaPage(serviceKey, source, pageNo);
      return { ...page, attempts: attempt };
    } catch (error) {
      lastError = attachAttempt(error, pageNo, attempt);
      if (!lastError.details.retryable || attempt === PAGE_FETCH_ATTEMPTS) {
        throw lastError;
      }
      await delay(RETRY_BASE_MILLISECONDS * 2 ** (attempt - 1));
    }
  }

  throw lastError;
}

async function fetchBuildingAreaPage(serviceKey, source, pageNo) {
  const url = buildBuildingHubUrl({
    serviceKey,
    operation: BUILDING_AREA_OPERATION,
    params: {
      ...source,
      pageNo: String(pageNo),
      numOfRows: String(PAGE_SIZE),
    },
  });

  let response;
  let responseText = "";
  try {
    response = await fetch(url.toString(), {
      headers: { accept: "application/json, text/plain, */*" },
      signal: AbortSignal.timeout(PAGE_FETCH_TIMEOUT_MILLISECONDS),
    });
    responseText = await response.text();
  } catch (error) {
    const isTimeout = error?.name === "TimeoutError" || error?.name === "AbortError";
    throw createCollectionError({
      pageNo,
      attempts: 1,
      resultCode: isTimeout ? "TIMEOUT" : "NETWORK_ERROR",
      resultMessage: isTimeout
        ? `${PAGE_FETCH_TIMEOUT_MILLISECONDS / 1000}초 안에 응답이 없어 중단했습니다.`
        : error?.message || "건축HUB 네트워크 요청에 실패했습니다.",
      retryable: true,
    });
  }

  const payload = parseResponsePayload(responseText);
  const header = payload?.response?.header || {};
  const resultCode = String(header.resultCode || extractXmlValue(responseText, "resultCode") || "");
  const resultMessage = String(
    header.resultMsg ||
      extractXmlValue(responseText, "resultMsg") ||
      extractXmlValue(responseText, "returnAuthMsg") ||
      extractXmlValue(responseText, "errMsg") ||
      ""
  );

  if (!response.ok) {
    throw createCollectionError({
      pageNo,
      attempts: 1,
      upstreamStatus: response.status,
      resultCode: resultCode || `HTTP_${response.status}`,
      resultMessage: resultMessage || compactResponseMessage(responseText),
      retryable: RETRYABLE_HTTP_STATUSES.has(response.status),
    });
  }

  if (!payload) {
    throw createCollectionError({
      pageNo,
      attempts: 1,
      upstreamStatus: response.status,
      resultCode: "INVALID_RESPONSE",
      resultMessage: compactResponseMessage(responseText) || "JSON 응답을 해석할 수 없습니다.",
      retryable: true,
    });
  }

  if (resultCode && !["00", "000"].includes(resultCode)) {
    throw createCollectionError({
      pageNo,
      attempts: 1,
      upstreamStatus: response.status,
      resultCode,
      resultMessage: resultMessage || "건축HUB API가 오류를 반환했습니다.",
      retryable: isRetryableApiError(resultCode),
    });
  }

  const body = payload?.response?.body || {};
  return {
    items: normalizeItems(body.items || body.item),
    totalCount: Math.max(0, Number(body.totalCount || 0)),
  };
}

function profileResponse(record, storage) {
  return json(
    {
      status: "ready",
      storage,
      profile: record.profile,
      validation: record.profile?.householdValidation || null,
      fetchedAt: record.fetchedAt,
    },
    { cacheControl: "no-store" }
  );
}

function progressResponse(record, storage, status = 202) {
  const totalPages = Math.max(0, Number(record.totalPages) || 0);
  const completedPages = Math.max(
    0,
    Number(record.lastSuccessfulPage) || (Number(record.nextPage) || 1) - 1
  );
  const currentPage = Number(record.failedPage || record.nextPage) || 1;

  return json(
    {
      status: record.status,
      storage,
      progress: totalPages ? Math.min(100, Math.round((completedPages / totalPages) * 100)) : 0,
      completedPages,
      totalPages,
      currentPage,
      processedUnits: Number(record.collectionState?.processedUnits) || 0,
      expectedHouseholds: positiveInteger(record.expectedHouseholds),
      error: record.error || "",
      errorDetails: record.errorDetails || null,
      failedPage: positiveInteger(record.failedPage),
    },
    { status, cacheControl: "no-store" }
  );
}

function syncHouseholdValidation(record) {
  if (!record.profile) return false;
  const nextValidation = buildHouseholdValidation({
    expectedHouseholds: record.expectedHouseholds,
    profileUnitCount: record.profile.unitCount,
    processedUnits: record.collectionState?.processedUnits,
    skippedUnits: record.collectionState?.skippedUnits,
  });
  const changed =
    JSON.stringify(record.profile.householdValidation || null) !== JSON.stringify(nextValidation);
  record.profile.householdValidation = nextValidation;
  return changed;
}

function resetFailedRecord(record) {
  record.status = "building";
  record.error = "";
  record.errorDetails = null;
  record.failedPage = null;
  record.leaseUntil = "";
}

function createCollectionError(details) {
  const error = new Error(details.resultMessage || "건축HUB 공급면적 수집 실패");
  error.details = {
    operation: BUILDING_AREA_OPERATION,
    pageNo: positiveInteger(details.pageNo) || 1,
    attempts: positiveInteger(details.attempts) || 1,
    upstreamStatus: positiveInteger(details.upstreamStatus),
    resultCode: String(details.resultCode || ""),
    resultMessage: sanitizeErrorMessage(details.resultMessage),
    retryable: Boolean(details.retryable),
  };
  return error;
}

function attachAttempt(error, pageNo, attempts) {
  if (!error?.details) {
    return createCollectionError({
      pageNo,
      attempts,
      resultCode: "UNKNOWN_ERROR",
      resultMessage: error?.message || "알 수 없는 오류가 발생했습니다.",
      retryable: true,
    });
  }
  error.details.pageNo = positiveInteger(pageNo) || 1;
  error.details.attempts = positiveInteger(attempts) || 1;
  return error;
}

function normalizeErrorDetails(error, pageNo) {
  return (
    error?.details ||
    createCollectionError({
      pageNo,
      attempts: 1,
      resultCode: "UNKNOWN_ERROR",
      resultMessage: error?.message || "건축HUB 공급면적 수집 실패",
      retryable: true,
    }).details
  );
}

function formatCollectionError(details) {
  const status = details.upstreamStatus ? `HTTP ${details.upstreamStatus}` : details.resultCode;
  const context = [status, `${details.attempts}회 시도`].filter(Boolean).join(", ");
  return `건축HUB ${details.pageNo}페이지 조회 실패 (${context}): ${
    details.resultMessage || "상세 메시지 없음"
  }`;
}

function parseResponsePayload(text) {
  if (!text?.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractXmlValue(text, tagName) {
  if (!text) return "";
  const match = text.match(new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  return match ? decodeXml(match[1].trim()) : "";
}

function decodeXml(value) {
  return String(value)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function compactResponseMessage(text) {
  return sanitizeErrorMessage(String(text || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " "));
}

function sanitizeErrorMessage(value) {
  const message = String(value || "").trim().slice(0, 500);
  return message.replace(/serviceKey=[^&\s]+/gi, "serviceKey=[REDACTED]");
}

function isRetryableApiError(resultCode) {
  return ["01", "02", "03", "04", "05", "99"].includes(String(resultCode));
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
