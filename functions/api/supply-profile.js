import {
  assertRequired,
  buildBuildingHubUrl,
  errorJson,
  fetchJsonApi,
  getSearchParam,
  json,
  normalizeItems,
  requireServiceKey,
} from "../_shared/molit.js";
import {
  SUPPLY_CALCULATION_VERSION,
  buildSupplyProfile,
  consumeBuildingAreaRows,
  createCollectionState,
} from "../_shared/supply-area.js";
import { createSupplyProfileStore } from "../_shared/supply-store.js";

const BUILDING_AREA_OPERATION = "getBrExposPubuseAreaInfo";
const PAGE_SIZE = 100;
const DEFAULT_BATCH_SIZE = 5;
const MAX_BATCH_SIZE = 10;
const LEASE_MILLISECONDS = 45_000;
const MAX_RETRIES = 3;

export async function onRequestGet({ request, env }) {
  try {
    const serviceKey = requireServiceKey(env);
    const requestData = parseRequest(request);
    const store = await createSupplyProfileStore(env);
    let record = await store.get(requestData.complexKey);

    if (!record || shouldResetRecord(record, requestData)) {
      record = createRecord(requestData);
      await store.put(requestData.complexKey, record);
    }

    if (record.status === "ready") {
      return profileResponse(record, store.mode);
    }

    const now = Date.now();
    const leaseUntil = Date.parse(record.leaseUntil || "");
    if (Number.isFinite(leaseUntil) && leaseUntil > now) {
      return progressResponse(record, store.mode);
    }

    if (record.status === "failed" && record.retryCount >= MAX_RETRIES) {
      if (getSearchParam(request, "retry") !== "1") {
        return progressResponse(record, store.mode, 502);
      }
      record.retryCount = 0;
      record.status = "building";
    }

    record.leaseUntil = new Date(now + LEASE_MILLISECONDS).toISOString();
    record.updatedAt = new Date().toISOString();
    await store.put(requestData.complexKey, record);

    try {
      record = await advanceCollection(record, serviceKey, requestData.batchSize);
      record.error = "";
      record.retryCount = 0;
    } catch (error) {
      record.retryCount = (Number(record.retryCount) || 0) + 1;
      record.status = record.retryCount >= MAX_RETRIES ? "failed" : "building";
      record.error = error.message || "건축HUB 공급면적 수집 실패";
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
  const batchSize = clamp(Number(getSearchParam(request, "batchSize", DEFAULT_BATCH_SIZE)), 1, MAX_BATCH_SIZE);
  return {
    complexKey,
    source,
    sourceSignature: JSON.stringify(source),
    batchSize,
  };
}

function createRecord(requestData) {
  const now = new Date().toISOString();
  return {
    complexKey: requestData.complexKey,
    calculationVersion: SUPPLY_CALCULATION_VERSION,
    source: requestData.source,
    sourceSignature: requestData.sourceSignature,
    status: "building",
    nextPage: 1,
    totalPages: null,
    totalRows: null,
    collectionState: createCollectionState(),
    profile: null,
    retryCount: 0,
    error: "",
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

async function advanceCollection(record, serviceKey, batchSize) {
  const firstPage = Number(record.nextPage) || 1;
  let totalPages = Number(record.totalPages) || null;
  const lastRequestedPage = totalPages
    ? Math.min(totalPages, firstPage + batchSize - 1)
    : firstPage + batchSize - 1;
  const pageNumbers = [];
  for (let page = firstPage; page <= lastRequestedPage; page += 1) {
    pageNumbers.push(page);
  }

  const pages = await Promise.all(
    pageNumbers.map((pageNo) => fetchBuildingAreaPage(serviceKey, record.source, pageNo))
  );

  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index];
    if (!totalPages) {
      record.totalRows = page.totalCount;
      totalPages = Math.max(1, Math.ceil(page.totalCount / PAGE_SIZE));
      record.totalPages = totalPages;
    }
    const pageNo = pageNumbers[index];
    if (pageNo > totalPages) break;
    record.collectionState = consumeBuildingAreaRows(record.collectionState, page.items, {
      isFinal: pageNo === totalPages,
    });
    record.nextPage = pageNo + 1;
  }

  if (record.nextPage > totalPages) {
    record.profile = buildSupplyProfile({
      complexKey: record.complexKey,
      source: record.source,
      collectionState: record.collectionState,
    });
    if (!record.profile.groups.length) {
      throw new Error("공급면적 그룹을 생성할 수 있는 공동주택 세대가 없습니다.");
    }
    record.status = "ready";
    record.fetchedAt = new Date().toISOString();
  } else {
    record.status = "building";
  }
  return record;
}

async function fetchBuildingAreaPage(serviceKey, source, pageNo) {
  const payload = await fetchJsonApi(
    buildBuildingHubUrl({
      serviceKey,
      operation: BUILDING_AREA_OPERATION,
      params: {
        ...source,
        pageNo: String(pageNo),
        numOfRows: String(PAGE_SIZE),
      },
    })
  );
  const header = payload?.response?.header || {};
  if (header.resultCode && !["00", "000"].includes(String(header.resultCode))) {
    throw new Error(header.resultMsg || `건축HUB API 오류: ${header.resultCode}`);
  }
  const body = payload?.response?.body || {};
  return {
    items: normalizeItems(body.items || body.item),
    totalCount: Number(body.totalCount || 0),
  };
}

function profileResponse(record, storage) {
  return json(
    {
      status: "ready",
      storage,
      profile: record.profile,
      fetchedAt: record.fetchedAt,
    },
    { cacheControl: "no-store" }
  );
}

function progressResponse(record, storage, status = 202) {
  const totalPages = Number(record.totalPages) || 0;
  const completedPages = Math.max(0, (Number(record.nextPage) || 1) - 1);
  return json(
    {
      status: record.status,
      storage,
      progress: totalPages ? Math.min(100, Math.round((completedPages / totalPages) * 100)) : 0,
      completedPages,
      totalPages,
      processedUnits: Number(record.collectionState?.processedUnits) || 0,
      error: record.error || "",
    },
    { status, cacheControl: "no-store" }
  );
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
