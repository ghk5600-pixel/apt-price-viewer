import { SUPPLY_CALCULATION_VERSION } from "./supply-area.js";

const TABLE_NAME = "supply_profile_cache";
const USAGE_TABLE_NAME = "supply_profile_usage";
const CASE_TABLE_NAME = "supply_review_case";
const EVENT_TABLE_NAME = "supply_review_event";
const MANUAL_TABLE_NAME = "supply_manual_profile";

export async function createSupplyProfileStore(env) {
  if (env?.SUPPLY_DB) {
    await ensureD1SchemaOnce(env.SUPPLY_DB);
    return createD1Store(env.SUPPLY_DB);
  }
  if (typeof caches !== "undefined" && caches.default) {
    return createEdgeCacheStore(caches.default);
  }
  return createMemoryStore();
}

async function ensureD1SchemaOnce(db) {
  if (globalThis.__supplyProfileD1SchemaReady) return;
  await ensureD1Schema(db);
  globalThis.__supplyProfileD1SchemaReady = true;
}

async function ensureD1Schema(db) {
  const statements = [
    db.prepare(
      `CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
        complex_key TEXT PRIMARY KEY,
        calculation_version TEXT NOT NULL,
        status TEXT NOT NULL,
        record_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`
    ),
    db.prepare(
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
    ),
    db.prepare(
      `CREATE INDEX IF NOT EXISTS idx_supply_profile_usage_priority
       ON ${USAGE_TABLE_NAME}
          (registration_count DESC, request_count DESC, last_requested_at DESC)`
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS ${CASE_TABLE_NAME} (
        complex_key TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        reason_code TEXT NOT NULL DEFAULT '',
        request_json TEXT NOT NULL DEFAULT '{}',
        record_json TEXT NOT NULL DEFAULT '{}',
        first_detected_at TEXT NOT NULL,
        last_detected_at TEXT NOT NULL,
        last_auto_retry_at TEXT NOT NULL DEFAULT '',
        resolved_at TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      )`
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS ${EVENT_TABLE_NAME} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        complex_key TEXT NOT NULL,
        event_type TEXT NOT NULL,
        detail_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      )`
    ),
    db.prepare(
      `CREATE INDEX IF NOT EXISTS idx_supply_review_case_status
       ON ${CASE_TABLE_NAME} (status, last_detected_at DESC)`
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS ${MANUAL_TABLE_NAME} (
        complex_key TEXT PRIMARY KEY,
        profile_json TEXT NOT NULL,
        source_url TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        reviewer TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`
    ),
  ];
  if (typeof db.batch === "function") {
    await db.batch(statements);
    return;
  }
  for (const statement of statements) {
    await statement.run();
  }
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
      await syncD1ReviewCase(db, complexKey, record, updatedAt);
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
    async getManualProfile(complexKey) {
      const row = await db
        .prepare(`SELECT profile_json FROM ${MANUAL_TABLE_NAME} WHERE complex_key = ?1`)
        .bind(complexKey)
        .first();
      return parseRecord(row?.profile_json);
    },
    async putManualProfile(complexKey, manual, actor = "admin") {
      const now = new Date().toISOString();
      await db
        .prepare(
          `INSERT INTO ${MANUAL_TABLE_NAME}
             (complex_key, profile_json, source_url, note, reviewer, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
           ON CONFLICT(complex_key) DO UPDATE SET
             profile_json = excluded.profile_json,
             source_url = excluded.source_url,
             note = excluded.note,
             reviewer = excluded.reviewer,
             updated_at = excluded.updated_at`
        )
        .bind(complexKey, JSON.stringify(manual), manual.sourceUrl || "", manual.note || "", actor, now)
        .run();
      await db
        .prepare(
          `UPDATE ${CASE_TABLE_NAME} SET status = 'manual-active', resolved_at = ?2,
             updated_at = ?2 WHERE complex_key = ?1`
        )
        .bind(complexKey, now)
        .run();
      await addD1Event(db, complexKey, "manual_profile_saved", { sourceUrl: manual.sourceUrl || "", groups: manual.groups || [] }, now);
    },
    async listReviewCases() {
      const result = await db
        .prepare(
          `SELECT c.*, m.profile_json AS manual_profile_json, m.source_url AS manual_source_url,
                  m.note AS manual_note, m.updated_at AS manual_updated_at
           FROM ${CASE_TABLE_NAME} c
           LEFT JOIN ${MANUAL_TABLE_NAME} m ON m.complex_key = c.complex_key
           ORDER BY CASE c.status WHEN 'open' THEN 0 WHEN 'manual-active' THEN 1 ELSE 2 END,
                    c.last_detected_at DESC`
        )
        .all();
      const eventResult = await db.prepare(
        `SELECT complex_key, event_type, detail_json, created_at FROM ${EVENT_TABLE_NAME}
         ORDER BY created_at DESC LIMIT 500`
      ).all();
      const eventsByKey = new Map();
      (eventResult.results || []).forEach((event) => {
        const events = eventsByKey.get(event.complex_key) || [];
        events.push({ type: event.event_type, detail: parseRecord(event.detail_json) || {}, createdAt: event.created_at });
        eventsByKey.set(event.complex_key, events);
      });
      return (result.results || []).map((row) => ({
        complexKey: row.complex_key,
        status: row.status,
        reasonCode: row.reason_code,
        request: parseRecord(row.request_json) || {},
        record: parseRecord(row.record_json) || {},
        firstDetectedAt: row.first_detected_at,
        lastDetectedAt: row.last_detected_at,
        lastAutoRetryAt: row.last_auto_retry_at,
        resolvedAt: row.resolved_at,
        manualProfile: parseRecord(row.manual_profile_json),
        manualSourceUrl: row.manual_source_url || "",
        manualNote: row.manual_note || "",
        manualUpdatedAt: row.manual_updated_at || "",
        events: eventsByKey.get(row.complex_key) || [],
      }));
    },
    async noteAutoRetry(complexKey) {
      const now = new Date().toISOString();
      await db.prepare(`UPDATE ${CASE_TABLE_NAME} SET last_auto_retry_at = ?2, updated_at = ?2 WHERE complex_key = ?1`).bind(complexKey, now).run();
      await addD1Event(db, complexKey, "automatic_retry_requested", {}, now);
    },
    async promoteAutomaticProfile(complexKey, profile) {
      const now = new Date().toISOString();
      await db.prepare(`DELETE FROM ${MANUAL_TABLE_NAME} WHERE complex_key = ?1`).bind(complexKey).run();
      await db.prepare(
        `UPDATE ${CASE_TABLE_NAME} SET status = 'auto-active', resolved_at = ?2, updated_at = ?2 WHERE complex_key = ?1`
      ).bind(complexKey, now).run();
      await addD1Event(db, complexKey, "automatic_profile_promoted", { groups: profile?.groups || [] }, now);
    },
    async noteAutomaticDifference(complexKey, comparison) {
      await addD1Event(db, complexKey, "automatic_profile_differs_from_manual", comparison, new Date().toISOString());
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
    async getManualProfile() { return null; },
    async putManualProfile() {},
    async listReviewCases() { return []; },
    async noteAutoRetry() {},
    async promoteAutomaticProfile() {},
    async noteAutomaticDifference() {},
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
    async getManualProfile() { return null; },
    async putManualProfile() {},
    async listReviewCases() { return []; },
    async noteAutoRetry() {},
    async promoteAutomaticProfile() {},
    async noteAutomaticDifference() {},
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

async function syncD1ReviewCase(db, complexKey, record, updatedAt) {
  const errorCode = String(record?.errorDetails?.resultCode || "");
  const needsReview = record?.status === "upstream-pending" || record?.status === "failed";
  if (needsReview) {
    await db.prepare(
      `INSERT INTO ${CASE_TABLE_NAME}
        (complex_key, status, reason_code, request_json, record_json, first_detected_at, last_detected_at, updated_at)
       VALUES (?1, 'open', ?2, ?3, ?4, ?5, ?5, ?5)
       ON CONFLICT(complex_key) DO UPDATE SET
         status = CASE WHEN ${CASE_TABLE_NAME}.status = 'manual-active' THEN 'manual-active' ELSE 'open' END,
         reason_code = excluded.reason_code,
         record_json = excluded.record_json,
         last_detected_at = excluded.last_detected_at,
         updated_at = excluded.updated_at`
    ).bind(complexKey, errorCode, JSON.stringify({ metadata: record?.metadata || {}, source: record?.requestedSource || record?.source || {} }), JSON.stringify(record), updatedAt).run();
    await addD1Event(db, complexKey, "automatic_calculation_failed", { status: record?.status, reasonCode: errorCode }, updatedAt);
  }
  if (record?.status === "ready") {
    await db.prepare(
      `UPDATE ${CASE_TABLE_NAME} SET status = 'auto-active', resolved_at = ?2, updated_at = ?2
       WHERE complex_key = ?1 AND status <> 'manual-active'`
    ).bind(complexKey, updatedAt).run();
  }
}

async function addD1Event(db, complexKey, type, detail, createdAt) {
  await db.prepare(
    `INSERT INTO ${EVENT_TABLE_NAME} (complex_key, event_type, detail_json, created_at)
     VALUES (?1, ?2, ?3, ?4)`
  ).bind(complexKey, type, JSON.stringify(detail || {}), createdAt).run();
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
