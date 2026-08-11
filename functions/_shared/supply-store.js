import { SUPPLY_CALCULATION_VERSION } from "./supply-area.js";

const TABLE_NAME = "supply_profile_cache";
const USAGE_TABLE_NAME = "supply_profile_usage";

export async function createSupplyProfileStore(env) {
  if (env?.SUPPLY_DB) {
    await ensureD1Schema(env.SUPPLY_DB);
    return createD1Store(env.SUPPLY_DB);
  }
  if (typeof caches !== "undefined" && caches.default) {
    return createEdgeCacheStore(caches.default);
  }
  return createMemoryStore();
}

async function ensureD1Schema(db) {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
        complex_key TEXT PRIMARY KEY,
        calculation_version TEXT NOT NULL,
        status TEXT NOT NULL,
        record_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`
    )
    .run();
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS ${USAGE_TABLE_NAME} (
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
    )
    .run();
  await db
    .prepare(
      `CREATE INDEX IF NOT EXISTS idx_supply_profile_usage_priority
       ON ${USAGE_TABLE_NAME}
         (registration_count DESC, request_count DESC, last_requested_at DESC)`
    )
    .run();
}

function createD1Store(db) {
  return {
    mode: "d1",
    async get(complexKey) {
      const row = await db
        .prepare(`SELECT record_json FROM ${TABLE_NAME} WHERE complex_key = ?1`)
        .bind(complexKey)
        .first();
      return parseRecord(row?.record_json);
    },
    async put(complexKey, record) {
      const updatedAt = record.updatedAt || new Date().toISOString();
      await db
        .prepare(
          `INSERT INTO ${TABLE_NAME}
            (complex_key, calculation_version, status, record_json, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5)
           ON CONFLICT(complex_key) DO UPDATE SET
             calculation_version = excluded.calculation_version,
             status = excluded.status,
             record_json = excluded.record_json,
             updated_at = excluded.updated_at`
        )
        .bind(
          complexKey,
          record.calculationVersion || SUPPLY_CALCULATION_VERSION,
          record.status || "building",
          JSON.stringify(record),
          updatedAt
        )
        .run();
      await syncD1UsageStatus(db, complexKey, record, updatedAt);
    },
    async noteAccess(complexKey, access = {}) {
      const now = new Date().toISOString();
      const registrationToken = String(access.registrationToken || "").trim();
      const requestJson = access.requestData
        ? JSON.stringify(toStoredRequest(access.requestData))
        : "{}";
      await db
        .prepare(
          `INSERT INTO ${USAGE_TABLE_NAME}
            (complex_key, request_count, registration_count,
             last_registration_token, request_json, latest_status,
             last_error_code, next_retry_at, last_requested_at,
             last_registered_at, updated_at)
           VALUES (?1, 1, ?2, ?3, ?4, ?5, '', '', ?6, ?7, ?6)
           ON CONFLICT(complex_key) DO UPDATE SET
             request_count = ${USAGE_TABLE_NAME}.request_count + 1,
             registration_count = ${USAGE_TABLE_NAME}.registration_count +
               CASE
                 WHEN excluded.last_registration_token <> ''
                  AND excluded.last_registration_token <>
                    ${USAGE_TABLE_NAME}.last_registration_token
                 THEN 1 ELSE 0
               END,
             last_registration_token =
               CASE WHEN excluded.last_registration_token <> ''
                 THEN excluded.last_registration_token
                 ELSE ${USAGE_TABLE_NAME}.last_registration_token END,
             request_json =
               CASE WHEN excluded.request_json <> '{}'
                 THEN excluded.request_json
                 ELSE ${USAGE_TABLE_NAME}.request_json END,
             latest_status =
               CASE WHEN excluded.latest_status <> ''
                 THEN excluded.latest_status
                 ELSE ${USAGE_TABLE_NAME}.latest_status END,
             last_requested_at = excluded.last_requested_at,
             last_registered_at =
               CASE WHEN excluded.last_registration_token <> ''
                 THEN excluded.last_registered_at
                 ELSE ${USAGE_TABLE_NAME}.last_registered_at END,
             updated_at = excluded.updated_at`
        )
        .bind(
          complexKey,
          registrationToken ? 1 : 0,
          registrationToken,
          requestJson,
          String(access.status || ""),
          now,
          registrationToken ? now : ""
        )
        .run();
    },
  };
}

function createEdgeCacheStore(cache) {
  return {
    mode: "edge-cache",
    async get(complexKey) {
      const response = await cache.match(cacheKey(complexKey));
      if (!response) return null;
      return parseRecord(await response.text());
    },
    async put(complexKey, record) {
      await cache.put(
        cacheKey(complexKey),
        new Response(JSON.stringify(record), {
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "public, max-age=31536000",
          },
        })
      );
    },
    async noteAccess() {},
  };
}

function createMemoryStore() {
  const records = globalThis.__supplyProfileRecords || new Map();
  globalThis.__supplyProfileRecords = records;
  return {
    mode: "memory",
    async get(complexKey) {
      return records.get(complexKey) || null;
    },
    async put(complexKey, record) {
      records.set(complexKey, record);
    },
    async noteAccess() {},
  };
}

async function syncD1UsageStatus(db, complexKey, record, updatedAt) {
  const errorCode = String(record?.errorDetails?.resultCode || "");
  await db
    .prepare(
      `INSERT INTO ${USAGE_TABLE_NAME}
        (complex_key, request_count, registration_count,
         last_registration_token, request_json, latest_status,
         last_error_code, next_retry_at, last_requested_at,
         last_registered_at, updated_at)
       VALUES (?1, 0, 0, '', '{}', ?2, ?3, ?4, '', '', ?5)
       ON CONFLICT(complex_key) DO UPDATE SET
         latest_status = excluded.latest_status,
         last_error_code = excluded.last_error_code,
         next_retry_at = excluded.next_retry_at,
         updated_at = excluded.updated_at`
    )
    .bind(
      complexKey,
      String(record?.status || ""),
      errorCode,
      String(record?.nextRetryAt || ""),
      updatedAt
    )
    .run();
}

function toStoredRequest(requestData) {
  return {
    complexKey: String(requestData.complexKey || ""),
    source: requestData.source || null,
    metadata: requestData.metadata || null,
    expectedHouseholds: requestData.expectedHouseholds || null,
  };
}

function cacheKey(complexKey) {
  return new Request(
    `https://supply-profile-cache.invalid/${SUPPLY_CALCULATION_VERSION}/${encodeURIComponent(complexKey)}`
  );
}

function parseRecord(value) {
  if (!value) return null;
  try {
    return typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return null;
  }
}
