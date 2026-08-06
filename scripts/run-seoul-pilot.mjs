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
import { buildPermitSupplyProfile } from "../functions/_shared/permit-supply.js";
import { SUPPLY_CALCULATION_VERSION } from "../functions/_shared/supply-area.js";
import { createD1RestClient } from "./lib/d1-rest-client.mjs";
import { createMolitBatchClient } from "./lib/molit-batch-client.mjs";
import { renderBatchReport } from "./lib/batch-report.mjs";
import {
  attachBuildingPurposeVerification,
  attachRtmsMatch,
  buildRecentDealMonths,
  buildPilotCatalogEntry,
  buildPilotCatalogVersion,
  PILOT_TRADE_LOOKBACK_MONTHS,
  SEOUL_MASTER_CATALOG_VERSION,
  sortPilotCatalog,
} from "./lib/pilot-catalog.mjs";

const SEOUL_SIDO_CODE = "11";
const LEGACY_2020_CATALOG_VERSION =
  "seoul-sale-apartment-v7-apartment-unit-filter";
const VALID_MODES = new Set(["catalog", "collect", "catalog-and-collect"]);
const VALID_CATALOG_STRATEGIES = new Set(["master", "decade"]);
const PERMIT_RETRY_BACKOFF_MILLISECONDS = [
  15 * 60_000,
  60 * 60_000,
  6 * 60 * 60_000,
];

const config = {
  approvalDateFrom: readYmd("PILOT_APPROVAL_FROM", "20200101"),
  approvalDateTo: readYmd("PILOT_APPROVAL_TO", "20291231"),
  mode: readChoice("PILOT_MODE", "catalog-and-collect", VALID_MODES),
  maxComplexes: readPositiveInteger("PILOT_MAX_COMPLEXES", 500),
  maxAttempts: readPositiveInteger("PILOT_MAX_ATTEMPTS", 500),
  maxMinutes: readPositiveInteger("PILOT_MAX_MINUTES", 330),
  maxApiCalls: readPositiveInteger("PILOT_MAX_API_CALLS", 9_000),
  maxRetriesPerComplex: readPositiveInteger("PILOT_MAX_RETRIES_PER_COMPLEX", 3),
  maxConsecutiveTransportFailures: readPositiveInteger(
    "PILOT_MAX_CONSECUTIVE_TRANSPORT_FAILURES",
    2
  ),
  refreshCatalog: process.env.PILOT_REFRESH_CATALOG === "1",
  retryFailed: process.env.PILOT_RETRY_FAILED === "1",
  retryWaiting: process.env.PILOT_RETRY_WAITING === "1",
  enableLedgerFallback: process.env.PILOT_ENABLE_LEDGER_FALLBACK !== "0",
  catalogStrategy: readChoice(
    "PILOT_CATALOG_STRATEGY",
    "master",
    VALID_CATALOG_STRATEGIES
  ),
  reportPath: process.env.PILOT_REPORT_PATH || "seoul-pilot-report.json",
  reportHtmlPath:
    process.env.PILOT_REPORT_HTML_PATH || "seoul-pilot-report.html",
  reportCsvPath:
    process.env.PILOT_REPORT_CSV_PATH || "seoul-pilot-report.csv",
};
if (config.approvalDateFrom > config.approvalDateTo) {
  throw new Error("PILOT_APPROVAL_FROM must not be later than PILOT_APPROVAL_TO.");
}

const PILOT_SCOPE =
  config.catalogStrategy === "master"
    ? "seoul-sale-apartment-master-households-200"
    : `seoul-sale-apartment-${config.approvalDateFrom}-` +
      `${config.approvalDateTo}-households-200`;
const pilotCatalogVersion =
  config.catalogStrategy === "master"
    ? SEOUL_MASTER_CATALOG_VERSION
    : buildPilotCatalogVersion(config.approvalDateFrom, config.approvalDateTo);

const startedAt = new Date().toISOString();
const runId =
  `seoul-${config.approvalDateFrom.slice(0, 4)}-` +
  `${config.approvalDateTo.slice(0, 4)}-` +
  `${startedAt.replace(/[-:.TZ]/g, "").slice(0, 14)}`;
const deadline = Date.now() + config.maxMinutes * 60_000;
let apiCallCount = 0;
let completedCount = 0;
let stoppedReason = "";
let consecutiveTransportFailures = 0;
const verifiedResolutionByComplexKey = new Map();

const report = {
  version: "v2026.08.06-01-rc.2",
  runId,
  scope: {
    region: "서울특별시",
    approvalDateFrom: config.approvalDateFrom,
    approvalDateTo: config.approvalDateTo,
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
    catalogVersion: pilotCatalogVersion,
    catalogStrategy: config.catalogStrategy,
  },
  config,
  startedAt,
  finishedAt: "",
  status: "running",
  catalog: {
    discoveryMethod: "kapt-sido-list",
    sourceApartmentRows: 0,
    discoveredComplexes: 0,
    eligibleComplexes: 0,
    masterComplexes: 0,
    exclusions: {},
    excludedComplexes: [],
    errors: [],
    reusedExistingCatalog: false,
    reusedLegacyCatalogVersion: "",
    reusedCandidateCatalog: false,
    tradeVerification: {
      districts: 0,
      requestedMonths: 0,
      successfulMonths: 0,
      failedMonths: 0,
      matchedComplexes: 0,
      reusedComplexes: 0,
    },
    basicInfoVerification: {
      requestedComplexes: 0,
      successfulComplexes: 0,
      failedComplexes: 0,
      coverageRatio: 0,
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
    transportCircuit: {
      threshold: config.maxConsecutiveTransportFailures,
      consecutiveFailures: 0,
      peakFailures: 0,
      opened: false,
      openedAtComplexKey: "",
    },
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
    const renderedReport = renderBatchReport(report);
    await Promise.all([
      writeFile(config.reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8"),
      writeFile(config.reportHtmlPath, renderedReport.html, "utf8"),
      writeFile(config.reportCsvPath, renderedReport.csv, "utf8"),
    ]);
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
  let existingCount = await d1.getCatalogCount(pilotCatalogVersion);
  if (
    existingCount === 0 &&
    !config.refreshCatalog &&
    config.catalogStrategy === "decade" &&
    config.approvalDateFrom === "20200101" &&
    config.approvalDateTo === "20291231"
  ) {
    existingCount = await d1.relabelCatalog({
      fromVersion: LEGACY_2020_CATALOG_VERSION,
      toVersion: pilotCatalogVersion,
      catalogScope: PILOT_SCOPE,
      approvalDateFrom: config.approvalDateFrom,
      approvalDateTo: config.approvalDateTo,
    });
    if (existingCount > 0) {
      report.catalog.reusedLegacyCatalogVersion =
        LEGACY_2020_CATALOG_VERSION;
      console.log(
        `기존 2020년대 검증 카탈로그 ${existingCount}개를 새 계산 모델로 이관했습니다.`
      );
    }
  }
  if (existingCount > 0 && !config.refreshCatalog) {
    report.catalog.reusedExistingCatalog = true;
    report.catalog.masterComplexes = existingCount;
    report.catalog.eligibleComplexes = await getSelectedCatalogCount();
    console.log(`기존 서울 시험 카탈로그 ${existingCount}개를 재사용합니다.`);
    return;
  }

  const seedCatalog = config.refreshCatalog
    ? []
    : await d1.listCatalog(pilotCatalogVersion);
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
  report.catalog.basicInfoVerification.requestedComplexes = candidates.length;
  const catalogResults = await mapWithConcurrency(candidates, 4, async (candidate) => {
    if (!hasBudget()) return null;
    try {
      const basicInfo = await molit.fetchAptBasicInfo(candidate.kaptCode);
      return buildPilotCatalogEntry(candidate, basicInfo, startedAt, {
        approvalDateFrom:
          config.catalogStrategy === "master"
            ? "00010101"
            : config.approvalDateFrom,
        approvalDateTo:
          config.catalogStrategy === "master"
            ? "99991231"
            : config.approvalDateTo,
      });
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
  report.catalog.basicInfoVerification.successfulComplexes = validResults.length;
  report.catalog.basicInfoVerification.failedComplexes =
    candidates.length - validResults.length;
  report.catalog.basicInfoVerification.coverageRatio = candidates.length
    ? validResults.length / candidates.length
    : 0;
  if (
    candidates.length > 0 &&
    report.catalog.basicInfoVerification.coverageRatio < 0.95
  ) {
    throw new Error(
      `K-apt basic-info coverage is too low: ${validResults.length}/${candidates.length}`
    );
  }
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
  const tradeVerification = report.catalog.tradeVerification;
  if (
    tradeVerification.requestedMonths > 0 &&
    tradeVerification.successfulMonths / tradeVerification.requestedMonths < 0.95
  ) {
    throw new Error(
      `RTMS verification coverage is too low: ` +
        `${tradeVerification.successfulMonths}/${tradeVerification.requestedMonths}`
    );
  }
  const buildingPurposeResults =
    config.catalogStrategy === "master"
      ? verifiedTradeMatches.filter((entry) => entry.eligible)
      : await verifyBuildingPurposes(
          verifiedTradeMatches.filter((entry) => entry.eligible)
        );
  if (config.catalogStrategy === "master") {
    report.catalog.buildingPurposeVerification.strategy =
      "permit-profile-household-validation";
  }
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
        approvalDate: result.approvalDate,
        households: result.households,
        buildingPurpose: result.buildingPurpose || "",
        reasons: result.exclusionReasons,
      });
    }
  }
  const eligible = sortPilotCatalog(finalResults.filter((result) => result.eligible));
  report.catalog.masterComplexes = eligible.length;
  report.catalog.eligibleComplexes = eligible.filter(isInSelectedDateRange).length;
  await d1.replaceCatalog(eligible, pilotCatalogVersion, {
    catalogScope: PILOT_SCOPE,
    replaceAll: config.catalogStrategy === "master",
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
  assertBudget("서울 K-apt 단지목록 조회 전");
  console.log("K-apt 서울 시도 단지목록을 조회합니다.");
  const candidatesByCode = new Map();
  const candidates = await molit.fetchAptListForSido(SEOUL_SIDO_CODE);
  report.catalog.sourceApartmentRows = candidates.length;
  for (const candidate of candidates) {
    if (candidate.kaptCode && !candidatesByCode.has(candidate.kaptCode)) {
      candidatesByCode.set(candidate.kaptCode, candidate);
    }
  }
  console.log(
    `K-apt 서울 단지목록 ${candidates.length}행에서 ` +
      `고유 단지 ${candidatesByCode.size}개를 찾았습니다.`
  );
  return [...candidatesByCode.values()];
}

async function collectProfiles() {
  if (config.catalogStrategy === "master") {
    await d1.syncCatalogProfileStatuses(pilotCatalogVersion);
    await d1.finalizeUndatedCatalog(pilotCatalogVersion);
  }
  const catalog = await d1.listCatalog(pilotCatalogVersion, getCatalogDateFilter());
  report.catalog.masterComplexes ||= await d1.getCatalogCount(pilotCatalogVersion);
  report.catalog.eligibleComplexes = catalog.length;
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
      retryAt > Date.now() &&
      !config.retryWaiting
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
    if (isTransportFailureResult(result)) {
      consecutiveTransportFailures += 1;
      report.collection.transportCircuit.consecutiveFailures =
        consecutiveTransportFailures;
      report.collection.transportCircuit.peakFailures = Math.max(
        report.collection.transportCircuit.peakFailures,
        consecutiveTransportFailures
      );
      if (
        consecutiveTransportFailures >=
        config.maxConsecutiveTransportFailures
      ) {
        report.collection.transportCircuit.opened = true;
        report.collection.transportCircuit.openedAtComplexKey =
          result.complexKey || "";
        stoppedReason ||= "permit-api-transport-circuit-open";
        break;
      }
    } else {
      consecutiveTransportFailures = 0;
      report.collection.transportCircuit.consecutiveFailures = 0;
    }
  }
  if (
    completedCount < config.maxComplexes &&
    report.collection.attempted >= config.maxAttempts
  ) {
    stoppedReason ||= "attempt-limit-reached";
  }
}

function isTransportFailureResult(result) {
  const details = result?.errorDetails || {};
  const message = `${details.resultMessage || ""} ${result?.error || ""}`;
  return (
    result?.status === "paused" &&
    details.retryable === true &&
    details.upstreamStatus == null &&
    (details.resultCode === "UNKNOWN_ERROR" || /fetch failed/i.test(message))
  );
}

function getCatalogDateFilter() {
  return config.catalogStrategy === "master"
    ? {
        approvalDateFrom: config.approvalDateFrom,
        approvalDateTo: config.approvalDateTo,
      }
    : {};
}

async function getSelectedCatalogCount() {
  return d1.getCatalogCount(pilotCatalogVersion, getCatalogDateFilter());
}

function isInSelectedDateRange(entry) {
  return (
    entry.approvalDate >= config.approvalDateFrom &&
    entry.approvalDate <= config.approvalDateTo
  );
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

  if (shouldRestartPermitOnlyRecord(record)) {
    record = createRecord(catalogRowToRequest(row));
  }

  if (
    config.retryFailed &&
    record.status === "failed" &&
    record.permitCollection?.status === "unavailable"
  ) {
    record.permitCollection.completedAt = "";
  }

  if (!record.permitCollection?.completedAt) {
    try {
      const permitResult = await collectPermitProfile(record);
      record.permitCollection = permitResult.diagnostics;
      if (permitResult.profile) {
        applyPermitProfile(record, permitResult.profile, permitResult.diagnostics);
      } else if (!config.enableLedgerFallback) {
        markPermitUnavailable(record, permitResult.diagnostics);
      } else {
        prepareLedgerFallback(record, permitResult.diagnostics);
      }
    } catch (error) {
      const permitFailureCount =
        Math.max(
          0,
          Number(record.permitCollection?.consecutiveFailures) || 0
        ) + 1;
      const details = normalizeErrorDetails(error, 1);
      record.permitCollection = {
        status: "error",
        completedAt: "",
        attemptedAt: new Date().toISOString(),
        consecutiveFailures: permitFailureCount,
        error: error.message,
        errorDetails: details,
      };
      record.errorDetails = details;
      record.error = `Permit API: ${error.message}`;
      pauseRecord(record);
      const delayIndex = Math.min(
        permitFailureCount - 1,
        PERMIT_RETRY_BACKOFF_MILLISECONDS.length - 1
      );
      record.nextRetryAt = new Date(
        Date.now() + PERMIT_RETRY_BACKOFF_MILLISECONDS[delayIndex]
      ).toISOString();
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
    if (
      record.status === "ready" ||
      record.status === "paused" ||
      record.status === "failed"
    ) {
      return buildCollectionResult(row, record);
    }
  }
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

function shouldRestartPermitOnlyRecord(record) {
  if (config.enableLedgerFallback || record.profile) return false;
  return (
    record.status === "paused" ||
    record.status === "upstream-pending" ||
    record.permitCollection?.status === "ledger-fallback" ||
    (record.sourcePlans || []).length > 0
  );
}

async function collectPermitProfile(record) {
  const source = record.requestedSource || record.source;
  const attemptedAt = new Date().toISOString();
  const attempts = [];
  const services = [
    {
      service: "housing-permit",
      typeOperation: "getHpMgmCoopTpOulnInfo",
      areaOperation: "getHpExposPubuseAreaInfo",
    },
    {
      service: "building-permit",
      typeOperation: "getApHsTpInfo",
      areaOperation: "getApExposPubuseAreaInfo",
    },
  ];

  for (const candidate of services) {
    assertBudget(candidate.typeOperation);
    const typeResult = await molit.fetchPermitRows(
      candidate.service,
      candidate.typeOperation,
      source
    );
    const attempt = {
      service: candidate.service,
      typeOperation: candidate.typeOperation,
      areaOperation: candidate.areaOperation,
      typeRows: typeResult.items.length,
      areaRows: 0,
      pageCount: typeResult.pageCount,
      status: typeResult.items.length ? "type-found" : "not-found",
    };
    attempts.push(attempt);
    if (!typeResult.items.length) continue;

    assertBudget(candidate.areaOperation);
    const areaResult = await molit.fetchPermitRows(
      candidate.service,
      candidate.areaOperation,
      source
    );
    attempt.areaRows = areaResult.items.length;
    attempt.pageCount += areaResult.pageCount;
    const profile = buildPermitSupplyProfile({
      complexKey: record.complexKey,
      source,
      service: candidate.service,
      typeRows: typeResult.items,
      areaRows: areaResult.items,
      expectedHouseholds: record.expectedHouseholds,
    });
    attempt.matchedTypeRows = Number(profile.provenance?.matchedTypeRows) || 0;
    attempt.matchedHouseholds = Number(profile.unitCount) || 0;
    attempt.validation = profile.householdValidation;
    const isComplete =
      profile.groups.length > 0 &&
      (profile.householdValidation.status === "matched" ||
        profile.householdValidation.status === "unavailable");
    attempt.status = isComplete ? "ready" : "validation-failed";
    if (isComplete) {
      return {
        profile,
        diagnostics: {
          status: "ready",
          strategy: candidate.service,
          source,
          attempts,
          attemptedAt,
          completedAt: new Date().toISOString(),
        },
      };
    }
  }

  return {
    profile: null,
    diagnostics: {
      status: "ledger-fallback",
      strategy: "building-ledger",
      source,
      attempts,
      attemptedAt,
      completedAt: new Date().toISOString(),
    },
  };
}

function applyPermitProfile(record, profile, diagnostics) {
  const totalRows = diagnostics.attempts.reduce(
    (sum, attempt) => sum + attempt.typeRows + attempt.areaRows,
    0
  );
  const totalPages = diagnostics.attempts.reduce(
    (sum, attempt) => sum + attempt.pageCount,
    0
  );
  record.profile = profile;
  record.status = "ready";
  record.calculationVersion = SUPPLY_CALCULATION_VERSION;
  record.totalRows = totalRows;
  record.totalPages = totalPages;
  record.lastSuccessfulPage = totalPages;
  record.nextPage = totalPages + 1;
  record.error = "";
  record.errorDetails = null;
  record.failedPage = null;
  record.nextRetryAt = "";
  record.fetchedAt = new Date().toISOString();
}

function markPermitUnavailable(record, diagnostics) {
  const attempts = diagnostics.attempts || [];
  const hasRows = attempts.some(
    (attempt) => attempt.typeRows > 0 || attempt.areaRows > 0
  );
  const resultCode = hasRows
    ? "PERMIT_PROFILE_VALIDATION_FAILED"
    : "PERMIT_PROFILE_NOT_FOUND";
  const resultMessage = hasRows
    ? "Permit rows were found, but apartment type areas or household totals did not match."
    : "No apartment type rows were found in the approved permit services.";
  record.status = "failed";
  record.errorDetails = {
    operation: "permit-profile",
    pageNo: 1,
    upstreamStatus: null,
    resultCode,
    resultMessage,
    retryable: true,
  };
  record.error = resultMessage;
  record.failedPage = 1;
  record.nextRetryAt = "";
  record.leaseUntil = "";
  diagnostics.status = "unavailable";
  diagnostics.strategy = "permit-only";
}

function prepareLedgerFallback(record, diagnostics) {
  diagnostics.status = "ledger-fallback";
  diagnostics.strategy = "building-ledger";
  record.profile = null;
  record.status = "building";
  record.error = "";
  record.errorDetails = null;
  record.failedPage = null;
  record.nextRetryAt = "";
  record.leaseUntil = "";
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
    collectionStrategy:
      record.profile?.provenance?.strategy ||
      record.permitCollection?.strategy ||
      "building-ledger",
    permitCollection: record.permitCollection || null,
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
  console.log(
    `서울 ${config.approvalDateFrom}~${config.approvalDateTo} ` +
      `배치 상태: ${report.status}`
  );
  if (config.catalogStrategy === "master") {
    console.log(`서울 공통 카탈로그: ${report.catalog.masterComplexes}개`);
  }
  console.log(`카탈로그 대상: ${report.catalog.eligibleComplexes}개`);
  console.log(`이번 실행 완료: ${completedCount}개`);
  console.log(`공공데이터 API 호출: ${apiCallCount}회`);
  console.log(
    `보고서: ${config.reportPath}, ${config.reportHtmlPath}, ` +
      `${config.reportCsvPath}`
  );
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

function readYmd(name, fallback) {
  const value = String(process.env[name] || fallback).trim();
  if (!/^\d{8}$/.test(value)) {
    throw new Error(`${name} must use YYYYMMDD format.`);
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`${name} must be a valid calendar date.`);
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
