# Data sources and phone app setup

Detailed setup for each supported source. Payload details are in [api.md](api.md).

## Works with

1. **Export from Apple Health** (supported file import). Data exported from Apple Health is a bulk file, not a live phone sync. The Health app writes it as `export.xml`. Send `export.xml`, or the zip that contains it, to `POST /import/apple-health`. On Node that route streams a large file. A Worker stops at about a 100 MB body, so on Cloudflare run `node src/cli/import-apple-health.js` with `--chunk-url` pointed at `POST /import/apple-health/chunk`. That chunk route takes whole days that are already one row per metric and date. The same `n` upsert applies, so a metric-day has to arrive complete in one request. An export lists every source, and adding them together would double-count steps and energy. The import keeps one source per metric-day: the largest total for summed metrics, and the newest reading for weight and body fat. `HEALTH_SOURCE_PRIORITY` is an optional comma-separated list of `sourceName` values; the first listed source that has samples that day wins instead.
2. **Android Health Connect** (published payload supported, live app untested). HC Webhook is the only Android ingest path. It posts to `POST /ingest/hc-webhook` and writes the same summary metrics as an iPhone export: steps, active energy, dietary energy, protein, carbohydrates, fat, weight, and body fat. Setup is below.
3. **iOS Shortcuts** (server tested, iPhone steps unverified). Shortcuts is the only live iPhone path. The Shortcuts app that comes with iPhone needs no extra app. A daily automation runs **Find Health Samples** and posts one daily total per metric (Find Health Samples grouped by day; raw samples with a Source filter as a fallback) to `POST /ingest/shortcuts` with **Get Contents of URL**, preferably with the `Authorization` header (the write-only `HEALTH_INGEST_URL_TOKEN` path also works). A Bearer Shortcuts daily total replaces that metric-day even if an earlier import or HC Webhook sync wrote it, while URL-token requests cannot override existing days. Numbers may be strings and dates must be ISO 8601. Health samples cannot be read while the phone is locked. Step-by-step guide, format, and limits: [shortcuts.md](shortcuts.md).

## HC Webhook

Install [HC Webhook](https://github.com/mcnaveen/health-connect-webhook) on Android. The app reads Health Connect and POSTs JSON. Payload fields are documented in that repository's `docs/webhook.md`.

1. Grant Health Connect read permission for the types you want stored.
2. Add a webhook. URL: `https://<your-host>/ingest/hc-webhook`. Delivery format **JSON**.
3. Add a custom header. Key `Authorization`, value `Bearer <HEALTH_INGEST_TOKEN>` (the word `Bearer`, a space, then the token).
4. For steps, prefer **Daily** resolution so each day is one cumulative total. That row's `n` stays 1, and a later sync replaces the day instead of leaving a partial batch in place. If you use full or bucketed resolution, each request that should win has to include every sample for that metric-day. Incremental sync only sends records new since the last success, and this server does not add that batch onto the stored total. Grant only the stored types. For history, use **Manual Sync → Custom selection** and send **one day at a time**. Do not use Past 7 Days or Past 30 Days. A batch over the free profile's cap returns 413 and is not partially stored.
5. Weight is stored in kilograms. Set `HEALTH_TIMEZONE` to the phone's zone. These timestamps are UTC instants and do not carry a numeric offset.
6. If this install cannot set an `Authorization` header, set `HEALTH_INGEST_URL_TOKEN` to its own random value (not `HEALTH_INGEST_TOKEN`) and use `https://<your-host>/ingest/hc-webhook/<HEALTH_INGEST_URL_TOKEN>`. Prefer that path over `?token=`. The secret can only POST to this route and `/ingest/shortcuts`. It cannot call `/summary` or `/mcp`. Leave the variable unset to disable those URLs. The header is safer: Cloudflare request logs, Workers Logs, Logpush, and Tail keep the full URL, and this Worker cannot redact them. A query token can also leak through `Referer`. See [Security](security.md).
7. Run a sync, then call `GET /summary?date=YYYY-MM-DD`.

Protobuf delivery is not accepted. The local on-device HTTP server speaks the same JSON; point a client at it only on a network you trust, then POST that JSON here with the bearer token.
