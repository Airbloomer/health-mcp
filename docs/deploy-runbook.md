# Deploy runbook

Apply migration `0003_workout_writer.sql` before any deploy of code that names the `writer` column. SQLite and Postgres apply pending migrations when the process starts. D1 does not.

Do these three steps in order:

1. Apply migration 0003 on the D1 database:

```bash
npx wrangler d1 migrations apply <database> --remote
```

2. Confirm `writer` exists with a read-only `PRAGMA table_info(workouts)` check. The deploy stops if that column is missing.

3. Only then deploy the Worker:

```bash
npx wrangler deploy
```

`npm run migrate:workout-starts` is the `0004_workout_starts_js` backfill. It is not part of this deploy and it is not run at startup.

`HEALTH_LIMITS_PROFILE` selects the request caps used when you self-host. Unset or empty means `free` on Cloudflare and `node` on Node. Do not set `node` on a Worker. An unknown value fails closed: every request, including `/mcp`, returns `503 {"error":"misconfigured"}`.

## Free profile

Self-hosting with the `free` profile accepts 40 workouts, 40 stored rows, 750 raw input records, and 262,144 bytes on one JSON ingest. A request over a cap returns `413` with `retry` set to `split` and writes nothing. A D1 error whose text is the documented daily row read limit or daily row write limit becomes `429 {"error":"daily_write_limit","retry":"after"}` with `Retry-After` until 00:00 UTC.

Under `free`, one ingest is a single atomic batch. Under `node`, a large ingest can span several batches. A Bearer retry is idempotent and repairs a partial write. On `1102` or `503`, split the batch and retry.
