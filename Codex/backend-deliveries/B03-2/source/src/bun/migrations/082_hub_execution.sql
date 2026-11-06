-- Additive Hub state: existing Agetor task/run tables remain untouched.
CREATE TABLE hub_entities (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('task','subtask','agent','run','message','artifact','approval','validation')),
  task_id TEXT REFERENCES hub_entities(id),
  status TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  data TEXT NOT NULL CHECK(json_valid(data)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX hub_entities_by_task ON hub_entities(task_id,kind,created_at,id);
CREATE TABLE hub_run_claims (
  run_id TEXT PRIMARY KEY REFERENCES hub_entities(id),
  subtask_id TEXT NOT NULL REFERENCES hub_entities(id),
  attempt INTEGER NOT NULL CHECK(attempt > 0),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  request_json TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  lease_until_ms INTEGER NOT NULL,
  process_group_id INTEGER,
  UNIQUE(subtask_id,attempt),
  UNIQUE(subtask_id,idempotency_key)
);
CREATE TABLE hub_execution_slot (
  id INTEGER PRIMARY KEY CHECK(id=1),
  run_id TEXT NOT NULL UNIQUE REFERENCES hub_run_claims(run_id)
);
CREATE TABLE hub_logs (
  run_id TEXT NOT NULL REFERENCES hub_run_claims(run_id),
  log_seq INTEGER NOT NULL,
  data TEXT NOT NULL CHECK(json_valid(data)),
  PRIMARY KEY(run_id,log_seq)
);
CREATE TABLE hub_outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  task_id TEXT,
  run_id TEXT,
  entity_version INTEGER,
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  created_at TEXT NOT NULL
);
CREATE TABLE hub_event_receipts (
  consumer_id TEXT NOT NULL,
  event_seq INTEGER NOT NULL REFERENCES hub_outbox(seq),
  PRIMARY KEY(consumer_id,event_seq)
);
