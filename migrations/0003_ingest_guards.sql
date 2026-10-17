-- One counter per auth path per UTC hour. `token_key` is the label "bearer" or
-- "url", not the credential. `window_start` is epoch milliseconds. It is BIGINT
-- because that value does not fit in a 32-bit integer. An accepted post
-- increments `hits` once, and only while `hits` is still under the limit.
-- Rejected posts do not write this table. Old hours are left in place so the
-- accepted post stays a single counter write.
CREATE TABLE IF NOT EXISTS ingest_quota (
  token_key TEXT NOT NULL,
  window_start BIGINT NOT NULL,
  hits INTEGER NOT NULL,
  PRIMARY KEY (token_key, window_start)
);

-- At most one row. The summary reads it when a recent export looks misconfigured.
CREATE TABLE IF NOT EXISTS export_hint (
  id INTEGER NOT NULL PRIMARY KEY,
  hint TEXT NOT NULL
);
