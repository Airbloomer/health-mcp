# health-mcp

A self-hosted health data endpoint. It works with data exported from Apple Health and with Android Health Connect, and serves daily summaries. `POST /ingest` accepts the [Health Auto Export](https://help.healthyapps.dev/en/health-auto-export/automations/rest-api) JSON format (export version 2) and the other sources in Works with. `GET /summary` returns one calendar day's totals.

The parsing, aggregation, auth, HTTP handling, and read-only MCP endpoint live in `src/core` and depend only on web standards (`Request`, `Response`, `fetch`, `crypto`, `Intl`). Persistence is a small storage interface. Two adapters implement it:

- **Cloudflare Workers + D1** (`src/index.js`, the Wrangler entry)
- **Node.js** (`src/adapters/node.js`) with SQLite via [better-sqlite3](https://github.com/WiseLibs/better-sqlite3), or Postgres when `DATABASE_URL` is a `postgres://` URL

`migrations/` is plain SQL that runs on SQLite, D1, and Postgres. The repo ships synthetic fixtures only. Do not commit tokens, `wrangler.toml`, or exports of real health data.

## Disclaimer

Not affiliated with, endorsed or sponsored by Apple Inc. Apple, Apple Health and HealthKit are trademarks of Apple Inc. Health Auto Export, SyncFit, Health Export Pro, Google, Health Connect, HC Webhook and Life Dashboard Companion are trademarks of their respective owners and are mentioned only to describe compatibility; no endorsement is implied.

Not medical advice and not a medical device. This software is for personal informational use only and is not intended to diagnose, treat or prevent any condition. Consult a qualified professional for medical decisions.

Self-hosted: you run this software and you are responsible for securing your endpoint and your health data. Airbloomer, LLC does not host, receive or access any user data. Provided 'as is' under the MIT License, without warranty.

## API

`/ingest`, `/import/apple-health`, `/import/apple-health/chunk`, `/ingest/health-export-pro`, `/ingest/syncfit`, `/ingest/hc-webhook`, `/ingest/life-dashboard`, `/summary`, and `/mcp` require `Authorization: Bearer <HEALTH_INGEST_TOKEN>`. A missing or wrong token returns `401` and `{ "error": "unauthorized" }`. Responses are JSON and send `cache-control: no-store`.

The bearer header is the default and is what both Android apps can send as a custom header. `GET /summary`, `POST /mcp`, and every other route accept only that header. They never accept a token in the query string or the path, even when the value matches `HEALTH_INGEST_TOKEN`.

`POST /ingest/hc-webhook` and `POST /ingest/life-dashboard` can also accept a different secret, `HEALTH_INGEST_URL_TOKEN`, when the `Authorization` header is absent. Prefer the path form, `/ingest/hc-webhook/<token>` or `/ingest/life-dashboard/<token>`, over the `token` query parameter. That variable is unset by default, and URL-token auth stays off until you set it. It is rejected on every other route and method, including `GET` of those same paths. The comparison is constant-time. A request that sends an `Authorization` header is checked only against `HEALTH_INGEST_TOKEN`; the URL token is not a bearer credential and cannot read. An empty `HEALTH_INGEST_TOKEN` still rejects every bearer request. This process redacts `token` query values, including percent-encoded keys such as `%74oken`, and those path segments from its own error logs. Cloudflare request logs cannot be redacted that way. See [Security](#security).

### `POST /ingest`

The body is the Health Auto Export JSON format. Health Auto Export can post it, and so can any other exporter that sends the same shape. A body that is already the `data` object is accepted. Either `metrics` or `workouts` may be omitted. `points` in the response is the number of accepted samples, not the number of rows written.

`metrics` is an array of named series. Each item has `name`, `units`, and `data`, an array of samples with `date` and `qty`. `workouts` is an array of sessions. Each item has `name`, `start`, and usually `end`, `duration` in seconds, and `activeEnergyBurned` as `{ "qty", "units" }`.

```json
{
  "data": {
    "metrics": [
      {
        "name": "step_count",
        "units": "count",
        "data": [{ "date": "2026-10-14 09:00:00 -0700", "qty": 1200 }]
      }
    ],
    "workouts": [
      {
        "name": "Walk",
        "start": "2026-10-14 12:00:00 -0700",
        "end": "2026-10-14 12:30:00 -0700",
        "duration": 1800,
        "activeEnergyBurned": { "qty": 150, "units": "kcal" }
      }
    ]
  }
}
```

Before anything is written, the core aggregates that payload in memory to **one row per (metric, date)**: `sum_qty`, `last_qty`, `last_ts`, `units`, and `n` (sample count). Only the summary metrics are kept, plus any names in `HEALTH_METRIC_ALLOWLIST`. The upsert replaces the existing row for that date and metric only when the new `n` is greater than or equal to the stored `n` (`WHERE excluded.n >= points_daily.n`). It does not add to the previous total, so posting the same samples again cannot double-count. A shorter re-send is ignored, so a partial day cannot wipe a fuller total. Health Auto Export should send whole days: the request must contain every sample that should remain for each metric-day it includes. A later export with at least as many samples replaces the row. Other metrics on that date are left alone. Workouts stay one row per `(name, start)`.

The raw JSON is one `raw_payloads` row per request only when `HEALTH_STORE_RAW` is enabled. It defaults to off. Set `HEALTH_STORE_RAW=true` (or `1`, `yes`, or `on`) to keep the body. A body larger than about 1.5MB is skipped even then, so the row stays under D1's 2MB limit. Metrics in that body are still ingested.

There is no secondary index on the daily table. The primary key is `(date, metric)`, which is enough for `GET /summary` and avoids a second write per row. A 7-day export of the summary metrics is a few dozen row writes, not one write per sample.

Recognized metrics:

| Health Auto Export name | Summary field | Aggregation |
| --- | --- | --- |
| `dietary_energy` | `dietary_kcal` | sum; kJ converted to kcal |
| `protein` | `protein_g` | sum |
| `carbohydrates` | `carbs_g` | sum |
| `total_fat` | `fat_g` | sum |
| `active_energy` | `active_kcal` | sum; kJ converted to kcal |
| `basal_energy_burned` | `basal_kcal` | sum; kJ converted to kcal |
| `step_count` | `steps` | sum, rounded to an integer |
| `weight_body_mass` | `weight` | latest sample as `{ "value", "units" }` |
| `body_fat_percentage` | `body_fat_pct` | latest sample; values ≤ 1 are treated as fractions and multiplied by 100 |

Metrics outside the summary set are dropped unless listed in `HEALTH_METRIC_ALLOWLIST`. Allowlisted metrics are stored and do not appear in `/summary`. Symptoms, ECG, and other Health Auto Export data types are ignored.

```json
{ "ok": true, "id": "2026-10-14/2026-10-16T12:00:00.000Z/ab12cd34", "dates": ["2026-10-14"], "points": 11, "workouts": 1 }
```

Limits and errors: a body over 20,000,000 characters returns `413` `{ "error": "payload_too_large" }`. Invalid JSON returns `400` `{ "error": "invalid_json" }`. A JSON value that is not a Health Auto Export object — `{}`, `[null]`, a null metric or sample, or a `metrics` / `workouts` value that is not an array — returns `400` `{ "error": "invalid_payload" }`. An object with an empty `metrics` or `workouts` array is valid. The Node server also stops reading at 20,000,000 bytes.

Timestamps that include a numeric offset (`2026-10-14 17:30:00 -0700`) use the calendar date in that string. Timestamps without an offset are interpreted in `HEALTH_TIMEZONE` (default `UTC`).

`/summary` adds `sum_qty` for summed metrics and reads `last_qty` for weight and body fat. Send each real quantity once inside a request (one daily total, or non-overlapping buckets). Health Auto Export should send whole days. A later request with fewer samples for that metric-day is ignored, so splitting one day across batch requests leaves the stored total at whichever request had the larger sample count.

### Export from Apple Health

Data exported from Apple Health is a supported source. The Health app writes that export as `export.xml`. `POST /ingest` accepts `export.xml` when the body fits in the 20,000,000 byte ingest limit, and a zip of that export when the zip fits too. Anything that starts with `<` or a zip local-file header is read as this format. Health Auto Export JSON still starts with `{` and is unchanged.

The large streaming import is Node-only. `POST /import/apple-health` on the Node server reads `export.xml`, or a zip whose entry is named `export.xml`, up to 2,000,000,000 compressed bytes, without buffering the file at the 20 MB ingest limit. A Worker cannot take that stream: platform body, memory, and CPU limits are much smaller. On Cloudflare, run `node src/cli/import-apple-health.js` with `--chunk-url` pointed at the Worker. The zip entry must store its sizes in the local header (no data descriptor) and use stored or deflate compression. Zip64 is rejected. Decompressed XML is capped at 10 GB, and a ratio above 200:1 after 100 MB of output is rejected with `413`.

- `POST /import/apple-health/chunk` accepts JSON `{ "points": [], "workouts": [] }`. Each point is already one whole `(metric, date)` row: `sum_qty`, `last_qty`, `last_ts`, `units`, and `n`. The same `n` upsert applies, and this route trusts the `n` you send. A metric-day has to arrive complete in one chunk, because a later shorter chunk does not replace that day.
- `node src/cli/import-apple-health.js <file>` writes through Node storage (`DATABASE_URL` or `SQLITE_PATH`). `--chunk-url` posts whole-date chunks (31 dates at a time) to `/import/apple-health/chunk`. `--token` and `--time-zone` override the environment for that run. Prefer `HEALTH_INGEST_TOKEN` in the environment; a token on the command line is visible to other users on the machine.

Quantity types map onto the summary metrics: DietaryEnergyConsumed, DietaryProtein, DietaryCarbohydrates, DietaryFatTotal, ActiveEnergyBurned, BasalEnergyBurned, StepCount, BodyMass, and BodyFatPercentage. Other `HKQuantityTypeIdentifier` names are stored only when `HEALTH_METRIC_ALLOWLIST` lists the snake_case form (`HeartRate` becomes `heart_rate`). A workout's activity type becomes its name (`HKWorkoutActivityTypeTraditionalStrengthTraining` becomes `Traditional Strength Training`). Duration is stored in minutes. Energy in kJ is converted to kcal. The raw XML is not stored.

Records are aggregated while streaming, one running total per metric, day, and `sourceName`. The samples themselves are not kept. For each summed metric-day the import keeps the source with the largest total. Weight and body fat keep the source with the newest reading. Set `HEALTH_SOURCE_PRIORITY` to a comma-separated list of `sourceName` values to prefer those sources, in order, when they have samples that day. A timestamp that repeats the bucket's latest timestamp replaces that quantity instead of being added twice.

Days on or after the export's `<ExportDate value="…">` are dropped. That calendar day is still in progress in the Health app, so the file only has a partial total, and the `n` from a full import is much larger than a later Health Auto Export day. Leaving the partial day out lets Health Auto Export fill it. Earlier imported days keep their record-count `n`, so they stay in place unless a later upload for that metric-day has at least as many samples. An import therefore takes precedence over a coarser Health Auto Export update for those completed days.

A `<!DOCTYPE HealthData [ <!ELEMENT …> <!ATTLIST …> ]>` header from an export of Apple Health is accepted. A DOCTYPE that uses `SYSTEM`, `PUBLIC`, or `<!ENTITY` is rejected. Comments, `CDATA` sections, and the DOCTYPE subset are not scanned for records.

### Health Export Pro

Health Export Pro's published JSON is accepted on `POST /ingest` and on `POST /ingest/health-export-pro`. Detection on `/ingest` runs after the check for an export from Apple Health and requires `exportDate`, `startDate`, `endDate`, `syncSource`, and a `data` object that is not a Health Auto Export `metrics` array. A Health Auto Export body is still parsed as Health Auto Export, including when those extra fields are also present and `data.metrics` is an array.

`data` is keyed by HealthKit identifier. Quantity samples (`uuid`, `value`, `unit`, `startDate`, `endDate`) use the same metric names as an export from Apple Health. `data.workouts` uses `workoutActivityType` (the HealthKit integer), `durationSeconds`, and `totalEnergyBurned` in kcal. `37` is Running, `50` is Traditional Strength Training, and `52` is Walking. Medication sections and `workoutRoutes` are ignored. The same daily upsert applies, so each request should contain the whole day for every metric it includes. This adapter follows the published document shape; it has not been verified against a live app session.

### SyncFit

SyncFit's native JSON is accepted on `POST /ingest` and `POST /ingest/syncfit`. The body is `{ "schemaVersion": 1, "samples": [] }` with no `data` object. Each sample has `metric`, `start`, `value`, and `unit`. Timestamps are ISO 8601; an offset keeps the calendar date in the string. `basal_energy` is stored as `basal_energy_burned`, `body_mass` as `weight_body_mass`, and dietary identifiers map onto the summary metrics (`dietary_energy` or `dietary_energy_consumed`, `dietary_protein`, `dietary_carbohydrates`, `dietary_fat_total`). Other snake_case metrics are stored only when `HEALTH_METRIC_ALLOWLIST` names them.

On `POST /ingest` the order is XML or a zip exported from Apple Health, then Health Export Pro, then SyncFit, then Life Dashboard Companion, then HC Webhook, then Health Auto Export. SyncFit is used only when `data` is absent. A Health Auto Export body that also carries `schemaVersion` and `samples` stays Health Auto Export.

A `workout` sample uses `value` as duration in seconds and `details.activityType` as the HealthKit activity integer (`37` Running, `50` Traditional Strength Training, `52` Walking). `details.totalEnergy` is kcal. Routes and other detail payloads are ignored.

Samples collapse to one row per metric and timestamp, then one row per metric and date, with the same `n` upsert. Sending the same body again does not double the totals. A later batch replaces a metric-day only when it has at least as many samples. `aggregation` of `hour`, `day`, `week`, or `month` is stored as the samples in that body, so a one-row daily total does not replace a fuller raw day.

The Health Auto Export preview layout is a different JSON shape and is not covered by these tests.

### HC Webhook

HC Webhook's JSON is accepted on `POST /ingest/hc-webhook` and on `POST /ingest` when the body has `timestamp` and `app_version` and is not one of the formats above. Record arrays use the names and units in the app's webhook reference: `steps.count`, `active_calories.calories` in kcal, `weight.kilograms`, `body_fat.percentage`, `nutrition` (`calories`, `protein_grams`, `carbs_grams`, `fat_grams`), and `exercise` with `type`, `start_time`, `end_time`, and `duration_seconds`. `type` is Health Connect's exercise type as a decimal string (`56` Running, `79` Walking, `70` Strength Training). The exercise object has no energy field, so workout `kcal` is null. Sleep stages, cadence, and route-like fields are not stored. `total_calories`, `distance`, heart rate, and sleep duration are stored only when `HEALTH_METRIC_ALLOWLIST` names `total_calories`, `distance`, `heart_rate`, or `sleep_analysis`. `basal_metabolic_rate` is watts in this payload and is not converted into `basal_kcal`. The app also emits `bmi` when weight and height are both present; that is stored as `body_mass_index` only when allowlisted.

Timestamps are UTC instants (`Z`). The calendar day comes from `HEALTH_TIMEZONE`. A stored day must be a real calendar date from `2000-01-01` through two days after the request is received. `2026-13-45`, `2026-02-29` in a non-leap year, a day before 2000, and a timestamp in year 9999 are `invalid_payload`. Steps and active or total calories must be from 0 through 1,000,000 steps or 100,000 kcal. Weight must be from 0.5 kg through 500 kg. Body fat must be from 0% through 100%. A value outside those bounds is `invalid_payload` and is not stored. A heart-rate aggregate includes `avg` and a `bpm` alias of that average; one sample is stored. The same `n` upsert applies. Daily step resolution is one cumulative row per day (`n` stays 1), so a later sync replaces that day. A full or bucketed series replaces a metric-day only when the new request has at least as many samples, and it does not add to the previous total. Incremental sync sends only records new since the last success, so send a range that still contains the whole day for each metric you want replaced. This adapter follows the published JSON reference and the app source that builds it. It has not been verified against a live phone session.

### Life Dashboard Companion

Life Dashboard Companion's health JSON is accepted on `POST /ingest/life-dashboard` and on `POST /ingest`. A health payload has `source` of `health_connect` (Android) or `healthkit_ios` (the iPhone app, which publishes the same shape). `steps`, `distance`, `active_calories`, and `total_calories` in `daily_totals` are the values stored for those dates. Raw records for the same metric and date in that request are not added, because phone and watch copies would otherwise both count. `daily_totals.date` is already the phone's local day and is stored as that date. Other timestamps are UTC instants; a record `metadata` zone offset (`zone_offset`, `start_zone_offset`, or `end_zone_offset`) selects the calendar day when it is present, and otherwise the day comes from `HEALTH_TIMEZONE`.

`active_calories` maps to `active_kcal`. `basal_metabolic_rate.kilocalories_per_day` maps to `basal_kcal` (this field is a daily rate, unlike HC Webhook's watts). Nutrition uses the same summary metrics as an export from Apple Health. Exercise `type` is the Health Connect decimal string, or a name such as `running` from the iPhone app. Session `kcal` is null; the published exercise object has no energy field. Segments and laps are ignored. `total_calories` and `distance` are not summary fields. Bucketed series (`bucket_start`, `total` or `avg`) are stored as the samples in that request. A later request replaces a metric-day only when its sample count is at least the stored `n`. A one-row daily total therefore does not replace a day that was previously stored from a longer raw series. Leave daily totals on if that is the figure you want kept.

`daily_totals.date` and record timestamps use the same calendar window as HC Webhook: a real `YYYY-MM-DD` from `2000-01-01` through two days after the request. Impossible dates such as `2026-13-45` are `invalid_payload`. Steps, distance, and calorie totals must be non-negative and inside the same caps (1,000,000 steps, 1,000,000 meters, 100,000 kcal). Weight is 0.5 kg through 500 kg. Body fat is 0% through 100%. Basal energy uses the calorie cap.

A test ping returns 200 and stores nothing only when `test` is true, `source` is `health_connect`, `healthkit_ios`, or `screen_time`, and `timestamp` is a non-empty string. `app_version` is not required for that ping. A body that is only `{"test": true}` is `invalid_payload`. A payload that only names `deleted_records` is accepted and does not delete rows; this store replaces whole metric-days and does not drop individual records. `source: "screen_time"` without `test: true` is rejected with `invalid_payload`. The `X-Signature` HMAC is not checked. Use `HEALTH_INGEST_TOKEN`. This adapter follows the published payload reference. It has not been verified against a live phone session.

### `GET /summary?date=YYYY-MM-DD`

`date` must match `YYYY-MM-DD` or the response is `400` `{ "error": "date=YYYY-MM-DD required" }`. An empty day is `200` with nulls and `"workouts": []`, not a 404. Any other path is `404` `{ "error": "not_found" }`.

```json
{
  "date": "2026-10-14",
  "dietary_kcal": 1200.5,
  "protein_g": 40,
  "carbs_g": 120,
  "fat_g": 35,
  "active_kcal": 500,
  "basal_kcal": 1750,
  "steps": 9321,
  "weight": { "value": 180.2, "units": "lb" },
  "body_fat_pct": 18.4,
  "workouts": [
    {
      "name": "Traditional Strength Training",
      "start": "2026-10-14 17:30:00 -0700",
      "duration_min": 45,
      "kcal": 310
    }
  ]
}
```

Workout `duration_min` is one decimal place. `kcal` is the workout's active energy, rounded, with kJ converted to kcal.

```bash
curl -sS -X POST \
  -H "Authorization: Bearer $HEALTH_INGEST_TOKEN" \
  -H "content-type: application/json" \
  --data-binary @test/sample.json \
  http://127.0.0.1:8787/ingest

curl -sS \
  -H "Authorization: Bearer $HEALTH_INGEST_TOKEN" \
  "http://127.0.0.1:8787/summary?date=2026-10-14"
```

## MCP

`POST /mcp` is a read-only [Model Context Protocol](https://modelcontextprotocol.io) endpoint using Streamable HTTP. It uses the same bearer token as the rest of the API. The server name is `health-mcp`, and a rejected token returns `WWW-Authenticate: Bearer realm="health-mcp"`. The server is stateless: it does not issue a session id, and each request stands alone. A response is one JSON-RPC object (`application/json`). A client that accepts only `text/event-stream` gets that object as a single SSE `message` event. `GET` and `DELETE` return `405`. An `initialize` request for an unsupported protocol version is answered with `2025-06-18`.

There are no write tools. A client cannot ingest, edit, or delete data through MCP.

| Tool | Arguments | Result |
| --- | --- | --- |
| `get_daily_summary` | `date` (`YYYY-MM-DD`) | The same object as `GET /summary` |
| `get_metric` | `metric`, `start_date`, `end_date` | Daily rows (`sum_qty`, `last_qty`, `last_ts`, `units`, `n`) for that inclusive span |
| `list_metrics` | none | Stored metric names, plus the summary field each recognized metric fills |
| `list_workouts` | `start_date`, `end_date` | Workouts in that inclusive span |

Dates must be real `YYYY-MM-DD` calendar days, and `start_date` must be on or before `end_date`. The end date can be at most 366 days after the start date. `get_metric` and `list_workouts` return at most 500 rows; a longer result sets `truncated` to `true`. `metric` is a Health Auto Export name such as `step_count`. Invalid arguments come back as a tool error (`isError: true`). A body that is not JSON-RPC returns `400`. A `Content-Length` over 64KB is rejected before the body is read. The body is then read in chunks and the stream is cancelled once it passes 64KB. Either case returns `413` `{ "error": "payload_too_large" }`.

Requests with no `Origin` header are allowed, which is how Cursor, Claude Desktop, and other native clients call the endpoint. A request that sends `Origin` is rejected with `403` `{ "error": "forbidden_origin" }` unless that origin is listed in `MCP_ALLOWED_ORIGINS`. The list is empty by default. Set it to a comma-separated list of origins, such as `https://example.com`, before connecting a browser client.

```bash
curl -sS -X POST \
  -H "Authorization: Bearer $HEALTH_INGEST_TOKEN" \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  http://127.0.0.1:8787/mcp
```

### Claude

In Claude Desktop or claude.ai, add a custom connector:

- URL: `https://<your-host>/mcp`
- Transport: Streamable HTTP
- Authorization header: `Bearer <HEALTH_INGEST_TOKEN>` (the word `Bearer`, a space, then the token)

### Cursor

Add a remote MCP server in Cursor settings, or in `mcp.json`:

```json
{
  "mcpServers": {
    "health-mcp": {
      "url": "https://<your-host>/mcp",
      "headers": {
        "Authorization": "Bearer <HEALTH_INGEST_TOKEN>"
      }
    }
  }
}
```

Other Streamable HTTP clients use the same URL and header. Point the host at wherever this service is deployed. The token is the `HEALTH_INGEST_TOKEN` you already set for ingest.

## Configuration

| Variable | Required | Where | Purpose |
| --- | --- | --- | --- |
| `HEALTH_INGEST_TOKEN` | yes | Worker secret, or the process environment | Bearer token for every route. Empty means every bearer request is rejected. |
| `HEALTH_INGEST_URL_TOKEN` | no | Worker secret, or the process environment | Write-only token for `POST /ingest/hc-webhook` and `POST /ingest/life-dashboard` when the app cannot send `Authorization`. Unset by default, which disables `?token=` and the path-token form. It does not authenticate `/summary`, `/mcp`, or any other route. Do not reuse `HEALTH_INGEST_TOKEN`. |
| `HEALTH_TIMEZONE` | no | Wrangler `[vars]`, or the process environment | IANA zone used when a timestamp has no numeric offset. Default `UTC` when unset. [`wrangler.example.toml`](wrangler.example.toml) sets `America/Los_Angeles`. |
| `DB` | yes on Cloudflare | Wrangler D1 binding | Must be named `DB`. |
| `DATABASE_URL` | no | Node | `postgres://` or `postgresql://` URL, otherwise a SQLite file path. |
| `SQLITE_PATH` | no | Node | SQLite file when `DATABASE_URL` is unset. Default `./data/health.sqlite`. The image sets `/data/health.sqlite`. |
| `PORT` | no | Node | Default `8787`. |
| `HOST` | no | Node | Default `0.0.0.0`. |
| `HEALTH_STORE_RAW` | no | Wrangler `[vars]`, or the process environment | Store each request body in `raw_payloads`. Default off. Set `true`, `1`, `yes`, or `on` to store it. `false`, `0`, `no`, and `off` leave it off. Bodies over about 1.5MB are skipped either way, under D1's 2MB row limit. |
| `HEALTH_METRIC_ALLOWLIST` | no | Wrangler `[vars]`, or the process environment | Comma-separated metric names to store in addition to the summary set. |
| `HEALTH_SOURCE_PRIORITY` | no | Wrangler `[vars]`, or the process environment | Comma-separated `sourceName` values from an export of Apple Health. When an export has several sources for one metric-day, the first listed source that has samples wins. Unset, summed metrics keep the largest total, and weight and body fat keep the newest reading. |
| `MCP_ALLOWED_ORIGINS` | no | Wrangler `[vars]`, or the process environment | Comma-separated `Origin` values allowed to call `/mcp`. Empty by default, which rejects every request that sends `Origin`. Requests with no `Origin` header stay allowed. |

Copy [`.env.example`](.env.example) to `.env` for Node, or [`dev.vars.example`](dev.vars.example) to `.dev.vars` for `wrangler dev`. Both real files are gitignored.

On Cloudflare, set the bearer token with `npx wrangler secret put HEALTH_INGEST_TOKEN`. Set the optional write-only URL token the same way, `npx wrangler secret put HEALTH_INGEST_URL_TOKEN`, only if a phone cannot send the header. Do not put either secret in `[vars]`. Put `HEALTH_TIMEZONE` in `[vars]` if you do not want `UTC`. The example file sets it to `America/Los_Angeles`; the code still defaults to `UTC` when the variable is absent. Copy [`wrangler.example.toml`](wrangler.example.toml) to `wrangler.toml` (gitignored) and replace `database_id`. Set `account_id` in that local file only if Wrangler should target an account other than the one you are logged in to. Do not commit either value, and do not commit a custom hostname.

## Security

`HEALTH_INGEST_TOKEN` is the credential for every route. `/ingest`, the import routes, `/summary`, and `/mcp` accept any client that sends that bearer token. There is no user account, network allowlist, or second check. An empty token rejects every bearer request. Anyone who has the token can read and write the health data this endpoint stores.

`HEALTH_INGEST_URL_TOKEN` is a separate, optional, write-only secret. Leave it unset unless HC Webhook or Life Dashboard Companion cannot send `Authorization`. While it is unset, `?token=` and `/ingest/hc-webhook/<token>` or `/ingest/life-dashboard/<token>` are rejected. When it is set, it authenticates only `POST` to those two routes. `GET`, `PUT`, and `DELETE` of those paths are rejected, and so are `/summary`, `/mcp`, `/ingest`, `/ingest/syncfit`, `/ingest/health-export-pro`, and the import routes. Sending the URL secret as `Authorization: Bearer` does not authenticate. Generate it with a second `openssl rand -hex 32`. Do not copy `HEALTH_INGEST_TOKEN` into it. If the two values are the same, the URL contains the read credential, and anyone who sees that URL can call `/summary` and `/mcp` by sending it as a bearer token.

Prefer the `Authorization` header. If the app cannot send one, put `HEALTH_INGEST_URL_TOKEN` in the path (`/ingest/hc-webhook/<token>`) rather than in `?token=`. A query string is more often copied into the `Referer` header, browser history, and analytics than a path segment. Both forms are still exposed. A token in a URL is copied into browser history, app history, screenshots, shared QR codes, the `Referer` header when the client requests another URL, reverse-proxy logs, and platform logs. Node redacts the query value and the path segment from this process's own error log, after decoding percent-encoded keys such as `%74oken`. That redaction does not apply to Cloudflare. Workers request logs, Workers Logs, Logpush, and Tail record the full URL, and nothing in the Worker can rewrite those. Do not enable the URL token on a public `workers.dev` hostname if those logs are on. Rotate `HEALTH_INGEST_URL_TOKEN` on its own when a URL may have been exposed. Header clients keep working across that rotation.

Use at least 32 random bytes. This prints 32 bytes as hex:

```bash
openssl rand -hex 32
```

Put that value in `HEALTH_INGEST_TOKEN` (a Worker secret, or the process environment for Node and Docker). Do not commit it.

Prefer the `HEALTH_INGEST_TOKEN` environment variable over the CLI `--token` flag. The import command reads the environment variable when `--token` is omitted. A value passed as `--token` is visible to other users on the machine, in the process list and often in shell history.

To rotate the token, generate a new value with `openssl rand -hex 32` and replace `HEALTH_INGEST_TOKEN`. On Cloudflare, run `npx wrangler secret put HEALTH_INGEST_TOKEN`. On Node or Docker, update the environment and restart the process. Then update every client that sends `Authorization: Bearer …` (automations, shortcuts, and MCP clients). The previous token stops working as soon as the running server is using the new value. There is no overlap between the two.

`workers_dev = true` in [`wrangler.example.toml`](wrangler.example.toml) exposes a public `workers.dev` URL. Anyone who learns that hostname and has the token can call the API. Set `workers_dev = false` in your local `wrangler.toml` when the Worker should not be reachable on `workers.dev`.

Requests without an `Origin` header are allowed. Native clients call `/mcp` that way. A request that sends `Origin` is rejected with `403` unless that origin is listed in `MCP_ALLOWED_ORIGINS`.

`HEALTH_STORE_RAW` defaults to off, so request bodies are not written to `raw_payloads` unless you set it to `true`, `1`, `yes`, or `on`.

## Deploy

### Cloudflare

Requires Node.js 22 or newer.

```bash
npm install
cp wrangler.example.toml wrangler.toml
npx wrangler login
npx wrangler d1 create health-mcp
```

Paste the printed database id into `database_id` in `wrangler.toml`. Apply migrations, including `0002_daily_points.sql`, **before** `wrangler deploy`. The worker reads `points_daily`, so deploying first makes ingest fail.

```bash
npx wrangler d1 migrations apply health-mcp --remote
printf '%s' 'replace-with-a-long-random-token' | npx wrangler secret put HEALTH_INGEST_TOKEN
npx wrangler deploy
```

`migrations apply` runs every pending file in order: `0001_init.sql`, then `0002_daily_points.sql`. Do not deploy until both have been applied.

For local development, apply the same migrations before `wrangler dev`:

```bash
cp dev.vars.example .dev.vars
npx wrangler d1 migrations apply health-mcp --local
npx wrangler dev
```

To serve a hostname of your own, uncomment `[[routes]]` in the local `wrangler.toml` and set `pattern`. The Workers preview URL works without a custom domain. `workers_dev = true` exposes a public `workers.dev` URL; see Security.

If you previously ran a build that assumed Pacific Time for offset-less timestamps, set `HEALTH_TIMEZONE` to `America/Los_Angeles`. Health Auto Export's own timestamps include an offset, and those dates do not use this variable.

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

## Works with

1. **Export from Apple Health** (supported). Data exported from Apple Health is the first supported source. The Health app writes it as `export.xml`. Send `export.xml`, or the zip that contains it, to `POST /ingest` when it fits the ingest limit. The large stream, `POST /import/apple-health`, is Node-only. A Worker stops at about a 100 MB body, so on Cloudflare run `node src/cli/import-apple-health.js` with `--chunk-url` pointed at `POST /import/apple-health/chunk`. That chunk route takes whole days that are already one row per metric and date. The same `n` upsert applies, so a metric-day has to arrive complete in one request. An export lists every source, and adding them together would double-count steps and energy. The import keeps one source per metric-day: the largest total for summed metrics, and the newest reading for weight and body fat. `HEALTH_SOURCE_PRIORITY` is an optional comma-separated list of `sourceName` values; the first listed source that has samples that day wins instead.
2. **Android Health Connect** (published payloads supported, live apps untested). HC Webhook posts to `POST /ingest/hc-webhook`. Life Dashboard Companion posts to `POST /ingest/life-dashboard`. Both write the same summary metrics as an iPhone export: steps, active energy, dietary energy, protein, carbohydrates, fat, weight, and body fat. Setup for each app is below.
3. **Health Auto Export** (supported). REST JSON, export version 2, posted to `POST /ingest`. The shape is documented above, and the iOS setup is below. Any other client that sends that same shape can use this path too.
4. **SyncFit** (native format supported). A body with `schemaVersion` 1 and a `samples` array, and no `data` object, is accepted on `POST /ingest` and `POST /ingest/syncfit`. `basal_energy` is stored as `basal_energy_burned`, `body_mass` as `weight_body_mass`, and dietary sample names map onto the summary metrics. A `workout` sample's `value` is duration in seconds, and `details.activityType` is the HealthKit activity integer. The Health Auto Export preview layout is untested.
5. **Health Export Pro** (published payload supported, live app untested). A body with `exportDate`, `startDate`, `endDate`, `syncSource`, and `data` keyed by HealthKit type is accepted on `POST /ingest` and `POST /ingest/health-export-pro`. Quantity samples use the same metric names as an export from Apple Health. Workout `workoutActivityType` is the HealthKit integer. Medication sections and workout routes are ignored.
6. **iOS Shortcuts** (untested). Build the Health Auto Export JSON shape and POST it to `/ingest`. One recipe: Find Health Samples for a metric you store, put each sample's date and quantity into `data.metrics[].data` as `{ "date", "qty" }` with `name` and `units`, then Get Contents of URL with method POST, the header `Authorization` set to `Bearer <HEALTH_INGEST_TOKEN>`, and that JSON as the body. Health samples cannot be read while the phone is locked, so the shortcut has to run while the device is unlocked. This recipe has not been run against this server.

## Health Auto Export

Install Health Auto Export on iOS and create **two** REST API automations that post to the same URL. The app allows one data type per automation. Official reference: [Health Auto Export REST API automations](https://help.healthyapps.dev/en/health-auto-export/automations/rest-api).

1. Open the sidebar, tap **Automations**, then **New Automation**, and choose **REST API**.
2. URL: `https://<your-host>/ingest` (for a local server, an address the phone can reach, such as `http://192.168.1.10:8787/ingest`).
3. Add a header. Key `Authorization`, value `Bearer <HEALTH_INGEST_TOKEN>` (the word `Bearer`, a space, then the token).
4. Export format **JSON**. Export version **Version 2**.
5. First automation: data type **Health Metrics**. Select only the metrics you store: Dietary Energy, Protein, Carbohydrates, Total Fat, Active Energy, Basal Energy Burned, Step Count, Weight, and Body Fat Percentage. Prefer a summary or time grouping that does not emit overlapping buckets for the same quantity.
6. Second automation: data type **Workouts**, with the same URL, header, JSON format, and export version 2. Active energy on each workout is stored as `kcal`. Leave route and per-second workout metrics off unless you need them; this service only reads the workout name, start, end, duration, and active energy, and large payloads are more likely to fail on the phone.
7. Use **Manual Export** to send a sample, then call `GET /summary?date=YYYY-MM-DD`. Send whole days. Leave **Batch requests** off when a single metric can have more than one sample on the same calendar day. A shorter request does not replace a fuller day, so a batch that splits that day never becomes the full total. Re-sending the same whole day does not double the totals.

Automations run only while the phone is unlocked, which is an iOS limit.

## HC Webhook

Install [HC Webhook](https://github.com/mcnaveen/health-connect-webhook) on Android. The app reads Health Connect and POSTs JSON. Payload fields are documented in that repository's `docs/webhook.md`.

1. Grant Health Connect read permission for the types you want stored.
2. Add a webhook. URL: `https://<your-host>/ingest/hc-webhook`. Delivery format **JSON**.
3. Add a custom header. Key `Authorization`, value `Bearer <HEALTH_INGEST_TOKEN>` (the word `Bearer`, a space, then the token).
4. For steps, prefer **Daily** resolution so each day is one cumulative total. That row's `n` stays 1, and a later sync replaces the day instead of leaving a partial batch in place. If you use full or bucketed resolution, each request that should win has to include every sample for that metric-day. Incremental sync only sends records new since the last success, and this server does not add that batch onto the stored total.
5. Weight is stored in kilograms. Set `HEALTH_TIMEZONE` to the phone's zone. These timestamps are UTC instants and do not carry a numeric offset.
6. If this install cannot set an `Authorization` header, set `HEALTH_INGEST_URL_TOKEN` to its own random value (not `HEALTH_INGEST_TOKEN`) and use `https://<your-host>/ingest/hc-webhook/<HEALTH_INGEST_URL_TOKEN>`. Prefer that path over `?token=`. The secret can only POST to this route and `/ingest/life-dashboard`. It cannot call `/summary` or `/mcp`. Leave the variable unset to disable those URLs. The header is safer: Cloudflare request logs, Workers Logs, Logpush, and Tail keep the full URL, and this Worker cannot redact them. A query token can also leak through `Referer`. See [Security](#security).
7. Run a sync, then call `GET /summary?date=YYYY-MM-DD`.

Protobuf delivery is not accepted. The local on-device HTTP server speaks the same JSON; point a client at it only on a network you trust, then POST that JSON here with the bearer token.

## Life Dashboard Companion

Install [Life Dashboard Companion](https://github.com/owen282000/life-dashboard-companion-app) on Android. The health webhook format is documented in that repository's `docs/webhook.md`. The iPhone app posts the same shape with `source` `healthkit_ios` and can use this route as well.

1. On the **Health** tab, grant Health Connect permission for the types you store.
2. Under webhook URLs, add `https://<your-host>/ingest/life-dashboard`.
3. Under webhook headers, add `Authorization` with value `Bearer <HEALTH_INGEST_TOKEN>`. A URL added by QR pairing does not receive those headers. For that address, set `HEALTH_INGEST_URL_TOKEN` and put that write-only secret in the path, as described for HC Webhook. Prefer the path over `?token=`. Do not put `HEALTH_INGEST_TOKEN` in the URL. Treat a QR code or screenshot of that URL as a leaked write secret and rotate `HEALTH_INGEST_URL_TOKEN`.
4. Leave **Daily totals in payload** on. Steps, distance, and calories are taken from `daily_totals` so a walk recorded by both phone and watch is counted once. Today's total is a running total; sending it again replaces the stored day (`n` stays 1) and does not add to it.
5. This server does not check `X-Signature`. An HMAC secret in the app is optional and is not the credential this route uses.
6. Set `HEALTH_TIMEZONE` to the phone's zone. `daily_totals.date` is already that local day. Record timestamps are UTC; when record metadata includes a zone offset, that offset picks the day.
7. Do not point the Screen Time webhook at this URL. That payload is rejected. Deletions named in `deleted_records` are accepted and not applied.
8. Use **Test ping**, then **Sync Now**, then `GET /summary?date=YYYY-MM-DD`. A backfill of past days is available on the Health tab. Each day in that backfill still has to arrive as a complete metric-day for the `n` rule.

## Development

```bash
npm install
npm test
```

`npm test` runs the core against an in-memory storage fake, the Cloudflare adapter against a D1-shaped wrapper over SQLite, and the Node adapter over HTTP with a SQLite file. The Postgres adapter is tested with a fake client that records SQL, so a database server is not required. GitHub Actions runs the same command on pull requests and on pushes to `main`.

## Layout

```
src/core                 parse, daily aggregate, summarize, bearer auth, HTTP, MCP
src/core/hk.js           HealthKit quantity and workout names
src/core/apple-export.js streaming export.xml and zip parser
src/core/health-export-pro.js
src/core/syncfit.js      SyncFit schemaVersion 1
src/core/health-connect.js  shared Health Connect units and exercise names
src/core/hc-webhook.js   HC Webhook JSON
src/core/life-dashboard.js  Life Dashboard Companion JSON
src/cli/import-apple-health.js
src/adapters/d1.js       D1 storage
src/adapters/cloudflare.js
src/adapters/node.js     node:http server
src/adapters/sqlite.js
src/adapters/postgres.js
src/index.js             Wrangler entry
migrations/0001_init.sql
migrations/0002_daily_points.sql
```

The storage interface is `insertIngest(batch)`, `queryDaySummary(date)`, `queryMetricRange(metric, startDate, endDate)`, `listMetrics()`, and `listWorkouts(startDate, endDate)`. `batch.points` is already one row per `(metric, date)` (`sum_qty`, `last_qty`, `last_ts`, `units`, `n`). `storeRaw: false` skips the raw body. `queryDaySummary` returns the `/summary` object. The three range methods only read. `MemoryStorage` in `src/core/memory.js` is the reference implementation.
