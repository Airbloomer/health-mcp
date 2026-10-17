-- Store the deadline and total on the import window. A missing row is not an
-- open window. A database that already has stored rows gets a closed row, so
-- those rows do not start a new window.
ALTER TABLE ingest_backfill ADD COLUMN deadline TEXT;
ALTER TABLE ingest_backfill ADD COLUMN total_bytes BIGINT;

INSERT INTO ingest_backfill (id, opened_at, closed_at, bytes, days, deadline, total_bytes)
SELECT 1, '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z', 0, 0, '1970-01-01T00:00:00.000Z', 0
WHERE NOT EXISTS (SELECT 1 FROM ingest_backfill WHERE id = 1)
  AND (
    EXISTS (SELECT 1 FROM points_daily)
    OR EXISTS (SELECT 1 FROM workouts)
    OR EXISTS (SELECT 1 FROM raw_payloads)
  );
