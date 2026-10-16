# Release notes

Rows written by removed phone adapters stay in `points_daily` and `workouts`. Summaries still show them. Read-time de-duplication hides workout duplicates. Deleting those rows is a manual step. This release does not ship a delete migration.

Apply migration 0003 before deploying the new code. On D1:

1. `npx wrangler d1 migrations apply <database> --remote`
2. Confirm `writer` with read-only `PRAGMA table_info(workouts)`. Stop if it is missing.
3. Only then `npx wrangler deploy`.

Node SQLite and Postgres apply that migration at startup.

`HEALTH_LIMITS_PROFILE` is `free` on Cloudflare when unset or empty, and `node` on Node when unset or empty. `node` on Cloudflare is used only when set explicitly. Any other value, including `Free` or `paid`, fails closed: a Worker returns 503 for every request, and Node exits 1. The message names the variable and not the value.

New request limits depend on that profile. The free profile accepts 40 workouts, 40 stored rows, 750 raw input records, and 262,144 bytes on JSON ingest. The 750 record cap is provisional until CPU time is measured on Cloudflare. The procedure is in [limits.md](limits.md). Change `FREE_MAX_INPUT_RECORDS` in `src/core/limits.js` if that measurement calls for a different cap. The node profile accepts 500 URL-token workouts, 5,000 Bearer workouts, 50,000 records in one array, 200,000 records in total, and 10,000,000 bytes. Over a cap, the response is 413 with `retry` set to `split` and nothing is written. `/mcp` keeps its existing byte limit. `POST /import/apple-health` stays a stream with a byte limit only.

HC Webhook history that cannot be split should be sent with Manual Sync, Custom selection, one day at a time. Do not use Past 7 Days or Past 30 Days. Shortcuts should send one local day per request. Catch-up loops oldest first and stops at the first non-2xx.

Workout `start` values are stored as UTC. The `writer` column is `bearer`, `url`, or NULL for an older row. A URL-token row written before that column existed has `writer` NULL, and read-time de-duplication counts that NULL writer as trusted, the same as a bearer row. `npm run migrate:workout-starts` ranks a bearer or NULL writer ahead of `url` and does not delete the trusted row in order to keep the URL-token row. Matching uses a type map (`traditional_strength_training` and `functional_strength_training` match `strength_training`; treadmill running matches running). Stored names are not rewritten. `isIndoor` is not part of the match. Paused runs whose elapsed time and end-minus-start differ by more than the duration tolerance are not merged.

`HEALTH_STORE_RAW` still defaults to off. When it is on, the raw row is the post-filter JSON `{route, points, workouts}` of rows that were stored, not the original body. Sensitive metrics are stored only when `HEALTH_METRIC_ALLOWLIST` names them exactly.

A URL credential writes points with `n` 0. A later partial URL batch can overwrite a fuller URL day. It cannot overwrite a Bearer day.

Removed ingest paths return `401` until a valid bearer token is present, then `410 {"error":"gone"}`. The access log redacts the token segment.

On the node profile a large request can commit more than one database batch. Retry with Bearer, which is idempotent. An `1102` response means the batch should be split and retried.
