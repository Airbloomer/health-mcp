-- One row for the initial import window. It is created on the first accepted
-- ingest. `closed_at` stays empty until the window ends, and a later write
-- does not clear it. `bytes` is the total accepted body size. `days` is how
-- many distinct dates were new. `bytes` is BIGINT so a large total fits.
CREATE TABLE IF NOT EXISTS ingest_backfill (
  id INTEGER NOT NULL PRIMARY KEY,
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  bytes BIGINT NOT NULL,
  days INTEGER NOT NULL
);
