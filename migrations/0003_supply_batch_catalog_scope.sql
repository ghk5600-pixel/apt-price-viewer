ALTER TABLE supply_batch_catalog
  ADD COLUMN catalog_scope TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_supply_batch_catalog_scope
  ON supply_batch_catalog (catalog_scope, priority_rank);
