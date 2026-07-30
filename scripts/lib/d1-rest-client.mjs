import { SUPPLY_CALCULATION_VERSION } from "../../functions/_shared/supply-area.js";

const PILOT_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS supply_profile_cache (
    complex_key TEXT PRIMARY KEY,
    calculation_version TEXT NOT NULL,
    status TEXT NOT NULL,
    record_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS supply_batch_catalog (
    complex_key TEXT PRIMARY KEY,
    kapt_code TEXT NOT NULL UNIQUE,
    complex_name TEXT NOT NULL,
    bjd_code TEXT NOT NULL,
    sido_name TEXT NOT NULL,
    sigungu_name TEXT NOT NULL,
    eupmyeondong_name TEXT NOT NULL,
    apartment_type TEXT NOT NULL,
    sale_type TEXT NOT NULL DEFAULT '',
    approval_date TEXT NOT NULL,
    households INTEGER NOT NULL,
    building_count INTEGER NOT NULL DEFAULT 0,
    lot_address TEXT NOT NULL,
    road_address TEXT NOT NULL DEFAULT '',
    plat_gb_cd TEXT NOT NULL DEFAULT '0',
    bun TEXT NOT NULL,
    ji TEXT NOT NULL,
    trade_match_count INTEGER NOT NULL DEFAULT 0,
    trade_match_method TEXT NOT NULL DEFAULT '',
    last_trade_date TEXT NOT NULL DEFAULT '',
    catalog_version TEXT NOT NULL DEFAULT '',
    priority_rank INTEGER NOT NULL,
    profile_status TEXT NOT NULL DEFAULT 'pending',
    profile_calculation_version TEXT NOT NULL DEFAULT '',
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NOT NULL DEFAULT '',
    discovered_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_supply_batch_catalog_queue
    ON supply_batch_catalog (profile_status, priority_rank, approval_date)`,
  `CREATE INDEX IF NOT EXISTS idx_supply_batch_catalog_region
    ON supply_batch_catalog (sido_name, approval_date)`,
  `CREATE TABLE IF NOT EXISTS supply_batch_runs (
    run_id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    mode TEXT NOT NULL,
    status TEXT NOT NULL,
    catalog_count INTEGER NOT NULL DEFAULT 0,
    completed_count INTEGER NOT NULL DEFAULT 0,
    api_call_count INTEGER NOT NULL DEFAULT 0,
    report_json TEXT NOT NULL DEFAULT '{}',
    started_at TEXT NOT NULL,
    finished_at TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_supply_batch_runs_started
    ON supply_batch_runs (started_at)`,
];

export function createD1RestClient({
  accountId,
  databaseId,
  apiToken,
  fetchImpl = globalThis.fetch,
}) {
  if (!accountId) throw new Error("CLOUDFLARE_ACCOUNT_ID is required.");
  if (!databaseId) throw new Error("CLOUDFLARE_D1_DATABASE_ID is required.");
  if (!apiToken) throw new Error("CLOUDFLARE_API_TOKEN is required.");
  const endpoint =
    `https://api.cloudflare.com/client/v4/accounts/${accountId}` +
    `/d1/database/${databaseId}/query`;

  async function query(sql, params = []) {
    const normalizedParams = params.map((value) =>
      value === null || value === undefined ? null : String(value)
    );
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sql, params: normalizedParams }),
      signal: AbortSignal.timeout(30_000),
    });
    const payload = await response.json().catch(() => ({}));
    const result = Array.isArray(payload.result) ? payload.result[0] : payload.result;
    if (!response.ok || !payload.success || result?.success === false) {
      const details = [
        ...(Array.isArray(payload.errors) ? payload.errors : []),
        ...(Array.isArray(result?.errors) ? result.errors : []),
      ]
        .map((error) => error?.message || error?.code)
        .filter(Boolean)
        .join(", ");
      throw new Error(`Cloudflare D1 query failed: ${details || response.status}`);
    }
    return result || { results: [] };
  }

  return {
    query,

    async ensureSchema() {
      for (const sql of PILOT_SCHEMA) await query(sql);
      await ensureColumns(query, "supply_batch_catalog", {
        sale_type: "TEXT NOT NULL DEFAULT ''",
        trade_match_count: "INTEGER NOT NULL DEFAULT 0",
        trade_match_method: "TEXT NOT NULL DEFAULT ''",
        last_trade_date: "TEXT NOT NULL DEFAULT ''",
        catalog_version: "TEXT NOT NULL DEFAULT ''",
      });
    },

    async getCatalogCount(catalogVersion = "") {
      const result = catalogVersion
        ? await query(
            "SELECT COUNT(*) AS count FROM supply_batch_catalog WHERE catalog_version = ?1",
            [catalogVersion]
          )
        : await query("SELECT COUNT(*) AS count FROM supply_batch_catalog");
      return Number(result.results?.[0]?.count || 0);
    },

    async replaceCatalog(entries, catalogVersion) {
      const sql = `INSERT INTO supply_batch_catalog (
          complex_key, kapt_code, complex_name, bjd_code, sido_name, sigungu_name,
          eupmyeondong_name, apartment_type, sale_type, approval_date, households,
          building_count, lot_address, road_address, plat_gb_cd, bun, ji,
          trade_match_count, trade_match_method, last_trade_date, catalog_version,
          priority_rank,
          profile_status, profile_calculation_version, attempt_count, last_error,
          discovered_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
          ?16, ?17, ?18, ?19, ?20, ?21, ?22, 'pending', '', 0, '', ?23, ?24
        )
        ON CONFLICT(complex_key) DO UPDATE SET
          kapt_code = excluded.kapt_code,
          complex_name = excluded.complex_name,
          bjd_code = excluded.bjd_code,
          sido_name = excluded.sido_name,
          sigungu_name = excluded.sigungu_name,
          eupmyeondong_name = excluded.eupmyeondong_name,
          apartment_type = excluded.apartment_type,
          sale_type = excluded.sale_type,
          approval_date = excluded.approval_date,
          households = excluded.households,
          building_count = excluded.building_count,
          lot_address = excluded.lot_address,
          road_address = excluded.road_address,
          plat_gb_cd = excluded.plat_gb_cd,
          bun = excluded.bun,
          ji = excluded.ji,
          trade_match_count = excluded.trade_match_count,
          trade_match_method = excluded.trade_match_method,
          last_trade_date = excluded.last_trade_date,
          catalog_version = excluded.catalog_version,
          priority_rank = excluded.priority_rank,
          discovered_at = excluded.discovered_at,
          updated_at = excluded.updated_at`;
      for (const entry of entries) {
        const updatedAt = new Date().toISOString();
        await query(sql, [
          entry.complexKey,
          entry.kaptCode,
          entry.complexName,
          entry.bjdCode,
          entry.sidoName,
          entry.sigunguName,
          entry.eupmyeondongName,
          entry.apartmentType,
          entry.saleType,
          entry.approvalDate,
          entry.households,
          entry.buildingCount,
          entry.lotAddress,
          entry.roadAddress,
          entry.platGbCd,
          entry.bun,
          entry.ji,
          entry.tradeMatchCount,
          entry.tradeMatchMethod,
          entry.lastTradeDate,
          catalogVersion,
          entry.priorityRank,
          entry.discoveredAt,
          updatedAt,
        ]);
      }
      await query(
        "DELETE FROM supply_batch_catalog WHERE catalog_version <> ?1",
        [catalogVersion]
      );
    },

    async listCatalog(catalogVersion = "") {
      const result = await query(
        `SELECT * FROM supply_batch_catalog
         WHERE sido_name = '서울특별시' AND approval_date >= '20200101'
           AND (?1 = '' OR catalog_version = ?1)
         ORDER BY priority_rank ASC`,
        [catalogVersion]
      );
      return result.results || [];
    },

    async getProfileRecord(complexKey) {
      const result = await query(
        "SELECT record_json FROM supply_profile_cache WHERE complex_key = ?1",
        [complexKey]
      );
      const value = result.results?.[0]?.record_json;
      if (!value) return null;
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    },

    async putProfileRecord(complexKey, record) {
      const updatedAt = record.updatedAt || new Date().toISOString();
      const recordJson = JSON.stringify(record);
      try {
        await query(
          `INSERT INTO supply_profile_cache
            (complex_key, calculation_version, status, record_json, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5)
           ON CONFLICT(complex_key) DO UPDATE SET
             calculation_version = excluded.calculation_version,
             status = excluded.status,
             record_json = excluded.record_json,
             updated_at = excluded.updated_at`,
          [
            complexKey,
            record.calculationVersion || SUPPLY_CALCULATION_VERSION,
            record.status || "building",
            recordJson,
            updatedAt,
          ]
        );
      } catch (error) {
        const byteLength = new TextEncoder().encode(recordJson).length;
        throw new Error(
          `${error.message} (profile ${complexKey}: ${byteLength} bytes, ` +
          `${record.collectionState?.patterns?.length || 0} patterns, ` +
          `${record.collectionState?.seenUnitHashes?.length || 0} unit hashes)`
        );
      }
    },

    async updateCatalogProfile(
      complexKey,
      { status, calculationVersion = "", lastError = "", incrementAttempt = false }
    ) {
      await query(
        `UPDATE supply_batch_catalog SET
           profile_status = ?2,
           profile_calculation_version = ?3,
           last_error = ?4,
           attempt_count = attempt_count + ?5,
           updated_at = ?6
         WHERE complex_key = ?1`,
        [
          complexKey,
          status,
          calculationVersion,
          lastError,
          incrementAttempt ? 1 : 0,
          new Date().toISOString(),
        ]
      );
    },

    async saveRun(run) {
      await query(
        `INSERT INTO supply_batch_runs (
           run_id, scope, mode, status, catalog_count, completed_count,
           api_call_count, report_json, started_at, finished_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(run_id) DO UPDATE SET
           status = excluded.status,
           catalog_count = excluded.catalog_count,
           completed_count = excluded.completed_count,
           api_call_count = excluded.api_call_count,
           report_json = excluded.report_json,
           finished_at = excluded.finished_at,
           updated_at = excluded.updated_at`,
        [
          run.runId,
          run.scope,
          run.mode,
          run.status,
          run.catalogCount,
          run.completedCount,
          run.apiCallCount,
          JSON.stringify(run.report || {}),
          run.startedAt,
          run.finishedAt || "",
          new Date().toISOString(),
        ]
      );
    },
  };
}

async function ensureColumns(query, tableName, columns) {
  const result = await query(`PRAGMA table_info(${tableName})`);
  const existing = new Set((result.results || []).map((column) => column.name));
  for (const [name, definition] of Object.entries(columns)) {
    if (!existing.has(name)) {
      await query(`ALTER TABLE ${tableName} ADD COLUMN ${name} ${definition}`);
    }
  }
}
