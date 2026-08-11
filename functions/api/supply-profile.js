import {
  assertRequired,
  buildBuildingHubUrl,
  errorJson,
  getSearchParam,
  json,
  normalizeItems,
  parseJsonPreservingLongIntegers,
  requireServiceKey,
} from "../_shared/molit.js";
import {
  SUPPLY_CALCULATION_VERSION,
  buildHouseholdValidation,
  buildSupplyProfile,
  consumeBuildingAreaRows,
  createCollectionState,
} from "../_shared/supply-area.js";
import {
  LEDGER_MATCH_VERSION,
  resolveBuildingLedgerSources,
} from "../_shared/building-match.js";
import { createSupplyProfileStore } from "../_shared/supply-store.js";

const BUILDING_AREA_OPERATION = "getBrExposPubuseAreaInfo";
const COLLECTION_PROTOCOL_VERSION =
  "page-fetch-v6-apartment-component-filter";
const PAGE_SIZE_CANDIDATES = [1000, 500, 100];
const LEASE_MILLISECONDS = 45_000;
const PAGE_FETCH_TIMEOUT_MILLISECONDS = 20_000;
const UPSTREAM_RECHECK_MILLISECONDS = 30 * 24 * 60 * 60 * 1000;
const RETRY_BACKOFF_MILLISECONDS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000];
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
    } else {
      if (requestData.expectedHouseholds) {
        record.expectedHouseholds = requestData.expectedHouseholds;
      }
      record.metadata = {
        ...(record.metadata || {}),
        ...(requestData.metadata || {}),
        expectedHouseholds:
          requestData.expectedHouseholds || record.metadata?.expectedHouseholds || null,
      };
    }

    if (record.status === "ready") {
      const changed = syncHouseholdValidation(record);
      if (changed) {
        record.updatedAt = new Date().toISOString();
        await store.put(requestData.complexKey, record);
      }
      return profileResponse(record, store.mode);
    }

    const now = Date.now();
    if (record.status === "paused") {
      const nextRetryAt = Date.parse(record.nextRetryAt || "");
      if (!requestData.forceRetry && Number.isFinite(nextRetryAt) && nextRetryAt > now) {
        return progressResponse(record, store.mode);
      }
      resumeRecord(record);
    }

    if (record.status === "upstream-pending") {
      const nextRetryAt = Date.parse(record.nextRetryAt || "");
      if (!requestData.forceRetry && Number.isFinite(nextRetryAt) && nextRetryAt > now) {
        return progressResponse(record, store.mode);
      }
      resetResolution(record);
    }

    if (record.status === "failed") {
      if (!requestData.forceRetry) {
        return progressResponse(record, store.mode, 502);
      }
      resumeRecord(record);
    }

    const leaseUntil = Date.parse(record.leaseUntil || "");
    if (Number.isFinite(leaseUntil) && leaseUntil > now) {
      return progressResponse(record, store.mode);
    }

    record.leaseUntil = new Date(now + LEASE_MILLISECONDS).toISOString();
    record.updatedAt = new Date().toISOString();
    await store.put(requestData.complexKey, record);

    try {
      record = await advanceCollection(record, serviceKey);
      clearCollectionError(record);
    } catch (error) {
      const details = normalizeErrorDetails(error, Number(record.nextPage) || 1);
      record.failedPage = details.pageNo;
      record.errorDetails = details;
      record.error = formatCollectionError(details);
      if (details.resultCode === "LEDGER_MATCH_NOT_FOUND") {
        markUpstreamPending(record, details);
      } else if (details.retryable) {
        pauseRecord(record);
      } else {
        record.status = "failed";
        record.nextRetryAt = "";
      }
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
    metadata: {
      complexName: getSearchParam(request, "complexName"),
      roadAddress: getSearchParam(request, "roadAddress"),
      lotAddress: getSearchParam(request, "lotAddress"),
      approvalDate: getSearchParam(request, "approvalDate"),
      expectedHouseholds: positiveInteger(getSearchParam(request, "expectedHouseholds")),
    },
    sourceSignature: JSON.stringify({
      source,
      complexName: getSearchParam(request, "complexName"),
      roadAddress: getSearchParam(request, "roadAddress"),
      lotAddress: getSearchParam(request, "lotAddress"),
      approvalDate: getSearchParam(request, "approvalDate"),
    }),
    expectedHouseholds: positiveInteger(getSearchParam(request, "expectedHouseholds")),
    forceRetry: getSearchParam(request, "retry") === "1",
  };
}

export function createRecord(requestData) {
  const now = new Date().toISOString();
  return {
    complexKey: requestData.complexKey,
    calculationVersion: SUPPLY_CALCULATION_VERSION,
    collectionProtocolVersion: COLLECTION_PROTOCOL_VERSION,
    source: requestData.source,
    requestedSource: requestData.source,
    sourceSignature: requestData.sourceSignature,
    metadata: requestData.metadata || {},
    resolution: null,
    resolvedSources: [],
    sourcePlans: [],
    activeSourceIndex: 0,
    expectedHouseholds: requestData.expectedHouseholds,
    status: "building",
    pageSize: null,
    pageSizeProbe: [],
    nextPage: 1,
    totalPages: null,
    totalRows: null,
    lastSuccessfulPage: 0,
    collectionState: createCollectionState(),
    profile: null,
    consecutiveFailures: 0,
    error: "",
    errorDetails: null,
    failedPage: null,
    nextRetryAt: "",
    leaseUntil: "",
    createdAt: now,
    updatedAt: now,
    fetchedAt: "",
  };
}

export function shouldResetRecord(record, requestData) {
  return (
    record.calculationVersion !== SUPPLY_CALCULATION_VERSION ||
    record.sourceSignature !== requestData.sourceSignature ||
    (record.status !== "ready" && record.collectionProtocolVersion !== COLLECTION_PROTOCOL_VERSION)
  );
}

export async function advanceCollection(record, serviceKey, options = {}) {
  await ensureBuildingLedgerResolution(record, serviceKey, options.onRequest);
  const plan = activateSourcePlan(record, record.activeSourceIndex);
  const pageNo = Math.max(1, Number(plan.nextPage) || 1);
  let page;

  if (!plan.pageSize) {
    const negotiation = await negotiatePageSize(serviceKey, plan.source, options.onRequest);
    page = negotiation.page;
    plan.pageSize = negotiation.pageSize;
    plan.pageSizeProbe = negotiation.probes;
  } else {
    page = await fetchBuildingAreaPage(
      serviceKey,
      plan.source,
      pageNo,
      plan.pageSize,
      options.onRequest
    );
  }

  if (!plan.totalPages) {
    plan.totalRows = page.totalCount;
    plan.totalPages = Math.max(1, Math.ceil(page.totalCount / plan.pageSize));
  }

  const totalPages = Math.max(1, Number(plan.totalPages) || 1);
  if (pageNo > totalPages) {
    throw createCollectionError({
      operation: BUILDING_AREA_OPERATION,
      pageNo,
      resultCode: "PAGE_OUT_OF_RANGE",
      resultMessage: `전체 ${totalPages}페이지보다 큰 페이지를 요청했습니다.`,
      retryable: false,
    });
  }

  record.collectionState = consumeBuildingAreaRows(record.collectionState, page.items, {
    isFinal: pageNo === totalPages,
    apartmentComponents: record.resolution.components,
  });
  plan.lastSuccessfulPage = pageNo;
  plan.nextPage = pageNo + 1;

  if (pageNo === totalPages) {
    plan.status = "complete";
    if (record.activeSourceIndex < record.sourcePlans.length - 1) {
      record.activeSourceIndex += 1;
      activateSourcePlan(record, record.activeSourceIndex);
      record.status = "building";
    } else {
      record.profile = buildSupplyProfile({
        complexKey: record.complexKey,
        source: {
          requested: record.resolution.requestedSource,
          resolved: record.resolvedSources,
          managementPks: record.resolution.managementPks,
          apartmentComponents: record.resolution.components || [],
          matchVersion: LEDGER_MATCH_VERSION,
        },
        collectionState: record.collectionState,
        expectedHouseholds: record.expectedHouseholds,
      });
      if (!record.profile.groups.length) {
        throw createCollectionError({
          operation: BUILDING_AREA_OPERATION,
          pageNo,
          resultCode: "NO_RESIDENTIAL_UNITS",
          resultMessage:
            "동일 단지로 확인한 건축물대장에서 공급면적 그룹을 생성할 공동주택 세대를 찾지 못했습니다.",
          retryable: false,
        });
      }
      const aggregate = aggregateCollectionProgress(record);
      record.profile.collection = {
        sourceCount: record.sourcePlans.length,
        pageSize:
          record.sourcePlans.length === 1 ? record.sourcePlans[0].pageSize : null,
        totalRows: aggregate.totalRows,
        totalPages: aggregate.totalPages,
        sources: record.sourcePlans.map((sourcePlan) => ({
          source: sourcePlan.source,
          pageSize: sourcePlan.pageSize,
          totalRows: sourcePlan.totalRows,
          totalPages: sourcePlan.totalPages,
        })),
        protocolVersion: COLLECTION_PROTOCOL_VERSION,
        ledgerMatchVersion: LEDGER_MATCH_VERSION,
      };
      record.profile.ledgerMatch = {
        candidates: record.resolution.candidates,
        apartmentComponents: record.resolution.components || [],
        excludedComponents: record.resolution.excludedComponents || [],
        managementPks: record.resolution.managementPks,
        matchedAt: record.resolution.matchedAt,
      };
      assertCompletedProfileValidation(record.profile, pageNo);
      record.status = "ready";
      record.collectionState = null;
      record.fetchedAt = new Date().toISOString();
    }
  } else {
    plan.status = "building";
    record.status = "building";
  }

  syncLegacyProgress(record);
  return record;
}

function assertCompletedProfileValidation(profile, pageNo) {
  const householdValidation = profile?.householdValidation;
  if (
    householdValidation?.expectedHouseholds &&
    householdValidation.exactMatch !== true
  ) {
    throw createCollectionError({
      operation: BUILDING_AREA_OPERATION,
      pageNo,
      resultCode: "HOUSEHOLD_COUNT_MISMATCH",
      resultMessage: `K-apt ${householdValidation.expectedHouseholds}세대와 건축물대장 ${householdValidation.collectedHouseholds}세대가 정확히 일치하지 않습니다.`,
      retryable: false,
    });
  }
  if (profile?.areaValidation?.status !== "matched") {
    const firstIssue = profile.areaValidation?.issues?.[0];
    throw createCollectionError({
      operation: BUILDING_AREA_OPERATION,
      pageNo,
      resultCode: "ABNORMAL_SUPPLY_AREA",
      resultMessage: `비정상 공급면적 후보를 ${profile.areaValidation?.issueCount || 0}건 발견했습니다${
        firstIssue
          ? ` (전용 ${firstIssue.exclusiveArea}㎡, 공급 ${firstIssue.supplyArea}㎡)`
          : ""
      }.`,
      retryable: false,
    });
  }
}

async function ensureBuildingLedgerResolution(record, serviceKey, onRequest) {
  if (
    record.resolution?.status === "matched" &&
    record.resolution.version === LEDGER_MATCH_VERSION &&
    Array.isArray(record.sourcePlans) &&
    record.sourcePlans.length
  ) {
    return;
  }

  const resolution = await resolveBuildingLedgerSources({
    requestedSource: record.requestedSource || record.source,
    metadata: {
      ...(record.metadata || {}),
      expectedHouseholds: record.expectedHouseholds,
    },
    fetchPage: (operation, source, pageNo, pageSize) =>
      fetchBuildingLedgerPage(
        serviceKey,
        operation,
        source,
        pageNo,
        pageSize,
        onRequest
      ),
  });
  record.resolution = resolution;
  if (resolution.status !== "matched" || !resolution.sources.length) {
    throw createCollectionError({
      operation: "resolveBuildingLedgerSources",
      pageNo: 1,
      resultCode: "LEDGER_MATCH_NOT_FOUND",
      resultMessage: resolution.reason || "동일 단지의 건축물대장을 찾지 못했습니다.",
      retryable: false,
    });
  }

  record.resolvedSources = resolution.sources;
  record.sourcePlans = resolution.sources.map((source) => ({
    source,
    status: "pending",
    pageSize: null,
    pageSizeProbe: [],
    nextPage: 1,
    totalPages: null,
    totalRows: null,
    lastSuccessfulPage: 0,
  }));
  record.activeSourceIndex = 0;
  activateSourcePlan(record, 0);
}

function activateSourcePlan(record, index) {
  const plan = record.sourcePlans?.[index];
  if (!plan) {
    throw createCollectionError({
      operation: BUILDING_AREA_OPERATION,
      pageNo: 1,
      resultCode: "MISSING_SOURCE_PLAN",
      resultMessage: "건축물대장 조회 지번 계획이 비어 있습니다.",
      retryable: false,
    });
  }
  record.activeSourceIndex = index;
  record.pageSize = plan.pageSize;
  record.pageSizeProbe = plan.pageSizeProbe || [];
  record.nextPage = plan.nextPage || 1;
  record.totalPages = plan.totalPages;
  record.totalRows = plan.totalRows;
  record.lastSuccessfulPage = plan.lastSuccessfulPage || 0;
  return plan;
}

function syncLegacyProgress(record) {
  const plan = record.sourcePlans?.[record.activeSourceIndex];
  if (plan) {
    record.pageSize = plan.pageSize;
    record.pageSizeProbe = plan.pageSizeProbe || [];
    record.nextPage = plan.nextPage || 1;
    record.totalPages = plan.totalPages;
    record.totalRows = plan.totalRows;
    record.lastSuccessfulPage = plan.lastSuccessfulPage || 0;
  }
}

function aggregateCollectionProgress(record) {
  const plans = Array.isArray(record.sourcePlans) ? record.sourcePlans : [];
  return plans.reduce(
    (aggregate, plan) => {
      aggregate.completedPages += Math.max(0, Number(plan.lastSuccessfulPage) || 0);
      aggregate.totalPages += Math.max(1, Number(plan.totalPages) || 1);
      aggregate.totalRows += Math.max(0, Number(plan.totalRows) || 0);
      return aggregate;
    },
    { completedPages: 0, totalPages: 0, totalRows: 0 }
  );
}

async function negotiatePageSize(serviceKey, source, onRequest) {
  const probes = [];
  let lastError;

  for (const requestedPageSize of PAGE_SIZE_CANDIDATES) {
    try {
      const page = await fetchBuildingAreaPage(
        serviceKey,
        source,
        1,
        requestedPageSize,
        onRequest
      );
      const pageSize = resolvePageSize(page.returnedPageSize, requestedPageSize);
      probes.push({
        requestedPageSize,
        returnedPageSize: pageSize,
        status: "selected",
      });
      return { page, pageSize, probes };
    } catch (error) {
      lastError = error;
      const details = normalizeErrorDetails(error, 1);
      probes.push({
        requestedPageSize,
        status: "failed",
        upstreamStatus: details.upstreamStatus,
        resultCode: details.resultCode,
      });
      if (isCredentialError(details)) {
        throw error;
      }
    }
  }

  if (lastError?.details) {
    lastError.details.pageSizeProbe = probes;
  }
  throw lastError || createCollectionError({
    operation: BUILDING_AREA_OPERATION,
    pageNo: 1,
    resultCode: "PAGE_SIZE_NEGOTIATION_FAILED",
    resultMessage: "건축HUB 페이지 크기를 결정하지 못했습니다.",
    retryable: true,
  });
}

async function fetchBuildingAreaPage(serviceKey, source, pageNo, pageSize, onRequest) {
  return fetchBuildingLedgerPage(
    serviceKey,
    BUILDING_AREA_OPERATION,
    source,
    pageNo,
    pageSize,
    onRequest
  );
}

async function fetchBuildingLedgerPage(
  serviceKey,
  operation,
  source,
  pageNo,
  pageSize,
  onRequest
) {
  const url = buildBuildingHubUrl({
    serviceKey,
    operation,
    params: {
      ...source,
      pageNo: String(pageNo),
      numOfRows: String(pageSize),
    },
  });

  let response;
  let responseText = "";
  try {
    onRequest?.({
      operation,
      pageNo,
      pageSize,
    });
    response = await fetch(url.toString(), {
      headers: { accept: "application/json, text/plain, */*" },
      signal: AbortSignal.timeout(PAGE_FETCH_TIMEOUT_MILLISECONDS),
    });
    responseText = await response.text();
  } catch (error) {
    const isTimeout = error?.name === "TimeoutError" || error?.name === "AbortError";
    throw createCollectionError({
      operation,
      pageNo,
      upstreamStatus: null,
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
      operation,
      pageNo,
      upstreamStatus: response.status,
      resultCode: resultCode || `HTTP_${response.status}`,
      resultMessage: resultMessage || compactResponseMessage(responseText),
      retryable: RETRYABLE_HTTP_STATUSES.has(response.status),
    });
  }

  if (!payload) {
    throw createCollectionError({
      operation,
      pageNo,
      upstreamStatus: response.status,
      resultCode: "INVALID_RESPONSE",
      resultMessage: compactResponseMessage(responseText) || "JSON 응답을 해석할 수 없습니다.",
      retryable: true,
    });
  }

  if (resultCode && !["00", "000"].includes(resultCode)) {
    throw createCollectionError({
      operation,
      pageNo,
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
    returnedPageSize: positiveInteger(body.numOfRows),
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
  const aggregate = aggregateCollectionProgress(record);
  const totalPages = record.sourcePlans?.length
    ? aggregate.totalPages
    : Math.max(0, Number(record.totalPages) || 0);
  const completedPages = record.sourcePlans?.length
    ? aggregate.completedPages
    : Math.max(
        0,
        Number(record.lastSuccessfulPage) || (Number(record.nextPage) || 1) - 1
      );
  const currentPage = Number(record.failedPage || record.nextPage) || 1;
  const nextRetryTimestamp = Date.parse(record.nextRetryAt || "");
  const retryAfterMs =
    Number.isFinite(nextRetryTimestamp) && nextRetryTimestamp > Date.now()
      ? nextRetryTimestamp - Date.now()
      : 0;

  return json(
    {
      status: record.status,
      storage,
      progress: totalPages ? Math.min(100, Math.round((completedPages / totalPages) * 100)) : 0,
      completedPages,
      totalPages,
      totalRows: record.sourcePlans?.length
        ? aggregate.totalRows
        : Math.max(0, Number(record.totalRows) || 0),
      currentPage,
      stage: record.resolution?.status === "matched" ? "area-collection" : "ledger-matching",
      resolvedSourceCount: Array.isArray(record.resolvedSources)
        ? record.resolvedSources.length
        : 0,
      activeSourceIndex: Math.max(0, Number(record.activeSourceIndex) || 0),
      pageSize: positiveInteger(record.pageSize),
      pageSizeProbe: Array.isArray(record.pageSizeProbe) ? record.pageSizeProbe : [],
      processedUnits: Number(record.collectionState?.processedUnits) || 0,
      expectedHouseholds: positiveInteger(record.expectedHouseholds),
      consecutiveFailures: Math.max(0, Number(record.consecutiveFailures) || 0),
      nextRetryAt: record.nextRetryAt || "",
      retryAfterMs,
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
    processedUnits: record.profile.unitCount,
    skippedUnits: record.profile.skippedUnits,
  });
  const changed =
    JSON.stringify(record.profile.householdValidation || null) !== JSON.stringify(nextValidation);
  record.profile.householdValidation = nextValidation;
  return changed;
}

export function pauseRecord(record) {
  let failures = Math.max(0, Number(record.consecutiveFailures) || 0) + 1;
  if (failures >= 3 && downgradePageSize(record)) {
    failures = 1;
  }
  const delayIndex = Math.min(failures - 1, RETRY_BACKOFF_MILLISECONDS.length - 1);
  record.status = "paused";
  record.consecutiveFailures = failures;
  record.nextRetryAt = new Date(Date.now() + RETRY_BACKOFF_MILLISECONDS[delayIndex]).toISOString();
  persistActivePlanProgress(record);
}

function downgradePageSize(record) {
  const currentPageSize = positiveInteger(record.pageSize);
  const currentIndex = PAGE_SIZE_CANDIDATES.indexOf(currentPageSize);
  if (currentIndex < 0 || currentIndex >= PAGE_SIZE_CANDIDATES.length - 1) return false;

  const nextPageSize = PAGE_SIZE_CANDIDATES[currentIndex + 1];
  const completedRows = Math.min(
    Math.max(0, Number(record.totalRows) || 0),
    Math.max(0, Number(record.lastSuccessfulPage) || 0) * currentPageSize
  );
  const completedPages = Math.floor(completedRows / nextPageSize);

  record.pageSize = nextPageSize;
  record.totalPages = Math.max(1, Math.ceil((Number(record.totalRows) || 0) / nextPageSize));
  record.lastSuccessfulPage = completedPages;
  record.nextPage = completedPages + 1;
  record.failedPage = record.nextPage;
  record.error = `${record.error} · 페이지 크기를 ${nextPageSize}행으로 낮춰 재시도합니다.`;
  record.errorDetails = {
    ...(record.errorDetails || {}),
    pageSizeDowngradedFrom: currentPageSize,
    pageSizeDowngradedTo: nextPageSize,
  };
  record.pageSizeProbe = [
    ...(Array.isArray(record.pageSizeProbe) ? record.pageSizeProbe : []),
    {
      requestedPageSize: nextPageSize,
      previousPageSize: currentPageSize,
      status: "downgraded-after-retries",
    },
  ];
  persistActivePlanProgress(record);
  return true;
}

export function resumeRecord(record) {
  record.status = "building";
  record.nextRetryAt = "";
  record.leaseUntil = "";
}

export function markUpstreamPending(record, details) {
  record.status = "upstream-pending";
  record.nextRetryAt = new Date(Date.now() + UPSTREAM_RECHECK_MILLISECONDS).toISOString();
  record.errorDetails = details;
  record.error =
    "건축HUB에서 동일 단지의 표제부를 아직 찾지 못했습니다. 30일 후 자동으로 다시 확인합니다.";
  record.leaseUntil = "";
}

export function resetResolution(record) {
  record.status = "building";
  record.resolution = null;
  record.resolvedSources = [];
  record.sourcePlans = [];
  record.activeSourceIndex = 0;
  record.pageSize = null;
  record.pageSizeProbe = [];
  record.nextPage = 1;
  record.totalPages = null;
  record.totalRows = null;
  record.lastSuccessfulPage = 0;
  record.collectionState = createCollectionState();
  record.nextRetryAt = "";
  record.leaseUntil = "";
}

export function clearCollectionError(record) {
  record.consecutiveFailures = 0;
  record.error = "";
  record.errorDetails = null;
  record.failedPage = null;
  record.nextRetryAt = "";
}

function createCollectionError(details) {
  const error = new Error(details.resultMessage || "건축HUB 공급면적 수집 실패");
  error.details = {
    operation: details.operation || BUILDING_AREA_OPERATION,
    pageNo: positiveInteger(details.pageNo) || 1,
    upstreamStatus: positiveInteger(details.upstreamStatus),
    resultCode: String(details.resultCode || ""),
    resultMessage: sanitizeErrorMessage(details.resultMessage),
    retryable: Boolean(details.retryable),
  };
  return error;
}

export function normalizeErrorDetails(error, pageNo) {
  return (
    error?.details ||
    createCollectionError({
      operation: BUILDING_AREA_OPERATION,
      pageNo,
      resultCode: "UNKNOWN_ERROR",
      resultMessage: error?.message || "건축HUB 공급면적 수집 실패",
      retryable: true,
    }).details
  );
}

export function formatCollectionError(details) {
  const status = details.upstreamStatus ? `HTTP ${details.upstreamStatus}` : details.resultCode;
  const stage =
    details.operation === "resolveBuildingLedgerSources"
      ? "동일 단지 탐색"
      : `${details.pageNo}페이지 조회`;
  return `건축HUB ${stage} 지연 (${status}): ${
    details.resultMessage || "상세 메시지 없음"
  }`;
}

function persistActivePlanProgress(record) {
  const plan = record.sourcePlans?.[record.activeSourceIndex];
  if (!plan) return;
  plan.pageSize = record.pageSize;
  plan.pageSizeProbe = record.pageSizeProbe || [];
  plan.nextPage = record.nextPage || 1;
  plan.totalPages = record.totalPages;
  plan.totalRows = record.totalRows;
  plan.lastSuccessfulPage = record.lastSuccessfulPage || 0;
  plan.status = record.status;
}

function resolvePageSize(returnedPageSize, requestedPageSize) {
  const returned = positiveInteger(returnedPageSize);
  if (!returned) return requestedPageSize;
  return Math.min(requestedPageSize, returned);
}

function isCredentialError(details) {
  const value = `${details.resultCode} ${details.resultMessage}`.toUpperCase();
  return /(SERVICE_KEY|AUTH|UNAUTHORIZED|ACCESS DENIED|등록되지 않은 인증키|인증키)/.test(value);
}

function parseResponsePayload(text) {
  if (!text?.trim()) return {};
  try {
    return parseJsonPreservingLongIntegers(text);
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
