-- Expand-only. Adds two counters and triggers; no existing column or table is changed.
--
-- board_rev: bumped by a trigger inside the same transaction as every write that changes what the web
-- board shows, so the live-update marker is a single primary-key read.
-- event_seq: event ids are allocated from this counter before the row is written, so an event's
-- ciphertext can be bound to its own id. Every event insert in the code uses it; it starts at the
-- highest existing id.
INSERT INTO meta (key, value) VALUES ('board_rev', '0');
INSERT INTO meta (key, value) SELECT 'event_seq', CAST(COALESCE(MAX(id), 0) AS TEXT) FROM events;

CREATE TRIGGER bb_rev_tasks_insert AFTER INSERT ON tasks
BEGIN
  UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'board_rev';
END;

CREATE TRIGGER bb_rev_tasks_update AFTER UPDATE ON tasks
BEGIN
  UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'board_rev';
END;

CREATE TRIGGER bb_rev_events_insert AFTER INSERT ON events
BEGIN
  UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'board_rev';
END;

CREATE TRIGGER bb_rev_paused AFTER UPDATE ON meta WHEN NEW.key = 'paused'
BEGIN
  UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'board_rev';
END;
