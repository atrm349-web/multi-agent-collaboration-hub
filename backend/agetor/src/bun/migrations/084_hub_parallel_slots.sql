-- Migration 084: Multi-concurrency execution slots (removes CHECK(id=1) to allow >= 2 parallel runs)
CREATE TABLE IF NOT EXISTS hub_execution_slot_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL UNIQUE REFERENCES hub_run_claims(run_id)
);
INSERT OR IGNORE INTO hub_execution_slot_v2(id, run_id) SELECT id, run_id FROM hub_execution_slot;
DROP TABLE hub_execution_slot;
ALTER TABLE hub_execution_slot_v2 RENAME TO hub_execution_slot;
