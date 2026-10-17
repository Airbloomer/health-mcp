# Data sources and phone app setup

Detailed setup for each supported exporter. Payload details for each format are in [api.md](api.md).

## Works with

1. **Export from Apple Health** (supported). Data exported from Apple Health is the first supported source. The Health app writes it as `export.xml`. Send `export.xml`, or the zip that contains it, to `POST /ingest` when it fits the ingest limit. The large stream, `POST /import/apple-health`, is Node-only. A Worker stops at about a 100 MB body, so on Cloudflare run `node src/cli/import-apple-health.js` with `--chunk-url` pointed at `POST /import/apple-health/chunk`. That chunk route takes whole days that are already one row per metric and date. The same `n` upsert applies, so a metric-day has to arrive complete in one request. An export lists every source, and adding them together would double-count steps and energy. The import keeps one source per metric-day: the largest total for summed metrics, and the newest reading for weight and body fat. `HEALTH_SOURCE_PRIORITY` is an optional comma-separated list of `sourceName` values; the first listed source that has samples that day wins instead.
2. **Android Health Connect** (published payloads supported, live apps untested). HC Webhook posts to `POST /ingest/hc-webhook`. Life Dashboard Companion posts to `POST /ingest/life-dashboard`. Both write the same summary metrics as an iPhone export: steps, active energy, dietary energy, protein, carbohydrates, fat, weight, and body fat. Setup for each app is below.
3. **Health Auto Export** (supported). REST JSON, export version 2, posted to `POST /ingest`. The shape is documented in [api.md](api.md#post-ingest), and the iOS setup is below. Any other client that sends that same shape can use this path too.
4. **SyncFit** (native format supported). A body with `schemaVersion` 1 and a `samples` array, and no `data` object, is accepted on `POST /ingest` and `POST /ingest/syncfit`. `basal_energy` is stored as `basal_energy_burned`, `body_mass` as `weight_body_mass`, and dietary sample names map onto the summary metrics. A `workout` sample's `value` is duration in seconds, and `details.activityType` is the HealthKit activity integer. The Health Auto Export preview layout is untested.
5. **Health Export Pro** (published payload supported, live app untested). A body with `exportDate`, `startDate`, `endDate`, `syncSource`, and `data` keyed by HealthKit type is accepted on `POST /ingest` and `POST /ingest/health-export-pro`. Quantity samples use the same metric names as an export from Apple Health. Workout `workoutActivityType` is the HealthKit integer. Medication sections and workout routes are ignored.
6. **iOS Shortcuts** (server tested, iPhone steps unverified). The Shortcuts app that comes with iPhone, no extra app. A daily automation runs **Find Health Samples** and posts one daily total per metric (Find Health Samples grouped by day; raw samples with a Source filter as a fallback) to `POST /ingest/shortcuts` with **Get Contents of URL**, preferably with the `Authorization` header (the write-only `HEALTH_INGEST_URL_TOKEN` path also works). A Bearer Shortcuts daily total replaces that metric-day even if another app wrote it, while URL-token requests cannot override existing days. Numbers may be strings and dates must be ISO 8601. Health samples cannot be read while the phone is locked. Step-by-step guide, format, and limits: [shortcuts.md](shortcuts.md).

## Health Auto Export

Install Health Auto Export on iOS and create **two** REST API automations that post to the same URL. The app allows one data type per automation. Official reference: [Health Auto Export REST API automations](https://help.healthyapps.dev/en/health-auto-export/automations/rest-api).

1. Open the sidebar, tap **Automations**, then **New Automation**, and choose **REST API**.
2. URL: `https://<your-host>/ingest` (for a local server, an address the phone can reach, such as `http://192.168.1.10:8787/ingest`).
3. Add a header. Key `Authorization`, value `Bearer <HEALTH_INGEST_TOKEN>` (the word `Bearer`, a space, then the token).
4. Export format **JSON**. Export version **Version 2**.
5. First automation: data type **Health Metrics**. Select only the metrics you store: Dietary Energy, Protein, Carbohydrates, Total Fat, Active Energy, Basal Energy Burned, Step Count, Weight, and Body Fat Percentage. Use one total per metric per day, not hourly buckets.
6. Set the date range to **today and yesterday**. Yesterday is the finished day, and today is the running total. Today only never sends yesterday's finished total. A full history is the wrong range for this repeating automation. After the initial import window closes, `POST /ingest` keeps today and yesterday in `HEALTH_TIMEZONE` (`INGEST_MAX_AGE_DAYS`, default 1) and drops older points. Those dropped points are counted as `dropped_stale`. A date more than one day ahead is dropped and counted as `dropped_future`. A one-time full history can be sent during the initial import window, or at any time on `POST /import/apple-health`. Import that history in chunks of 5 MB or less. An Apple Health import is stored in batches of at most 366 dates and is not rejected for the date count. It does not open or close the initial import window. Dates before `INGEST_MIN_DATE` (default `2000-01-01`) are not accepted on Health Auto Export JSON.
7. Schedule the automation a few times a day, not every hour. Metrics and workouts are two posts and share one token. The default limit is 6 accepted posts per token per hour (`INGEST_RATE_LIMIT_PER_HOUR`). A JSON body over 1,000,000 bytes (`INGEST_MAX_BODY_BYTES`) is rejected.
8. Second automation: data type **Workouts**, with the same URL, header, JSON format, export version 2, date range, and schedule. Active energy on each workout is stored as `kcal`. Leave route and per-second workout metrics off unless you need them; this service only reads the workout name, start, end, duration, and active energy, and large payloads are more likely to fail on the phone.
9. Use **Manual Export** to send a sample, then call `GET /summary?date=YYYY-MM-DD`. Send whole days. Leave **Batch requests** off when a single metric can have more than one sample on the same calendar day. A shorter request does not replace a fuller day, so a batch that splits that day never becomes the full total. Re-sending the same whole day does not double the totals, and it does not write the row again when the values already match. These are the same choices as [Recommended export settings](../README.md#recommended-export-settings) in the README.

Automations run only while the phone is unlocked, which is an iOS limit.

## HC Webhook

Install [HC Webhook](https://github.com/mcnaveen/health-connect-webhook) on Android. The app reads Health Connect and POSTs JSON. Payload fields are documented in that repository's `docs/webhook.md`.

1. Grant Health Connect read permission for the types you want stored.
2. Add a webhook. URL: `https://<your-host>/ingest/hc-webhook`. Delivery format **JSON**.
3. Add a custom header. Key `Authorization`, value `Bearer <HEALTH_INGEST_TOKEN>` (the word `Bearer`, a space, then the token).
4. For steps, prefer **Daily** resolution so each day is one cumulative total. That row's `n` stays 1, and a later sync replaces the day instead of leaving a partial batch in place. If you use full or bucketed resolution, each request that should win has to include every sample for that metric-day. Incremental sync only sends records new since the last success, and this server does not add that batch onto the stored total.
5. Weight is stored in kilograms. Set `HEALTH_TIMEZONE` to the phone's zone. These timestamps are UTC instants and do not carry a numeric offset.
6. If this install cannot set an `Authorization` header, set `HEALTH_INGEST_URL_TOKEN` to its own random value (not `HEALTH_INGEST_TOKEN`) and use `https://<your-host>/ingest/hc-webhook/<HEALTH_INGEST_URL_TOKEN>`. Prefer that path over `?token=`. The secret can only POST to this route and `/ingest/life-dashboard`. It cannot call `/summary` or `/mcp`. Leave the variable unset to disable those URLs. The header is safer: Cloudflare request logs, Workers Logs, Logpush, and Tail keep the full URL, and this Worker cannot redact them. A query token can also leak through `Referer`. See [Security](security.md).
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
