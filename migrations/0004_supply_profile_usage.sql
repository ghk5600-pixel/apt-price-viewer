CREATE TABLE IF NOT EXISTS supply_profile_usage (
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
);

CREATE INDEX IF NOT EXISTS idx_supply_profile_usage_priority
  ON supply_profile_usage
    (registration_count DESC, request_count DESC, last_requested_at DESC);
