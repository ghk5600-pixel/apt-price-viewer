import { SUPPLY_CALCULATION_VERSION } from "./supply-area.js";

const TABLE_NAME = "supply_profile_cache";

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
