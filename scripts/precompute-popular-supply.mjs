import { writeFile } from "node:fs/promises";
import { SUPPLY_CALCULATION_VERSION } from "../functions/_shared/supply-area.js";
import { createD1RestClient } from "./lib/d1-rest-client.mjs";

const baseUrl = normalizeBaseUrl(
  process.env.SUPPLY_PROFILE_BASE_URL || "https://apt-price-viewer.pages.dev"
);
const maxComplexes = positiveInteger(process.env.POPULAR_MAX_COMPLEXES, 10);
const maxPolls = positiveInteger(process.env.POPULAR_MAX_POLLS, 20);
const reportPath =
  process.env.POPULAR_SUPPLY_REPORT_PATH || "popular-supply-report.json";
const retryFailed = process.env.POPULAR_RETRY_FAILED === "1";
const d1 = createD1RestClient({
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
  databaseId: process.env.CLOUDFLARE_D1_DATABASE_ID,
  apiToken: process.env.CLOUDFLARE_API_TOKEN,
});

await ensureUsageSchema();
const candidates = await listCandidates();
const results = [];
for (const candidate of candidates) {
  const result = await precomputeCandidate(candidate);
  results.push(result);
  console.log(
    `${candidate.complex_key}: ${result.status}` +
      (result.error ? ` - ${result.error}` : "")
  );
}

const report = {
  version: "v2026.08.11-01-rc.5",
  calculationVersion: SUPPLY_CALCULATION_VERSION,
  baseUrl,
  startedAt: results[0]?.startedAt || new Date().toISOString(),
  finishedAt: new Date().toISOString(),
  selectedCount: candidates.length,
  readyCount: results.filter((result) => result.status === "ready").length,
  results,
};
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

async function ensureUsageSchema() {
  await d1.query(
    `CREATE TABLE IF NOT EXISTS supply_profile_usage (
      complex_key TEXT PRIMARY KEY,
      request_count INTEGER NOT NULL DEFAULT 0,
      registration_count INTEGER NOT NULL DEFAULT 0,
      last_registration_token TEXT NOT NULL DEFAULT '',
      request_json TEXT NOT NULL DEFAULT '{}',
      latest_status TEXT NOT NULL DEFAULT '',
      last_error_code TEXT NOT NULL DEFAULT '',
      next_retry_at TEXT NOT NULL DEFAULT '',
      last_requested_at TEXT NOT NULL DEFAULT '',
      last_registered_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    )`
  );
}

async function listCandidates() {
  const retryFailedSql = retryFailed ? "" : "AND u.latest_status <> 'failed'";
  const result = await d1.query(
    `SELECT u.complex_key, u.request_json, u.registration_count,
            u.request_count, u.latest_status, u.next_retry_at
       FROM supply_profile_usage u
       LEFT JOIN supply_profile_cache c
         ON c.complex_key = u.complex_key
      WHERE u.registration_count > 0
        AND u.request_json <> '{}'
        AND (
          c.complex_key IS NULL OR
          c.calculation_version <> ?1 OR
          c.status <> 'ready'
        )
        AND (
          u.next_retry_at = '' OR
          u.next_retry_at <= ?2
        )
        ${retryFailedSql}
      ORDER BY u.registration_count DESC,
               u.request_count DESC,
               u.last_registered_at DESC
      LIMIT ?3`,
    [SUPPLY_CALCULATION_VERSION, new Date().toISOString(), maxComplexes]
  );
  return result.results || [];
}

async function precomputeCandidate(candidate) {
  const startedAt = new Date().toISOString();
  let requestData;
  try {
    requestData = JSON.parse(candidate.request_json || "{}");
  } catch {
    return {
      complexKey: candidate.complex_key,
      status: "invalid-request",
      error: "D1 request_json을 해석하지 못했습니다.",
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }

  const url = buildSupplyProfileUrl(requestData);
  let lastPayload = {};
  for (let poll = 0; poll < maxPolls; poll += 1) {
    if (poll === 0 && retryFailed) url.searchParams.set("retry", "1");
    else url.searchParams.delete("retry");

    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    lastPayload = await response.json().catch(() => ({}));
    if (lastPayload.status === "ready") {
      return finishResult(candidate, startedAt, lastPayload, poll + 1);
    }
    if (["failed", "upstream-pending"].includes(lastPayload.status)) {
      return finishResult(candidate, startedAt, lastPayload, poll + 1);
    }
    if (!response.ok && response.status !== 202) {
      return finishResult(
        candidate,
        startedAt,
        {
          ...lastPayload,
          status: "http-error",
          error: lastPayload.error || `HTTP ${response.status}`,
        },
        poll + 1
      );
    }
    const retryAfterMs = Math.max(750, Number(lastPayload.retryAfterMs) || 750);
    if (retryAfterMs > 30_000) break;
    await sleep(retryAfterMs);
  }
  return finishResult(candidate, startedAt, lastPayload, maxPolls);
}

function buildSupplyProfileUrl(requestData) {
  const url = new URL("/api/supply-profile", baseUrl);
  url.searchParams.set("complexKey", requestData.complexKey || "");
  const source = requestData.source || {};
  Object.entries(source).forEach(([key, value]) => {
    if (value !== null && value !== undefined && String(value).trim()) {
      url.searchParams.set(key, String(value));
    }
  });
  const metadata = requestData.metadata || {};
  const metadataParams = {
    complexName: metadata.complexName,
    roadAddress: metadata.roadAddress,
    lotAddress: metadata.lotAddress,
    approvalDate: metadata.approvalDate,
  };
  Object.entries(metadataParams).forEach(([key, value]) => {
    if (value !== null && value !== undefined && String(value).trim()) {
      url.searchParams.set(key, String(value));
    }
  });
  if (requestData.expectedHouseholds) {
    url.searchParams.set(
      "expectedHouseholds",
      String(requestData.expectedHouseholds)
    );
  }
  return url;
}

function finishResult(candidate, startedAt, payload, polls) {
  return {
    complexKey: candidate.complex_key,
    registrationCount: Number(candidate.registration_count) || 0,
    requestCount: Number(candidate.request_count) || 0,
    status: payload.status || "incomplete",
    error: payload.error || "",
    errorCode: payload.errorDetails?.resultCode || "",
    progress: Number(payload.progress) || 0,
    polls,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/$/, "");
}

function positiveInteger(value, fallback) {
  const number = Math.round(Number(value) || 0);
  return number > 0 ? number : fallback;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
