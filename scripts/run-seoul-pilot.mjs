import { writeFile } from "node:fs/promises";
import {
  advanceCollection,
  clearCollectionError,
  createRecord,
  formatCollectionError,
  markUpstreamPending,
  normalizeErrorDetails,
  pauseRecord,
  resumeRecord,
  shouldResetRecord,
} from "../functions/api/supply-profile.js";
import { SUPPLY_CALCULATION_VERSION } from "../functions/_shared/supply-area.js";
import { createD1RestClient } from "./lib/d1-rest-client.mjs";
import { createMolitBatchClient } from "./lib/molit-batch-client.mjs";
import {
  buildPilotCatalogEntry,
  parseCsv,
  selectSeoulLegalDongs,
  sortPilotCatalog,
} from "./lib/pilot-catalog.mjs";

const LEGAL_DONG_CSV_URL =
  "https://www.data.go.kr/cmm/cmm/fileDownload.do" +
  "?atchFileId=FILE_000000003676587&fileDetailSn=1&insertDataPrcus=N";
const VALID_MODES = new Set(["catalog", "collect", "catalog-and-collect"]);

const config = {
  mode: readChoice("PILOT_MODE", "catalog-and-collect", VALID_MODES),
  maxComplexes: readPositiveInteger("PILOT_MAX_COMPLEXES", 3),
  maxAttempts: readPositiveInteger("PILOT_MAX_ATTEMPTS", 12),
  maxMinutes: readPositiveInteger("PILOT_MAX_MINUTES", 240),
  maxApiCalls: readPositiveInteger("PILOT_MAX_API_CALLS", 4_500),
  maxRetriesPerComplex: readPositiveInteger("PILOT_MAX_RETRIES_PER_COMPLEX", 3),
  refreshCatalog: process.env.PILOT_REFRESH_CATALOG === "1",
  retryFailed: process.env.PILOT_RETRY_FAILED === "1",
  reportPath: process.env.PILOT_REPORT_PATH || "seoul-pilot-report.json",
};

const startedAt = new Date().toISOString();
const runId = `seoul-2020-${startedAt.replace(/[-:.TZ]/g, "").slice(0, 14)}`;
const deadline = Date.now() + config.maxMinutes * 60_000;
let apiCallCount = 0;
let completedCount = 0;
let stoppedReason = "";

const report = {
  version: "v2026.07.30-01-rc.3",
  runId,
  scope: {
    region: "서울특별시",
    approvalDateFrom: "2020-01-01",
    minimumHouseholds: 200,
    includedBuildingTypes: ["아파트", "주상복합"],
  },
  config,
  startedAt,
  finishedAt: "",
  status: "running",
  catalog: {
    sourceLegalDongs: 0,
    discoveredComplexes: 0,
    eligibleComplexes: 0,
    exclusions: {},
    errors: [],
    reusedExistingCatalog: false,
  },
  collection: {
    attempted: 0,
    completed: 0,
    skippedReady: 0,
    skippedWaiting: 0,
    skippedFailed: 0,
    results: [],
  },
  apiCallCount: 0,
  stoppedReason: "",
};

const d1 = createD1RestClient({
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
  databaseId: process.env.CLOUDFLARE_D1_DATABASE_ID,
  apiToken: process.env.CLOUDFLARE_API_TOKEN,
});
const molit = createMolitBatchClient({
  serviceKey: process.env.MOLIT_SERVICE_KEY,
  onRequest: noteApiRequest,
});

await run();

async function run() {
  let fatalError;
  try {
    await d1.ensureSchema();
    await saveRun("running");

    if (config.mode !== "collect") {
      await buildCatalogWhenNeeded();
    }
    if (config.mode !== "catalog") {
      await collectProfiles();
    }

    if (report.collection.attempted > 0 && completedCount === 0) {
      stoppedReason ||= "no-profiles-completed";
    }
    report.status = stoppedReason ? "partial" : "completed";
  } catch (error) {
    fatalError = error;
    report.status = "failed";
    report.fatalError = error?.stack || error?.message || String(error);
  } finally {
    report.finishedAt = new Date().toISOString();
    report.apiCallCount = apiCallCount;
    report.collection.completed = completedCount;
    report.stoppedReason = stoppedReason;
    await writeFile(config.reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await saveRun(report.status).catch((error) => {
      console.error(`D1 실행 보고서 저장 실패: ${error.message}`);
    });
    printSummary();
  }
  if (fatalError) throw fatalError;
  if (report.collection.attempted > 0 && completedCount === 0) {
    process.exitCode = 2;
  }
}

async function buildCatalogWhenNeeded() {
  const existingCount = await d1.getCatalogCount();
  if (existingCount > 0 && !config.refreshCatalog) {
    report.catalog.reusedExistingCatalog = true;
    report.catalog.eligibleComplexes = existingCount;
    console.log(`기존 서울 시험 카탈로그 ${existingCount}개를 재사용합니다.`);
    return;
  }

  assertBudget("법정동 목록 다운로드 전");
  console.log("서울 법정동 목록을 내려받는 중입니다.");
  const legalDongResponse = await fetch(
    process.env.LEGAL_DONG_CSV_URL || LEGAL_DONG_CSV_URL,
    { signal: AbortSignal.timeout(30_000) }
  );
  if (!legalDongResponse.ok) {
    throw new Error(`법정동 CSV 다운로드 실패: HTTP ${legalDongResponse.status}`);
  }
  const legalDongs = selectSeoulLegalDongs(parseCsv(await legalDongResponse.text()));
  report.catalog.sourceLegalDongs = legalDongs.length;
  console.log(`서울 법정동 ${legalDongs.length}개에서 K-apt 단지를 찾습니다.`);

  const candidatesByCode = new Map();
  for (const legalDong of legalDongs) {
    if (!hasBudget()) {
      stoppedReason = "catalog-budget-exhausted";
      break;
    }
    try {
      const candidates = await molit.fetchAptListForDong(legalDong.bjdCode);
      for (const candidate of candidates) {
        if (candidate.kaptCode && !candidatesByCode.has(candidate.kaptCode)) {
          candidatesByCode.set(candidate.kaptCode, candidate);
        }
      }
    } catch (error) {
      report.catalog.errors.push({
        stage: "apt-list",
        bjdCode: legalDong.bjdCode,
        message: error.message,
      });
    }
  }

  const candidates = [...candidatesByCode.values()];
  report.catalog.discoveredComplexes = candidates.length;
  console.log(`K-apt 단지 ${candidates.length}개의 기본정보를 확인합니다.`);
  const catalogResults = await mapWithConcurrency(candidates, 4, async (candidate) => {
    if (!hasBudget()) return null;
    try {
      const basicInfo = await molit.fetchAptBasicInfo(candidate.kaptCode);
      return buildPilotCatalogEntry(candidate, basicInfo, startedAt);
    } catch (error) {
      report.catalog.errors.push({
        stage: "apt-basis",
        kaptCode: candidate.kaptCode,
        message: error.message,
      });
      return null;
    }
  });

  const validResults = catalogResults.filter(Boolean);
  for (const result of validResults) {
    for (const reason of result.exclusionReasons) {
      report.catalog.exclusions[reason] =
        (report.catalog.exclusions[reason] || 0) + 1;
    }
  }
  const eligible = sortPilotCatalog(validResults.filter((result) => result.eligible));
  report.catalog.eligibleComplexes = eligible.length;
  if (eligible.length) await d1.upsertCatalog(eligible);
  console.log(`시험 대상 ${eligible.length}개 단지를 D1 카탈로그에 저장했습니다.`);
}

async function collectProfiles() {
  const catalog = await d1.listCatalog();
  for (const row of catalog) {
    if (
      completedCount >= config.maxComplexes ||
      report.collection.attempted >= config.maxAttempts
    ) {
      break;
    }
    if (!hasBudget()) {
      stoppedReason ||= "collection-budget-exhausted";
      break;
    }

    const requestData = catalogRowToRequest(row);
    let record = await d1.getProfileRecord(requestData.complexKey);
    if (!record || shouldResetRecord(record, requestData)) {
      record = createRecord(requestData);
      await d1.putProfileRecord(requestData.complexKey, record);
    } else {
      record.expectedHouseholds = requestData.expectedHouseholds;
      record.metadata = requestData.metadata;
    }

    if (
      record.status === "ready" &&
      record.calculationVersion === SUPPLY_CALCULATION_VERSION
    ) {
      report.collection.skippedReady += 1;
      await d1.updateCatalogProfile(requestData.complexKey, {
        status: "ready",
        calculationVersion: SUPPLY_CALCULATION_VERSION,
      });
      continue;
    }

    if (record.status === "failed" && !config.retryFailed) {
      report.collection.skippedFailed += 1;
      continue;
    }

    const retryAt = Date.parse(record.nextRetryAt || "");
    if (
      (record.status === "paused" || record.status === "upstream-pending") &&
      Number.isFinite(retryAt) &&
      retryAt > deadline
    ) {
      report.collection.skippedWaiting += 1;
      continue;
    }

    report.collection.attempted += 1;
    await d1.updateCatalogProfile(requestData.complexKey, {
      status: "building",
      incrementAttempt: true,
    });
    const result = await collectOneComplex(row, record);
    report.collection.results.push(result);
    if (result.status === "ready") completedCount += 1;
  }
  if (
    completedCount < config.maxComplexes &&
    report.collection.attempted >= config.maxAttempts
  ) {
    stoppedReason ||= "attempt-limit-reached";
  }
}

async function collectOneComplex(row, record) {
  let retries = 0;
  const label = `${row.complex_name} (${row.kapt_code})`;
  console.log(`공급면적 수집 시작: ${label}`);

  while (hasBudget()) {
    if (record.status === "upstream-pending") {
      const retryAt = Date.parse(record.nextRetryAt || "");
      if (Number.isFinite(retryAt) && retryAt > Date.now()) break;
      resumeRecord(record);
    } else if (record.status === "paused") {
      const retryAt = Date.parse(record.nextRetryAt || "");
      const waitMs = Number.isFinite(retryAt) ? Math.max(0, retryAt - Date.now()) : 0;
      if (retries >= config.maxRetriesPerComplex || Date.now() + waitMs >= deadline) {
        break;
      }
      if (waitMs) {
        console.log(`${label}: ${Math.ceil(waitMs / 1000)}초 후 실패 페이지를 재시도합니다.`);
        await sleep(waitMs);
      }
      resumeRecord(record);
    } else if (record.status === "failed") {
      if (!config.retryFailed) break;
      resumeRecord(record);
    }

    try {
      record = await advanceCollection(record, process.env.MOLIT_SERVICE_KEY, {
        onRequest: noteApiRequest,
      });
      clearCollectionError(record);
      retries = 0;
    } catch (error) {
      retries += 1;
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
    await d1.putProfileRecord(record.complexKey, record);
    await d1.updateCatalogProfile(record.complexKey, {
      status: record.status,
      calculationVersion:
        record.status === "ready" ? SUPPLY_CALCULATION_VERSION : "",
      lastError: record.error || "",
    });

    const page = Number(record.lastSuccessfulPage) || 0;
    const total = Number(record.totalPages) || 0;
    console.log(`${label}: ${record.status} ${page}/${total || "?"}페이지`);
    if (
      record.status === "ready" ||
      record.status === "failed" ||
      record.status === "upstream-pending"
    ) {
      break;
    }
  }

  return {
    complexKey: record.complexKey,
    kaptCode: row.kapt_code,
    complexName: row.complex_name,
    approvalDate: row.approval_date,
    households: Number(row.households),
    status: record.status,
    completedPages: Number(record.lastSuccessfulPage) || 0,
    totalPages: Number(record.totalPages) || 0,
    totalRows: Number(record.totalRows) || 0,
    error: record.error || "",
    resolution: record.resolution || null,
    validation: record.profile?.householdValidation || null,
  };
}

function catalogRowToRequest(row) {
  const source = {
    sigunguCd: String(row.bjd_code).slice(0, 5),
    bjdongCd: String(row.bjd_code).slice(5),
    platGbCd: String(row.plat_gb_cd || "0"),
    bun: String(row.bun),
    ji: String(row.ji),
  };
  return {
    complexKey: String(row.complex_key),
    source,
    metadata: {
      complexName: String(row.complex_name || ""),
      roadAddress: String(row.road_address || ""),
      lotAddress: String(row.lot_address || ""),
      approvalDate: String(row.approval_date || ""),
      expectedHouseholds: Number(row.households) || null,
    },
    sourceSignature: JSON.stringify({
      source,
      complexName: String(row.complex_name || ""),
      roadAddress: String(row.road_address || ""),
      lotAddress: String(row.lot_address || ""),
      approvalDate: String(row.approval_date || ""),
    }),
    expectedHouseholds: Number(row.households) || null,
  };
}

function noteApiRequest({ operation, pageNo, pageSize, attempt } = {}) {
  apiCallCount += 1;
  const suffix = pageNo
    ? ` ${pageNo}페이지 ${pageSize}행`
    : attempt && attempt > 1
      ? ` ${attempt}차 시도`
      : "";
  if (
    apiCallCount % 100 === 0 ||
    String(operation || "").startsWith("getBr")
  ) {
    console.log(`공공데이터 API ${apiCallCount}회: ${operation || "unknown"}${suffix}`);
  }
}

function hasBudget() {
  return Date.now() < deadline && apiCallCount < config.maxApiCalls;
}

function assertBudget(stage) {
  if (!hasBudget()) throw new Error(`${stage}: 실행 시간 또는 API 호출 예산을 초과했습니다.`);
}

async function saveRun(status) {
  await d1.saveRun({
    runId,
    scope: "seoul-built-from-2020-households-200",
    mode: config.mode,
    status,
    catalogCount: report.catalog.eligibleComplexes,
    completedCount,
    apiCallCount,
    report,
    startedAt,
    finishedAt: report.finishedAt,
  });
}

function printSummary() {
  console.log("");
  console.log(`서울 시험 배치 상태: ${report.status}`);
  console.log(`카탈로그 대상: ${report.catalog.eligibleComplexes}개`);
  console.log(`이번 실행 완료: ${completedCount}개`);
  console.log(`공공데이터 API 호출: ${apiCallCount}회`);
  console.log(`보고서: ${config.reportPath}`);
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  );
  return results;
}

function readPositiveInteger(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function readChoice(name, fallback, choices) {
  const value = process.env[name] || fallback;
  if (!choices.has(value)) {
    throw new Error(`${name} must be one of: ${[...choices].join(", ")}`);
  }
  return value;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
