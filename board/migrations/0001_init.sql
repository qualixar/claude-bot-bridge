-- Qualixar Task Board schema (D1 / SQLite)
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO meta (key, value) VALUES ('task_seq', '0'), ('paused', '0');

CREATE TABLE tasks (
  id               TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  brief            TEXT NOT NULL,
  deliverable      TEXT NOT NULL,
  acceptance       TEXT NOT NULL DEFAULT '',
  priority         INTEGER NOT NULL CHECK (priority BETWEEN 1 AND 3),
  deadline         TEXT,
  status           TEXT NOT NULL CHECK (status IN
                     ('open','claimed','in_progress','needs_owner','done','failed','cancelled')),
  claimed_by       TEXT,
  origin           TEXT NOT NULL DEFAULT 'Claude Code (owner''s orchestrator)',
  question         TEXT,
  owner_reply      TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  claimed_at       TEXT,
  last_activity_at TEXT NOT NULL
);
CREATE INDEX idx_tasks_status ON tasks (status, priority, created_at);

CREATE TABLE events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     TEXT,
  at          TEXT NOT NULL,
  actor       TEXT NOT NULL,
  kind        TEXT NOT NULL,
  to_status   TEXT,
  note        TEXT
);
CREATE INDEX idx_events_task ON events (task_id, id);

CREATE TABLE results (
  task_id      TEXT PRIMARY KEY REFERENCES tasks (id),
  outcome      TEXT NOT NULL CHECK (outcome IN ('done','failed')),
  summary      TEXT NOT NULL,
  links        TEXT NOT NULL,
  notes        TEXT NOT NULL DEFAULT '',
  submitted_by TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE TABLE rate_limits (
  scope   TEXT NOT NULL,
  minute  INTEGER NOT NULL,
  count   INTEGER NOT NULL,
  PRIMARY KEY (scope, minute)
);
