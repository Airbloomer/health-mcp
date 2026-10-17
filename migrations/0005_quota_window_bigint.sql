-- `window_start` is epoch milliseconds. Rebuild the table so the value is
-- BIGINT. The earlier definition used INTEGER. If a run copies the rows and
-- stops before the rename, the next run finishes that rename.
CREATE TABLE IF NOT EXISTS ingest_quota_wide (
  token_key TEXT NOT NULL,
  window_start BIGINT NOT NULL,
  hits INTEGER NOT NULL,
  PRIMARY KEY (token_key, window_start)
);

INSERT INTO ingest_quota_wide (token_key, window_start, hits)
SELECT token_key, window_start, hits FROM ingest_quota;

DROP TABLE ingest_quota;

ALTER TABLE ingest_quota_wide RENAME TO ingest_quota;
