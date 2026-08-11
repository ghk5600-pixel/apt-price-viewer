import { writeFile } from "node:fs/promises";
import { createD1RestClient } from "./lib/d1-rest-client.mjs";

const reportPath =
  process.env.SUPPLY_PROGRESS_REPORT_PATH || "supply-progress-report.json";
const d1 = createD1RestClient({
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
  databaseId: process.env.CLOUDFLARE_D1_DATABASE_ID,
  apiToken: process.env.CLOUDFLARE_API_TOKEN,
});

const [catalog, profiles, runs, recentIncomplete] = await Promise.all([
  d1.query(
    `SELECT catalog_version, catalog_scope, profile_status,
            COUNT(*) AS complex_count,
            SUM(attempt_count) AS attempt_count,
            MAX(updated_at) AS last_updated_at
       FROM supply_batch_catalog
      GROUP BY catalog_version, catalog_scope, profile_status
      ORDER BY catalog_version, profile_status`
  ),
  d1.query(
    `SELECT calculation_version, status, COUNT(*) AS profile_count,
            MAX(updated_at) AS last_updated_at
       FROM supply_profile_cache
      GROUP BY calculation_version, status
      ORDER BY calculation_version, status`
  ),
  d1.query(
    `SELECT run_id, scope, mode, status, catalog_count, completed_count,
            api_call_count, started_at, finished_at, updated_at
       FROM supply_batch_runs
      ORDER BY started_at DESC
      LIMIT 20`
  ),
  d1.query(
    `SELECT complex_key, calculation_version, status, updated_at,
            json_extract(record_json, '$.metadata.complexName') AS complex_name,
            json_extract(record_json, '$.errorDetails.resultCode') AS error_code,
            json_extract(record_json, '$.errorDetails.resultMessage') AS error_message,
            json_extract(record_json, '$.errorDetails.upstreamStatus') AS upstream_status,
            json_extract(record_json, '$.failedPage') AS failed_page,
            json_extract(record_json, '$.lastSuccessfulPage') AS last_successful_page,
            json_extract(record_json, '$.totalPages') AS total_pages,
            json_extract(record_json, '$.pageSize') AS page_size,
            json_extract(record_json, '$.collectionState.processedUnits') AS processed_units,
            json_extract(record_json, '$.expectedHouseholds') AS expected_households,
            json_extract(record_json, '$.consecutiveFailures') AS consecutive_failures
       FROM supply_profile_cache
      WHERE status <> 'ready'
      ORDER BY updated_at DESC
      LIMIT 100`
  ),
]);

const report = {
  version: "v2026.08.11-01-rc.3",
  generatedAt: new Date().toISOString(),
  catalog: catalog.results || [],
  profiles: profiles.results || [],
  recentRuns: runs.results || [],
  recentIncomplete: recentIncomplete.results || [],
};

await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

console.log(`Supply progress generated at ${report.generatedAt}`);
for (const row of report.catalog) {
  console.log(
    `catalog ${row.catalog_version || "legacy"} ${row.profile_status}: ` +
      `${row.complex_count} complexes, ${row.attempt_count || 0} attempts`
  );
}
for (const row of report.profiles) {
  console.log(
    `profiles ${row.calculation_version || "legacy"} ${row.status}: ` +
      `${row.profile_count}`
  );
}
for (const row of report.recentIncomplete.slice(0, 20)) {
  console.log(
    `incomplete ${row.complex_key} ${row.status}: ` +
      `${row.error_code || 'no-error'} page ${row.failed_page || '-'} ` +
      `(${row.last_successful_page || 0}/${row.total_pages || '?'}, ` +
      `${row.processed_units || 0}/${row.expected_households || '?'} units)`
  );
}
