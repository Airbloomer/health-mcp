-- One row for the initial import window. `closed_at` stays empty until the
-- window ends, and a later write does not clear it. `deadline` and
-- `total_bytes` are fixed when the row is created. `bytes` is the total
-- accepted body size. `days` is how many distinct dates were new.
-- A database that already has stored rows gets this row already closed, so
-- those rows do not start a new window. A missing row is not an open window.
CREATE TABLE IF NOT EXISTS ingest_backfill (
  id INTEGER NOT NULL PRIMARY KEY,
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  bytes BIGINT NOT NULL,
  days INTEGER NOT NULL,
  deadline TEXT NOT NULL,
  total_bytes BIGINT NOT NULL
);

INSERT INTO ingest_backfill (id, opened_at, closed_at, bytes, days, deadline, total_bytes)
SELECT 1, '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z', 0, 0, '1970-01-01T00:00:00.000Z', 0
WHERE NOT EXISTS (SELECT 1 FROM ingest_backfill WHERE id = 1)
  AND (
    EXISTS (SELECT 1 FROM points_daily)
    OR EXISTS (SELECT 1 FROM workouts)
    OR EXISTS (SELECT 1 FROM raw_payloads)
  );
