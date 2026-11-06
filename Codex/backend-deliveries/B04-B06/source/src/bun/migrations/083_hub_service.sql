CREATE TABLE hub_api_requests (
  scope TEXT NOT NULL,
  request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','done','error')),
  response TEXT,
  error TEXT,
  PRIMARY KEY(scope,request_key)
);
CREATE TABLE hub_task_policies (
  task_id TEXT PRIMARY KEY REFERENCES hub_entities(id),
  data TEXT NOT NULL CHECK(json_valid(data))
);
CREATE TABLE hub_workspaces (
  subtask_id TEXT PRIMARY KEY REFERENCES hub_entities(id),
  attempt INTEGER NOT NULL,
  handle TEXT NOT NULL CHECK(json_valid(handle)),
  commit_sha TEXT,
  review INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE hub_service_owner (
  id INTEGER PRIMARY KEY CHECK(id=1),
  owner_id TEXT NOT NULL,
  process_id INTEGER NOT NULL,
  lease_until_ms INTEGER NOT NULL
);
