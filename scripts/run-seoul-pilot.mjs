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
import { resolveBuildingLedgerSources } from "../functions/_shared/building-match.js";
import { SUPPLY_CALCULATION_VERSION } from "../functions/_shared/supply-area.js";
import { createD1RestClient } from "./lib/d1-rest-client.mjs";
import { createMolitBatchClient } from "./lib/molit-batch-client.mjs";
import {
  attachBuildingPurposeVerification,
  attachRtmsMatch,
  buildRecentDealMonths,
  buildPilotCatalogEntry,
  parseCsv,
  PILOT_CATALOG_VERSION,
  PILOT_TRADE_LOOKBACK_MONTHS,
  selectSeoulLegalDongs,
  sortPilotCatalog,
} from "./lib/pilot-catalog.mjs";

const LEGAL_DONG_CSV_URL =
  "https://www.data.go.kr/cmm/cmm/fileDownload.do" +
  "?atchFileId=FILE_000000003676587&fileDetailSn=1&insertDataPrcus=N";
const PILOT_SCOPE = "seoul-sale-apartment-built-from-2020-households-200";
const VALID_MODES = new Set(["catalog", "collect", "catalog-and-collect"]);

const config = {
  mode: readChoice("PILOT_MODE", "catalog-and-collect", VALID_MODES),
  maxComplexes: readPositiveInteger("PILOT_MAX_COMPLEXES", 500),
  maxAttempts: readPositiveInteger("PILOT_MAX_ATTEMPTS", 500),
  maxMinutes: readPositiveInteger("PILOT_MAX_MINUTES", 330),
  maxApiCalls: readPositiveInteger("PILOT_MAX_API_CALLS", 9_000),
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
const verifiedResolutionByComplexKey = new Map();

const report = {
  version: "v2026.07.31-01-rc.6",
  runId,
  scope: {
    region: "서울특별시",
    approvalDateFrom: "2020-01-01",
    minimumHouseholds: 200,
    includedBuildingTypes: ["아파트", "주상복합"],
    excludedHousingPrograms: [
      "도시형 생활주택",
      "청년안심주택",
      "공공임대주택",
    ],
    requiredSaleTenure: true,
    requiredRtmsApartmentSaleMatch: true,
    rtmsLookbackMonths: PILOT_TRADE_LOOKBACK_MONTHS,
    catalogVersion: PILOT_CATALOG_VERSION,
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
    excludedComplexes: [],
    errors: [],
    reusedExistingCatalog: false,
    reusedCandidateCatalog: false,
    tradeVerification: {
      districts: 0,
      requestedMonths: 0,
      successfulMonths: 0,
      failedMonths: 0,
      matchedComplexes: 0,
      reusedComplexes: 0,
    },
    buildingPurposeVerification: {
      requestedComplexes: 0,
      verifiedComplexes: 0,
      excludedComplexes: 0,
      unverifiedComplexes: 0,
    },
  },
  collection: {
    attempted: 0,
    completed: 0,
    skippedReady: 0,
    skippedWaiting: 0,
    skippedFailed: 0,
    statusCounts: {},
    failures: [],
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
    summarizeCollectionResults();
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
  const existingCount = await d1.getCatalogCount(PILOT_CATALOG_VERSION);
  if (existingCount > 0 && !config.refreshCatalog) {
    report.catalog.reusedExistingCatalog = true;
    report.catalog.eligibleComplexes = existingCount;
    console.log(`기존 서울 시험 카탈로그 ${existingCount}개를 재사용합니다.`);
    return;
  }

  const seedCatalog = config.refreshCatalog ? [] : await d1.listCatalog();
  const seedByKaptCode = new Map(
    seedCatalog.map((row) => [String(row.kapt_code || ""), row])
  );
  const candidates = seedCatalog.length
    ? seedCatalog.map(catalogRowToCandidate)
    : await discoverSeoulCandidates();
  report.catalog.reusedCandidateCatalog = seedCatalog.length > 0;
  report.catalog.discoveredComplexes = candidates.length;
  if (seedCatalog.length) {
    console.log(
      `기존 서울 후보 카탈로그 ${seedCatalog.length}개에 새 선정 규칙을 적용합니다.`
    );
  }
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
  const staticEligible = validResults.filter((result) => result.eligible);
  const reusedTradeMatches = [];
  const entriesNeedingTradeVerification = [];
  for (const entry of staticEligible) {
    const seed = seedByKaptCode.get(entry.kaptCode);
    if (Number(seed?.trade_match_count) > 0 && seed?.last_trade_date) {
      reusedTradeMatches.push({
        ...entry,
        tradeMatched: true,
        tradeMatchCount: Number(seed.trade_match_count),
        tradeMatchMethod: String(seed.trade_match_method || ""),
        lastTradeDate: String(seed.last_trade_date || ""),
      });
    } else {
      entriesNeedingTradeVerification.push(entry);
    }
  }
  report.catalog.tradeVerification.reusedComplexes = reusedTradeMatches.length;
  const verifiedTradeMatches = [
    ...reusedTradeMatches,
    ...(await verifyApartmentSaleMatches(entriesNeedingTradeVerification)),
  ];
  const buildingPurposeResults = await verifyBuildingPurposes(
    verifiedTradeMatches.filter((entry) => entry.eligible)
  );
  const purposeByKey = new Map(
    buildingPurposeResults.map((result) => [result.complexKey, result])
  );
  const verifiedByKey = new Map(
    verifiedTradeMatches.map((result) => [
      result.complexKey,
      purposeByKey.get(result.complexKey) || result,
    ])
  );
  const finalResults = validResults.map(
    (result) => verifiedByKey.get(result.complexKey) || result
  );
  for (const result of finalResults) {
    for (const reason of result.exclusionReasons) {
      report.catalog.exclusions[reason] =
        (report.catalog.exclusions[reason] || 0) + 1;
    }
    if (!result.eligible) {
      report.catalog.excludedComplexes.push({
        kaptCode: result.kaptCode,
        complexName: result.complexName,
        apartmentType: result.apartmentType,
        saleType: result.saleType,
        buildingPurpose: result.buildingPurpose || "",
        reasons: result.exclusionReasons,
      });
    }
  }
  const eligible = sortPilotCatalog(finalResults.filter((result) => result.eligible));
  report.catalog.eligibleComplexes = eligible.length;
  await d1.replaceCatalog(eligible, PILOT_CATALOG_VERSION, {
    purgeRunScope: PILOT_SCOPE,
  });
  console.log(`시험 대상 ${eligible.length}개 단지를 D1 카탈로그에 저장했습니다.`);
}

async function verifyBuildingPurposes(entries) {
  report.catalog.buildingPurposeVerification.requestedComplexes = entries.length;
  return mapWithConcurrency(entries, 3, async (entry) => {
    try {
      const source = {
        sigunguCd: entry.bjdCode.slice(0, 5),
        bjdongCd: entry.bjdCode.slice(5),
        platGbCd: entry.platGbCd,
        bun: entry.bun,
        ji: entry.ji,
      };
      const resolution = await resolveBuildingLedgerSources({
        requestedSource: source,
        metadata: {
          complexName: entry.complexName,
          roadAddress: entry.roadAddress,
          lotAddress: entry.lotAddress,
          approvalDate: entry.approvalDate,
          expectedHouseholds: entry.households,
        },
        fetchPage: (operation, pageSource, pageNo, pageSize) =>
          molit.fetchBuildingHubPage(
            operation,
            pageSource,
            pageNo,
            pageSize
          ),
      });
      const verified = attachBuildingPurposeVerification(entry, resolution);
      if (verified.eligible) {
        verifiedResolutionByComplexKey.set(entry.complexKey, resolution);
        report.catalog.buildingPurposeVerification.verifiedComplexes += 1;
      } else if (
        verified.exclusionReasons.includes("excluded-building-ledger-purpose")
      ) {
        report.catalog.buildingPurposeVerification.excludedComplexes += 1;
      } else {
        report.catalog.buildingPurposeVerification.unverifiedComplexes += 1;
      }
      return verified;
    } catch (error) {
      report.catalog.errors.push({
        stage: "building-purpose",
        kaptCode: entry.kaptCode,
        message: error.message,
      });
      report.catalog.buildingPurposeVerification.unverifiedComplexes += 1;
      return {
        ...entry,
        eligible: false,
        exclusionReasons: [
          ...entry.exclusionReasons,
          "building-purpose-unverified",
        ],
      };
    }
  });
}

async function discoverSeoulCandidates() {
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
  return [...candidatesByCode.values()];
}

async function collectProfiles() {
  const catalog = await d1.listCatalog(PILOT_CATALOG_VERSION);
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
    let recordChanged = false;
    if (!record || shouldResetRecord(record, requestData)) {
      record = createRecord(requestData);
      recordChanged = true;
    } else {
      record.expectedHouseholds = requestData.expectedHouseholds;
      record.metadata = requestData.metadata;
    }
    const verifiedResolution = verifiedResolutionByComplexKey.get(
      requestData.complexKey
    );
    if (
      verifiedResolution?.status === "matched" &&
      (!record.resolution ||
        record.resolution.version !== verifiedResolution.version)
    ) {
      applyVerifiedResolution(record, verifiedResolution);
      recordChanged = true;
    }
    if (recordChanged) {
      await d1.putProfileRecord(requestData.complexKey, record);
    }

    if (
      record.status === "ready" &&
      record.calculationVersion === SUPPLY_CALCULATION_VERSION
    ) {
      report.collection.skippedReady += 1;
      report.collection.results.push(
        buildCollectionResult(row, record, { reusedReady: true })
      );
      completedCount += 1;
      await d1.updateCatalogProfile(requestData.complexKey, {
        status: "ready",
        calculationVersion: SUPPLY_CALCULATION_VERSION,
      });
      continue;
    }

    if (record.status === "failed" && !config.retryFailed) {
      report.collection.skippedFailed += 1;
      report.collection.results.push(buildCollectionResult(row, record));
      continue;
    }

    const retryAt = Date.parse(record.nextRetryAt || "");
    if (
      (record.status === "paused" || record.status === "upstream-pending") &&
      Number.isFinite(retryAt) &&
      retryAt > deadline
    ) {
      report.collection.skippedWaiting += 1;
      report.collection.results.push(buildCollectionResult(row, record));
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

async function verifyApartmentSaleMatches(entries) {
  if (!entries.length) return [];
  const months = buildRecentDealMonths(new Date(), PILOT_TRADE_LOOKBACK_MONTHS);
  const entriesByLawd = new Map();
  for (const entry of entries) {
    const lawdCd = entry.bjdCode.slice(0, 5);
    if (!entriesByLawd.has(lawdCd)) entriesByLawd.set(lawdCd, []);
    entriesByLawd.get(lawdCd).push(entry);
  }

  report.catalog.tradeVerification.districts = entriesByLawd.size;
  report.catalog.tradeVerification.requestedMonths = entriesByLawd.size * months.length;
  const verified = [];

  for (const [lawdCd, districtEntries] of entriesByLawd) {
    console.log(
      `${lawdCd}: 최근 ${months.length}개월 아파트 매매 실거래로 ` +
      `${districtEntries.length}개 단지를 검증합니다.`
    );
    const monthResults = await mapWithConcurrency(months, 4, async (dealYmd) => {
      if (!hasBudget()) return { dealYmd, ok: false, items: [], budget: true };
      try {
        return {
          dealYmd,
          ok: true,
          items: await molit.fetchRtmsTrades(lawdCd, dealYmd),
        };
      } catch (error) {
        report.catalog.errors.push({
          stage: "rtms-trade",
          lawdCd,
          dealYmd,
          message: error.message,
        });
        return { dealYmd, ok: false, items: [], error: error.message };
      }
    });
    const successful = monthResults.filter((result) => result.ok);
    const failed = monthResults.filter((result) => !result.ok);
    report.catalog.tradeVerification.successfulMonths += successful.length;
    report.catalog.tradeVerification.failedMonths += failed.length;

    if (failed.length) {
      for (const entry of districtEntries) {
        verified.push({
          ...entry,
          eligible: false,
          exclusionReasons: [
            ...entry.exclusionReasons,
            "rtms-verification-incomplete",
          ],
        });
      }
      continue;
    }

    const items = successful.flatMap((result) => result.items);
    for (const entry of districtEntries) {
      const matched = attachRtmsMatch(entry, items);
      if (matched.tradeMatched) {
        report.catalog.tradeVerification.matchedComplexes += 1;
      }
      verified.push(matched);
    }
  }
  return verified;
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

  return buildCollectionResult(row, record);
}

function buildCollectionResult(row, record, { reusedReady = false } = {}) {
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
    errorDetails: record.errorDetails || null,
    failureReason: getFailureReason(record),
    reusedReady,
    resolution: record.resolution || null,
    validation: record.profile?.householdValidation || null,
    supplyGroups: (record.profile?.groups || []).map((group) => ({
      id: group.id,
      label: group.label,
      method: group.method,
      unitCount: Number(group.unitCount) || 0,
      targetExclusiveArea: Number(group.targetExclusiveArea) || 0,
      representativeSupplyArea:
        Number(group.representativeSupplyArea) || 0,
      representativeSupplyPyeong:
        Number(group.representativeSupplyPyeong) || 0,
      candidates: (group.candidates || []).map((candidate) => ({
        supplyArea: Number(candidate.supplyArea) || 0,
        supplyPyeong: Number(candidate.supplyPyeong) || 0,
        unitCount: Number(candidate.unitCount) || 0,
        weight: Number(candidate.weight) || 0,
      })),
    })),
  };
}

function applyVerifiedResolution(record, resolution) {
  record.resolution = resolution;
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
  record.pageSize = null;
  record.pageSizeProbe = [];
  record.nextPage = 1;
  record.totalPages = null;
  record.totalRows = null;
  record.lastSuccessfulPage = 0;
}

function getFailureReason(record) {
  if (record.status === "ready") return "";
  const details = record.errorDetails || {};
  return (
    details.resultCode ||
    details.operation ||
    record.status ||
    "unknown"
  );
}

function summarizeCollectionResults() {
  const statusCounts = {};
  const failures = [];
  for (const result of report.collection.results) {
    const status = result.status || "unknown";
    statusCounts[status] = (statusCounts[status] || 0) + 1;
    if (status !== "ready") {
      failures.push({
        complexKey: result.complexKey,
        kaptCode: result.kaptCode,
        complexName: result.complexName,
        approvalDate: result.approvalDate,
        status,
        reason: result.failureReason,
        error: result.error,
        completedPages: result.completedPages,
        totalPages: result.totalPages,
      });
    }
  }
  report.collection.statusCounts = statusCounts;
  report.collection.failures = failures;
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

function catalogRowToCandidate(row) {
  return {
    kaptCode: String(row.kapt_code || ""),
    kaptName: String(row.complex_name || ""),
    bjdCode: String(row.bjd_code || ""),
    as1: String(row.sido_name || ""),
    as2: String(row.sigungu_name || ""),
    as3: String(row.eupmyeondong_name || ""),
    as4: "",
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
    scope: PILOT_SCOPE,
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
