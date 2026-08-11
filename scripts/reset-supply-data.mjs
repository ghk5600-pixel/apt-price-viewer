import { writeFile } from "node:fs/promises";
import { createD1RestClient } from "./lib/d1-rest-client.mjs";

const REQUIRED_CONFIRMATION = "RESET_SUPPLY_CALCULATIONS";
const confirmation = String(process.env.SUPPLY_RESET_CONFIRMATION || "").trim();
if (confirmation !== REQUIRED_CONFIRMATION) {
  throw new Error(
    `SUPPLY_RESET_CONFIRMATION must equal ${REQUIRED_CONFIRMATION}.`
  );
}

const d1 = createD1RestClient({
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
  databaseId: process.env.CLOUDFLARE_D1_DATABASE_ID,
  apiToken: process.env.CLOUDFLARE_API_TOKEN,
});

await d1.ensureSchema();
const result = await d1.resetSupplyCalculations();
const report = {
  version: "v2026.08.11-01-rc.5",
  scope: "supply-calculations-only",
  preserved: ["supply_batch_catalog apartment metadata"],
  reset: [
    "supply_profile_cache rows",
    "supply_batch_catalog calculation status",
    "supply_batch_runs rows",
  ],
  ...result,
};

const reportPath =
  process.env.SUPPLY_RESET_REPORT_PATH || "supply-reset-report.json";
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

console.log(
  `Supply calculations reset: ${result.before.profiles} profiles removed; ` +
    `${result.after.catalog} catalog rows preserved and pending.`
);
