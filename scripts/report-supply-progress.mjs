import { writeFile } from "node:fs/promises";
import { createD1RestClient } from "./lib/d1-rest-client.mjs";

const reportPath =
  process.env.SUPPLY_PROGRESS_REPORT_PATH || "supply-progress-report.json";
const d1 = createD1RestClient({
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
  databaseId: process.env.CLOUDFLARE_D1_DATABASE_ID,
  apiToken: process.env.CLOUDFLARE_API_TOKEN,
});

const [catalog, profiles, runs] = await Promise.all([
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
]);

const report = {
  version: "v2026.08.06-01-rc.2",
  generatedAt: new Date().toISOString(),
  catalog: catalog.results || [],
  profiles: profiles.results || [],
  recentRuns: runs.results || [],
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
