# API reference

Full reference for every route, payload format, and the MCP endpoint. Start with the [README](../README.md) for setup.

A self-hosted health data endpoint. It works with data exported from Apple Health and with Android Health Connect, and serves daily summaries. `POST /ingest` accepts the [Health Auto Export](https://help.healthyapps.dev/en/health-auto-export/automations/rest-api) JSON format (export version 2) and the other sources in [Data sources](sources.md). `GET /summary` returns one calendar day's totals.

The parsing, aggregation, auth, HTTP handling, and read-only MCP endpoint live in `src/core` and depend only on web standards (`Request`, `Response`, `fetch`, `crypto`, `Intl`). Persistence is a small storage interface. Two adapters implement it:

- **Cloudflare Workers + D1** (`src/index.js`, the Wrangler entry)
- **Node.js** (`src/adapters/node.js`) with SQLite via [better-sqlite3](https://github.com/WiseLibs/better-sqlite3), or Postgres when `DATABASE_URL` is a `postgres://` URL

`migrations/` is plain SQL that runs on SQLite, D1, and Postgres. The repo ships synthetic fixtures only. Do not commit tokens, `wrangler.toml`, or exports of real health data.


## Routes and auth

`/ingest`, `/import/apple-health`, `/import/apple-health/chunk`, `/ingest/health-export-pro`, `/ingest/syncfit`, `/ingest/hc-webhook`, `/ingest/life-dashboard`, `/ingest/shortcuts`, `/summary`, and `/mcp` require `Authorization: Bearer <HEALTH_INGEST_TOKEN>`. A missing or wrong token returns `401` and `{ "error": "unauthorized" }`. Responses are JSON and send `cache-control: no-store`.

The bearer header is the default and is what both Android apps can send as a custom header. `GET /summary`, `POST /mcp`, and every other route accept only that header. They never accept a token in the query string or the path, even when the value matches `HEALTH_INGEST_TOKEN`.

`POST /ingest/hc-webhook`, `POST /ingest/life-dashboard`, and `POST /ingest/shortcuts` can also accept a different secret, `HEALTH_INGEST_URL_TOKEN`, when the `Authorization` header is absent. Prefer the path form, `/ingest/hc-webhook/<token>`, `/ingest/life-dashboard/<token>`, or `/ingest/shortcuts/<token>`, over the `token` query parameter. The query form accepts only a literal `token=` key, not an encoded key such as `%74oken`. The path segment and the query value are compared raw: they are not percent-decoded or trimmed. The secret must match `^[A-Za-z0-9_-]{32,}$`. A shorter value, a space, or any other character leaves URL-token auth off. It is also left off when the value is the same as `HEALTH_INGEST_TOKEN`. It is rejected on every other route and method, including `GET` of those same paths. The comparison is constant-time. A request that sends an `Authorization` header is checked only against `HEALTH_INGEST_TOKEN`; the URL token is not a bearer credential and cannot read. An empty `HEALTH_INGEST_TOKEN` still rejects every bearer request. This process redacts `token` query values, including percent-encoded keys such as `%74oken`, and those path segments from its own error logs. Cloudflare request logs cannot be redacted that way. See [Security](security.md).

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

On Cloudflare, the plan is: free tier; upgrade when a real limit is hit. This worker does not drop writes ahead of D1 and does not sample CPU. When D1 returns its documented daily row write or row read limit error, `POST /ingest` responds `429` `{ "error": "daily_limit", "limit_hit": "d1_rows_written" }` or `"d1_rows_read"`, with `Retry-After` set to the seconds until the next 00:00 UTC. The worker logs one JSON line, `limit_hit`. The log name for a measured approach to a cap is `limit_near`.

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

### iOS Shortcuts

`POST /ingest/shortcuts` takes `{ "samples": [{ "kind", "type", "value", "unit", "start", "end", "source" }], "workouts": [{ "type", "start", "end", "duration", "energy", "energyUnit" }] }`, built with the Shortcuts app. `kind: "daily"` entries are stored as the day total. Raw samples keep one source per metric-day (`HEALTH_SHORTCUTS_SOURCE_PRIORITY`, default `watch,iphone`). With `Authorization: Bearer`, rows from this route replace the stored metric-day instead of using the `n` comparison, whatever app wrote that day; a daily total is treated as the complete day, so use one ingest path per metric. With `HEALTH_INGEST_URL_TOKEN`, rows use the guarded upsert with `n` 0, so they can create a day or update one the URL token wrote, but never replace a day with `n` of 1 or more. URL-token workouts are insert-only and never change an existing workout. A daily total and raw samples for the same metric-day in one request return `400`, and so does an offset-less local time skipped by a DST jump. Values may be numeric strings; dates must be ISO 8601, and offset-less times are read in `HEALTH_TIMEZONE`. One invalid entry rejects the request with `400` and `{ "error": "invalid_payload", "at": "samples[12]", "field": "start" }`; values are not echoed. The success response adds `dropped`, the number of entries not stored because of the metric allowlist. It is not detected on `POST /ingest`. Full field list and setup: [shortcuts.md](shortcuts.md).

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
