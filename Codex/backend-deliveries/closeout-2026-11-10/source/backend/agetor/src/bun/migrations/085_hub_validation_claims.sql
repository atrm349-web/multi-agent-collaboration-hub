CREATE TABLE IF NOT EXISTS hub_validation_claims (
  subtask_id TEXT PRIMARY KEY REFERENCES hub_entities(id),
  run_id TEXT NOT NULL REFERENCES hub_entities(id),
  owner_id TEXT NOT NULL,
  process_group_id INTEGER,
  process_started_at TEXT,
  status TEXT NOT NULL CHECK(status IN ('starting','running','interrupted'))
);
ALTER TABLE hub_run_claims ADD COLUMN execution_kind TEXT NOT NULL DEFAULT 'process-group';
ALTER TABLE hub_run_claims ADD COLUMN process_started_at TEXT;
UPDATE hub_run_claims SET execution_kind='in-process'
WHERE json_extract(request_json,'$.model') LIKE 'deepseek%'
   OR json_extract(request_json,'$.model') LIKE 'claude%'
   OR json_extract(request_json,'$.model') LIKE 'gemini%'
   OR json_extract(request_json,'$.model') LIKE 'antigravity%'
   OR json_extract(request_json,'$.model') LIKE 'muse%'
   OR json_extract(request_json,'$.model') LIKE 'workbuddy%'
   OR json_extract(request_json,'$.model') LIKE 'wb%'
   OR json_extract(request_json,'$.model') LIKE 'codebuddy%';
