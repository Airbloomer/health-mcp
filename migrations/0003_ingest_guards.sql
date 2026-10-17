-- One counter per auth path per UTC hour. `token_key` is the label "bearer" or
-- "url", not the credential. An accepted post increments `hits` once.
-- Rejected posts do not write this table. Old hours are left in place so the
-- accepted post stays a single counter write.
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
