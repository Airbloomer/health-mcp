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

Workers Free is the Cloudflare profile when `HEALTH_LIMITS_PROFILE` is unset. Do not set that variable to `node` on a Worker. An unknown value fails closed: every request, including `/mcp`, returns `503 {"error":"misconfigured"}`.

## Free-tier limits

Workers Free: 10 ms of CPU per request (`1102` / `exceededCpu`), 50 subrequests, and 100,000 requests a day. D1 Free: 50 queries per invocation (this code assumes each batched statement counts; that was not checked on a scratch free D1), 100,000 rows written a day, 5 million rows read, 500 MB per database, 10 databases, 7-day Time Travel, and 100 bound parameters. The exact daily-limit error text was not verified against a scratch free D1. A matching error becomes `429 {"error":"daily_write_limit","retry":"after"}` with `Retry-After` until 00:00 UTC.

Under `free`, one ingest is a single atomic batch. Under `node`, a large ingest can span several batches. A Bearer retry is idempotent and repairs a partial write. On `1102` or `503`, split the batch and retry. CPU is not measured in this process.
