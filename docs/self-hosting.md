# Self-hosting

Deploy options, configuration, migrations, development, and code layout. Security details are in [security.md](security.md).

## Deploy

### Cloudflare

Requires Node.js 22 or newer.

```bash
npm install
cp wrangler.example.toml wrangler.toml
npx wrangler login
npx wrangler d1 create health-mcp
```

Paste the printed database id into `database_id` in `wrangler.toml`. Apply migrations, including `0002_daily_points.sql`, `0003_ingest_guards.sql`, `0004_ingest_backfill.sql`, `0005_quota_window_bigint.sql`, and `0006_ingest_backfill_deadline.sql`, **before** `wrangler deploy`. The worker reads `points_daily`, so deploying first makes ingest fail.

```bash
npx wrangler d1 migrations apply health-mcp --remote
printf '%s' 'replace-with-a-long-random-token' | npx wrangler secret put HEALTH_INGEST_TOKEN
npx wrangler deploy
```

`migrations apply` runs every pending file in order: `0001_init.sql`, `0002_daily_points.sql`, `0003_ingest_guards.sql`, `0004_ingest_backfill.sql`, `0005_quota_window_bigint.sql`, then `0006_ingest_backfill_deadline.sql`. Do not deploy until all six have been applied. `0006` adds the stored deadline and total, and it inserts a closed import-window row when points, workouts, or raw payloads are already stored. A missing row is not an open window.

For local development, apply the same migrations before `wrangler dev`:

```bash
cp dev.vars.example .dev.vars
npx wrangler d1 migrations apply health-mcp --local
npx wrangler dev
```

To serve a hostname of your own, uncomment `[[routes]]` in the local `wrangler.toml` and set `pattern`. The Workers preview URL works without a custom domain. `workers_dev = true` exposes a public `workers.dev` URL; see [Security](security.md).

If you previously ran a build that assumed Pacific Time for offset-less timestamps, set `HEALTH_TIMEZONE` to `America/Los_Angeles`. Health Auto Export's own timestamps include an offset, and those dates do not use this variable.

The Cloudflare deploy stays on the free tier. Plan: free tier; upgrade when a real limit is hit. A D1 daily-limit error is returned as 429 with `Retry-After` until the next 00:00 UTC. See [API reference](api.md).

### Docker

```bash
docker build -t health-mcp .
docker run --rm -p 8787:8787 \
  -e HEALTH_INGEST_TOKEN=replace-with-a-long-random-token \
  -e HEALTH_TIMEZONE=UTC \
  -v health-mcp:/data \
  health-mcp
```

Postgres instead of the SQLite volume:

```bash
docker run --rm -p 8787:8787 \
  -e HEALTH_INGEST_TOKEN=replace-with-a-long-random-token \
  -e DATABASE_URL='postgres://user:password@host:5432/health' \
  health-mcp
```

The container listens on `8787` and applies pending migrations on startup. Generate a token with `openssl rand -hex 32`.

### Node

```bash
npm install
export HEALTH_INGEST_TOKEN="$(openssl rand -hex 32)"
export HEALTH_TIMEZONE=UTC
npm start
```

`npm start` runs `node src/adapters/node.js`, creates the SQLite directory if needed, and applies any migration that has not been recorded in `schema_migrations`. Set `DATABASE_URL` to a `postgres://` URL to use Postgres instead. The same migrations run there. `mysql://` and other schemes are rejected.

Import an export from Apple Health into that database with `node src/cli/import-apple-health.js export.zip`. To send it to a running server instead, pass `--chunk-url http://127.0.0.1:8787/import/apple-health/chunk`. Set `HEALTH_INGEST_TOKEN` in the environment rather than passing `--token`.

`0002_daily_points.sql` copies existing per-sample `points` rows into `points_daily` (one row per metric and day) and leaves the old table in place. Dropping it would count as a write for every old sample, so do that later with `DROP TABLE points;` once the daily write budget has room. On Cloudflare, apply `0002` with `wrangler d1 migrations apply` before `wrangler deploy`, as in the steps above. Node and Docker apply it on startup, before the server accepts traffic.

## Configuration

| Variable | Required | Where | Purpose |
| --- | --- | --- | --- |
| `HEALTH_INGEST_TOKEN` | yes | Worker secret, or the process environment | Bearer token for every route. Empty means every bearer request is rejected. |
| `HEALTH_INGEST_URL_TOKEN` | no | Worker secret, or the process environment | Write-only token for `POST /ingest/hc-webhook`, `POST /ingest/life-dashboard`, and `POST /ingest/shortcuts` when the app cannot send `Authorization`. Must match `^[A-Za-z0-9_-]{32,}$`. Unset, too short, or equal to `HEALTH_INGEST_TOKEN` disables URL-token auth. It does not authenticate `/summary`, `/mcp`, or any other route. |
| `HEALTH_TIMEZONE` | no | Wrangler `[vars]`, or the process environment | IANA zone used when a timestamp has no numeric offset. Default `UTC` when unset. [`wrangler.example.toml`](../wrangler.example.toml) sets `America/Los_Angeles`. |
| `DB` | yes on Cloudflare | Wrangler D1 binding | Must be named `DB`. |
| `DATABASE_URL` | no | Node | `postgres://` or `postgresql://` URL, otherwise a SQLite file path. |
| `SQLITE_PATH` | no | Node | SQLite file when `DATABASE_URL` is unset. Default `./data/health.sqlite`. The image sets `/data/health.sqlite`. |
| `PORT` | no | Node | Default `8787`. |
| `HOST` | no | Node | Default `0.0.0.0`. |
| `HEALTH_STORE_RAW` | no | Wrangler `[vars]`, or the process environment | Store each request body in `raw_payloads`. Default off. Set `true`, `1`, `yes`, or `on` to store it. `false`, `0`, `no`, and `off` leave it off. Bodies over about 1.5MB are skipped either way, under D1's 2MB row limit. |
| `HEALTH_METRIC_ALLOWLIST` | no | Wrangler `[vars]`, or the process environment | Comma-separated metric names to store in addition to the summary set. |
| `HEALTH_SHORTCUTS_SOURCE_PRIORITY` | no | Wrangler `[vars]`, or the process environment | Raw-sample mode of `POST /ingest/shortcuts` only. Comma-separated, case-insensitive fragments of source names; the first fragment found in a source name wins that metric-day. Default `watch,iphone`. See [shortcuts.md](shortcuts.md). |
| `HEALTH_SOURCE_PRIORITY` | no | Wrangler `[vars]`, or the process environment | Comma-separated `sourceName` values from an export of Apple Health. When an export has several sources for one metric-day, the first listed source that has samples wins. Unset, summed metrics keep the largest total, and weight and body fat keep the newest reading. |
| `MCP_ALLOWED_ORIGINS` | no | Wrangler `[vars]`, or the process environment | Comma-separated `Origin` values allowed to call `/mcp`. Empty by default, which rejects every request that sends `Origin`. Requests with no `Origin` header stay allowed. |
| `INGEST_MAX_AGE_DAYS` | no | Wrangler `[vars]`, or the process environment | How many days before today Health Auto Export JSON on `POST /ingest` may include. Default `1` (today and yesterday in `HEALTH_TIMEZONE`). Values above 36500 are clamped to 36500. Older points are dropped and counted as `dropped_stale`. Dates more than one day after today are counted as `dropped_future`. `POST /import/apple-health` ignores this. |
| `INGEST_MAX_BODY_BYTES` | no | Wrangler `[vars]`, or the process environment | Maximum JSON ingest body in bytes. Default `1000000`. A larger body returns `413` with `payload_too_large`. Capped at 20,000,000. |
| `INGEST_RATE_LIMIT_PER_HOUR` | no | Wrangler `[vars]`, or the process environment | Accepted ingest posts per token per UTC hour. Default `6`. `0` disables the limit. Over the limit returns `429` with `Retry-After`. |
| `INGEST_MIN_DATE` | no | Wrangler `[vars]`, or the process environment | Earliest calendar date Health Auto Export JSON on `POST /ingest` may store. Default `2000-01-01`. A real date is clamped to `1970-01-01` through today. A value that is not a real calendar day uses the default. |
| `INGEST_BACKFILL_HOURS` | no | Wrangler `[vars]`, or the process environment | How long the initial import window stays open after the first accepted ingest. Default `72`. Values below 1 use the default. Values above 8784 are clamped to 8784. The deadline is stored on the row when the window opens. |
| `INGEST_BACKFILL_MAX_BYTES` | no | Wrangler `[vars]`, or the process environment | Per-request JSON body cap while the initial import window is open. Default `5000000`. Clamped to 10000000. The hint text uses this cap. The default wording is 5 MB. A `content-type` that does not contain `json` keeps the 20,000,000 byte cap. |
| `INGEST_BACKFILL_MAX_PER_HOUR` | no | Wrangler `[vars]`, or the process environment | Accepted ingest posts per token per UTC hour while the initial import window is open. Default `60`. Clamped to 10000. |
| `INGEST_BACKFILL_MAX_TOTAL_BYTES` | no | Wrangler `[vars]`, or the process environment | Total accepted body bytes for the whole initial import window. Default `500000000`. Clamped to 5000000000. The value is stored on the row when the window opens. |

Copy [`.env.example`](../.env.example) to `.env` for Node, or [`dev.vars.example`](../dev.vars.example) to `.dev.vars` for `wrangler dev`. Both real files are gitignored.

On Cloudflare, set the bearer token with `npx wrangler secret put HEALTH_INGEST_TOKEN`. Set the optional write-only URL token the same way, `npx wrangler secret put HEALTH_INGEST_URL_TOKEN`, only if a phone cannot send the header. Do not put either secret in `[vars]`. Put `HEALTH_TIMEZONE` in `[vars]` if you do not want `UTC`. The example file sets it to `America/Los_Angeles`; the code still defaults to `UTC` when the variable is absent. Copy [`wrangler.example.toml`](../wrangler.example.toml) to `wrangler.toml` (gitignored) and replace `database_id`. Set `account_id` in that local file only if Wrangler should target an account other than the one you are logged in to. Do not commit either value, and do not commit a custom hostname.

## Development

```bash
npm install
npm test
```

`npm test` runs the core against an in-memory storage fake, the Cloudflare adapter against a D1-shaped wrapper over SQLite, and the Node adapter over HTTP with a SQLite file. The Postgres adapter is tested with a fake client that records SQL, so a database server is not required. GitHub Actions runs the same command on pull requests and on pushes to `main`.

## Layout

```
src/core                 parse, daily aggregate, summarize, bearer auth, HTTP, MCP
src/core/ingest-guard.js recency window, body limit, rate limit, initial import window, unchanged rows
src/core/hk.js           HealthKit quantity and workout names
src/core/apple-export.js streaming export.xml and zip parser
src/core/health-export-pro.js
src/core/syncfit.js      SyncFit schemaVersion 1
src/core/health-connect.js  shared Health Connect units and exercise names
src/core/hc-webhook.js   HC Webhook JSON
src/core/life-dashboard.js  Life Dashboard Companion JSON
src/core/shortcuts.js       iOS Shortcuts JSON
src/cli/import-apple-health.js
src/adapters/d1.js       D1 storage
src/adapters/cloudflare.js
src/adapters/node.js     node:http server
src/adapters/sqlite.js
src/adapters/postgres.js
src/index.js             Wrangler entry
migrations/0001_init.sql
migrations/0002_daily_points.sql
migrations/0003_ingest_guards.sql
migrations/0004_ingest_backfill.sql
migrations/0005_quota_window_bigint.sql
migrations/0006_ingest_backfill_deadline.sql
```

The storage interface is `insertIngest(batch)`, `queryDaySummary(date)`, `queryMetricRange(metric, startDate, endDate)`, `listMetrics()`, and `listWorkouts(startDate, endDate)`. `batch.points` is already one row per `(metric, date)` (`sum_qty`, `last_qty`, `last_ts`, `units`, `n`). `storeRaw: false` skips the raw body. `queryDaySummary` returns the `/summary` object. The three range methods only read. `MemoryStorage` in `src/core/memory.js` is the reference implementation. It is process-local and not persistent: a new process has no import-window row and no stored data, so the next stored point can open a window, and a restart does not keep a closed window.
