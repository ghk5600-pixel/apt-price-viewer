CREATE TABLE IF NOT EXISTS supply_profile_cache (
  complex_key TEXT PRIMARY KEY,
  calculation_version TEXT NOT NULL,
  status TEXT NOT NULL,
  record_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_supply_profile_cache_status
  ON supply_profile_cache (status, updated_at);
