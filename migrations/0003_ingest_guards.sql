-- One counter per token per UTC hour. An accepted post increments `hits` once.
-- Rejected posts do not write this table.
CREATE TABLE IF NOT EXISTS ingest_quota (
  token_key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  hits INTEGER NOT NULL,
  PRIMARY KEY (token_key, window_start)
);

-- At most one row. The summary reads it when a recent export looks misconfigured.
CREATE TABLE IF NOT EXISTS export_hint (
  id INTEGER NOT NULL PRIMARY KEY,
  hint TEXT NOT NULL
);
