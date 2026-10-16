# API reference

Full reference for every route, payload format, and the MCP endpoint. Start with the [README](../README.md) for setup.

A self-hosted health data endpoint. It works with a file exported from Apple Health, with Android Health Connect through HC Webhook, and with Apple Shortcuts on iPhone, and it serves daily summaries. Live phone sync is `POST /ingest/hc-webhook` and `POST /ingest/shortcuts`. A one-time Health app export goes to `POST /import/apple-health`. `GET /summary` returns one calendar day's totals. Any other path is not a route.

The parsing, aggregation, auth, HTTP handling, and read-only MCP endpoint live in `src/core` and depend only on web standards (`Request`, `Response`, `fetch`, `crypto`, `Intl`). Persistence is a small storage interface. Two adapters implement it:

- **Cloudflare Workers + D1** (`src/index.js`, the Wrangler entry)
- **Node.js** (`src/adapters/node.js`) with SQLite via [better-sqlite3](https://github.com/WiseLibs/better-sqlite3), or Postgres when `DATABASE_URL` is a `postgres://` URL

`migrations/` is plain SQL that runs on SQLite, D1, and Postgres. The repo ships synthetic fixtures only. Do not commit tokens, `wrangler.toml`, or exports of real health data.


## Routes and auth

`/import/apple-health`, `/import/apple-health/chunk`, `/ingest/hc-webhook`, `/ingest/shortcuts`, `/summary`, and `/mcp` require `Authorization: Bearer <HEALTH_INGEST_TOKEN>`. A missing or wrong token returns `401` and `{ "error": "unauthorized" }`. Responses are JSON and send `cache-control: no-store`.

The bearer header is the default and is what HC Webhook can send as a custom header. `GET /summary`, `POST /mcp`, and every other route accept only that header. They never accept a token in the query string or the path, even when the value matches `HEALTH_INGEST_TOKEN`.

`POST /ingest/hc-webhook` and `POST /ingest/shortcuts` can also accept a different secret, `HEALTH_INGEST_URL_TOKEN`, when the `Authorization` header is absent. Prefer the path form, `/ingest/hc-webhook/<token>` or `/ingest/shortcuts/<token>`, over the `token` query parameter. The query form accepts only a literal `token=` key, not an encoded key such as `%74oken`. The path segment and the query value are compared raw: they are not percent-decoded or trimmed. The secret must match `^[A-Za-z0-9_-]{32,}$`. A shorter value, a space, or any other character leaves URL-token auth off. It is also left off when the value is the same as `HEALTH_INGEST_TOKEN`. It is rejected on every other route and method, including `GET` of those same paths. The comparison is constant-time. A request that sends an `Authorization` header is checked only against `HEALTH_INGEST_TOKEN`; the URL token is not a bearer credential and cannot read. An empty `HEALTH_INGEST_TOKEN` still rejects every bearer request. This process redacts `token` query values, including percent-encoded keys such as `%74oken`, and those path segments from its own error logs. Cloudflare request logs cannot be redacted that way. See [Security](security.md).

A JSON body over 20,000,000 characters returns `413` `{ "error": "payload_too_large" }`. Invalid JSON returns `400` `{ "error": "invalid_json" }`. The Node server also stops reading at 20,000,000 bytes, except `POST /import/apple-health`, which streams a larger file. After a valid bearer token, any other path is `404` `{ "error": "not_found" }`.

## Stored metrics

HC Webhook and an Apple Health import aggregate in memory to **one row per (metric, date)**: `sum_qty`, `last_qty`, `last_ts`, `units`, and `n` (sample count). Only the summary metrics are kept, plus any names in `HEALTH_METRIC_ALLOWLIST`. The upsert replaces the existing row for that date and metric only when the new `n` is greater than or equal to the stored `n` (`WHERE excluded.n >= points_daily.n`). It does not add to the previous total, so posting the same samples again cannot double-count. A shorter re-send is ignored, so a partial day cannot wipe a fuller total. A request that uses this comparison has to contain every sample that should remain for each metric-day it includes. A later upload with at least as many samples replaces the row. Other metrics on that date are left alone. Workouts stay one row per `(name, start)`. `POST /ingest/shortcuts` with the Bearer token replaces the metric-day instead of comparing `n`. See that route below.

The raw JSON is one `raw_payloads` row per request only when `HEALTH_STORE_RAW` is enabled. It defaults to off. Set `HEALTH_STORE_RAW=true` (or `1`, `yes`, or `on`) to keep the body. A body larger than about 1.5MB is skipped even then, so the row stays under D1's 2MB limit. Metrics in that body are still ingested.

There is no secondary index on the daily table. The primary key is `(date, metric)`, which is enough for `GET /summary` and avoids a second write per row.

Recognized metrics:

| Stored name | Summary field | Aggregation |
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

Metrics outside the summary set are dropped unless listed in `HEALTH_METRIC_ALLOWLIST`. Allowlisted metrics are stored and do not appear in `/summary`.

`/summary` adds `sum_qty` for summed metrics and reads `last_qty` for weight and body fat. Send each real quantity once inside a request (one daily total, or non-overlapping buckets). A later request with fewer samples for that metric-day is ignored, so splitting one day across requests leaves the stored total at whichever request had the larger sample count. A Shortcuts request with the Bearer token is the exception: it replaces the days it contains.

### Export from Apple Health

Data exported from Apple Health is a supported file import. It is not a live phone sync. The Health app writes that export as `export.xml`. Send `export.xml`, or a zip of that export, to `POST /import/apple-health`.

`POST /import/apple-health` on the Node server reads `export.xml`, or a zip whose entry is named `export.xml`, up to 2,000,000,000 compressed bytes, without buffering the file at the 20 MB JSON limit. A Worker cannot take a full export: platform body, memory, and CPU limits are much smaller (about 100 MB). On Cloudflare, run `node src/cli/import-apple-health.js` with `--chunk-url` pointed at the Worker. The zip entry must store its sizes in the local header (no data descriptor) and use stored or deflate compression. Zip64 is rejected. Decompressed XML is capped at 10 GB, and a ratio above 200:1 after 100 MB of output is rejected with `413`.

- `POST /import/apple-health/chunk` accepts JSON `{ "points": [], "workouts": [] }`. Each point is already one whole `(metric, date)` row: `sum_qty`, `last_qty`, `last_ts`, `units`, and `n`. The same `n` upsert applies, and this route trusts the `n` you send. A metric-day has to arrive complete in one chunk, because a later shorter chunk does not replace that day.
- `node src/cli/import-apple-health.js <file>` writes through Node storage (`DATABASE_URL` or `SQLITE_PATH`). `--chunk-url` posts whole-date chunks (31 dates at a time) to `/import/apple-health/chunk`. `--token` and `--time-zone` override the environment for that run. Prefer `HEALTH_INGEST_TOKEN` in the environment; a token on the command line is visible to other users on the machine.

Quantity types map onto the summary metrics: DietaryEnergyConsumed, DietaryProtein, DietaryCarbohydrates, DietaryFatTotal, ActiveEnergyBurned, BasalEnergyBurned, StepCount, BodyMass, and BodyFatPercentage. Other `HKQuantityTypeIdentifier` names are stored only when `HEALTH_METRIC_ALLOWLIST` lists the snake_case form (`HeartRate` becomes `heart_rate`). A workout's activity type becomes its name (`HKWorkoutActivityTypeTraditionalStrengthTraining` becomes `Traditional Strength Training`). Duration is stored in minutes. Energy in kJ is converted to kcal. The raw XML is not stored.

Records are aggregated while streaming, one running total per metric, day, and `sourceName`. The samples themselves are not kept. For each summed metric-day the import keeps the source with the largest total. Weight and body fat keep the source with the newest reading. Set `HEALTH_SOURCE_PRIORITY` to a comma-separated list of `sourceName` values to prefer those sources, in order, when they have samples that day. A timestamp that repeats the bucket's latest timestamp replaces that quantity instead of being added twice.

Days on or after the export's `<ExportDate value="…">` are dropped. That calendar day is still in progress in the Health app, so the file only has a partial total. Earlier imported days keep their record-count `n`, so they stay in place unless a later upload for that metric-day has at least as many samples, or a Shortcuts request sent with the Bearer token replaces the day.

A `<!DOCTYPE HealthData [ <!ELEMENT …> <!ATTLIST …> ]>` header from an export of Apple Health is accepted. A DOCTYPE that uses `SYSTEM`, `PUBLIC`, or `<!ENTITY` is rejected. Comments, `CDATA` sections, and the DOCTYPE subset are not scanned for records.

### HC Webhook

HC Webhook's JSON is accepted on `POST /ingest/hc-webhook`. Record arrays use the names and units in the app's webhook reference: `steps.count`, `active_calories.calories` in kcal, `weight.kilograms`, `body_fat.percentage`, `nutrition` (`calories`, `protein_grams`, `carbs_grams`, `fat_grams`), and `exercise` with `type`, `start_time`, `end_time`, and `duration_seconds`. `type` is Health Connect's exercise type as a decimal string (`56` Running, `79` Walking, `70` Strength Training). The exercise object has no energy field, so workout `kcal` is null. Sleep stages, cadence, and route-like fields are not stored. `total_calories`, `distance`, heart rate, and sleep duration are stored only when `HEALTH_METRIC_ALLOWLIST` names `total_calories`, `distance`, `heart_rate`, or `sleep_analysis`. `basal_metabolic_rate` is watts in this payload and is not converted into `basal_kcal`. The app also emits `bmi` when weight and height are both present; that is stored as `body_mass_index` only when allowlisted.

Timestamps are UTC instants (`Z`). The calendar day comes from `HEALTH_TIMEZONE`. A stored day must be a real calendar date from `2000-01-01` through two days after the request is received. `2026-13-45`, `2026-02-29` in a non-leap year, a day before 2000, and a timestamp in year 9999 are `invalid_payload`. Steps and active or total calories must be from 0 through 1,000,000 steps or 100,000 kcal. Weight must be from 0.5 kg through 500 kg. Body fat must be from 0% through 100%. A value outside those bounds is `invalid_payload` and is not stored. A heart-rate aggregate includes `avg` and a `bpm` alias of that average; one sample is stored. The same `n` upsert applies. Daily step resolution is one cumulative row per day (`n` stays 1), so a later sync replaces that day. A full or bucketed series replaces a metric-day only when the new request has at least as many samples, and it does not add to the previous total. Incremental sync sends only records new since the last success, so send a range that still contains the whole day for each metric you want replaced. This adapter follows the published JSON reference and the app source that builds it. It has not been verified against a live phone session.

### iOS Shortcuts

`POST /ingest/shortcuts` takes `{ "samples": [{ "kind", "type", "value", "unit", "start", "end", "source" }], "workouts": [{ "type", "start", "end", "duration", "energy", "energyUnit" }] }`, built with the Shortcuts app. This is the only live iPhone ingest path. `kind: "daily"` entries are stored as the day total. Raw samples keep one source per metric-day (`HEALTH_SHORTCUTS_SOURCE_PRIORITY`, default `watch,iphone`). With `Authorization: Bearer`, rows from this route replace the stored metric-day instead of using the `n` comparison, whatever wrote that day; a daily total is treated as the complete day, so use one ingest path per metric. With `HEALTH_INGEST_URL_TOKEN`, rows use the guarded upsert with `n` 0, so they can create a day or update one the URL token wrote, but never replace a day with `n` of 1 or more. URL-token workouts are insert-only and never change an existing workout. A daily total and raw samples for the same metric-day in one request return `400`, and so does an offset-less local time skipped by a DST jump. Values may be numeric strings; dates must be ISO 8601, and offset-less times are read in `HEALTH_TIMEZONE`. One invalid entry rejects the request with `400` and `{ "error": "invalid_payload", "at": "samples[12]", "field": "start" }`; values are not echoed. The success response adds `dropped`, the number of entries not stored because of the metric allowlist. Full field list and setup: [shortcuts.md](shortcuts.md).

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
  --data '{"samples":[{"kind":"daily","type":"Steps","value":"9321","unit":"count","date":"2026-10-14"}]}' \
  http://127.0.0.1:8787/ingest/shortcuts

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

Dates must be real `YYYY-MM-DD` calendar days, and `start_date` must be on or before `end_date`. The end date can be at most 366 days after the start date. `get_metric` and `list_workouts` return at most 500 rows; a longer result sets `truncated` to `true`. `metric` is a stored name such as `step_count`. Invalid arguments come back as a tool error (`isError: true`). A body that is not JSON-RPC returns `400`. A `Content-Length` over 64KB is rejected before the body is read. The body is then read in chunks and the stream is cancelled once it passes 64KB. Either case returns `413` `{ "error": "payload_too_large" }`.

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
