CREATE TABLE IF NOT EXISTS supply_batch_catalog (
  complex_key TEXT PRIMARY KEY,
  kapt_code TEXT NOT NULL UNIQUE,
  complex_name TEXT NOT NULL,
  bjd_code TEXT NOT NULL,
  sido_name TEXT NOT NULL,
  sigungu_name TEXT NOT NULL,
  eupmyeondong_name TEXT NOT NULL,
  apartment_type TEXT NOT NULL,
  approval_date TEXT NOT NULL,
  households INTEGER NOT NULL,
  building_count INTEGER NOT NULL DEFAULT 0,
  lot_address TEXT NOT NULL,
  road_address TEXT NOT NULL DEFAULT '',
  plat_gb_cd TEXT NOT NULL DEFAULT '0',
  bun TEXT NOT NULL,
  ji TEXT NOT NULL,
  priority_rank INTEGER NOT NULL,
  profile_status TEXT NOT NULL DEFAULT 'pending',
  profile_calculation_version TEXT NOT NULL DEFAULT '',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  discovered_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_supply_batch_catalog_queue
  ON supply_batch_catalog (profile_status, priority_rank, approval_date);

CREATE INDEX IF NOT EXISTS idx_supply_batch_catalog_region
  ON supply_batch_catalog (sido_name, approval_date);

CREATE TABLE IF NOT EXISTS supply_batch_runs (
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
);

CREATE INDEX IF NOT EXISTS idx_supply_batch_runs_started
  ON supply_batch_runs (started_at);
