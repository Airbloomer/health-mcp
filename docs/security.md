# Security

How tokens work and what to watch for. To report a vulnerability, see [SECURITY.md](../SECURITY.md).

`HEALTH_INGEST_TOKEN` is the credential for every route. The import routes, `/ingest/hc-webhook`, `/ingest/shortcuts`, `/summary`, and `/mcp` accept any client that sends that bearer token. There is no user account, network allowlist, or second check. An empty token rejects every bearer request. Anyone who has the token can read and write the health data this endpoint stores.

`HEALTH_INGEST_URL_TOKEN` is a separate, optional, write-only secret. Leave it unset unless HC Webhook or an iOS Shortcut cannot send `Authorization`. It must be at least 32 characters and use only `A-Z`, `a-z`, `0-9`, `_`, and `-`. While it is unset, shorter, or contains any other character, `?token=` and `/ingest/hc-webhook/<token>` or `/ingest/shortcuts/<token>` are rejected. The server also treats it as unset when it is the same string as `HEALTH_INGEST_TOKEN`, including when one of them has surrounding spaces, and logs a warning that does not include the secret. When it is set and different, it authenticates only `POST` to those two routes. The path segment is matched raw, with no percent-decoding and no trimming, so a `%2D` in place of `-` or a trailing `%20` does not authenticate. The query form accepts only the literal key `token`; `%74oken` does not. `GET`, `PUT`, and `DELETE` of those paths are rejected, and so are `/summary`, `/mcp`, and the import routes. Sending the URL secret as `Authorization: Bearer` does not authenticate. On `POST /ingest/shortcuts`, rows sent with the URL token never replace a stored day: they can create a metric-day that has no data and update days that earlier URL-token requests created, but they cannot lower or correct a day written with `HEALTH_INGEST_TOKEN`, HC Webhook, or an import. Workouts sent with the URL token are insert-only. A Shortcuts send with the Bearer `HEALTH_INGEST_TOKEN`, by contrast, overwrites the metric-days it contains even when something else wrote them. Generate it with a second `openssl rand -hex 32`. Do not copy `HEALTH_INGEST_TOKEN` into it.

Prefer the `Authorization` header. If the app cannot send one, put `HEALTH_INGEST_URL_TOKEN` in the path (`/ingest/hc-webhook/<token>`) rather than in `?token=`. A query string is more often copied into the `Referer` header, browser history, and analytics than a path segment. Both forms are still exposed. A token in a URL is copied into browser history, app history, screenshots, shared QR codes, the `Referer` header when the client requests another URL, reverse-proxy logs, and platform logs. Node redacts the query value and the path segment from this process's own error log, after decoding percent-encoded keys such as `%74oken`. That redaction does not apply to Cloudflare. Workers request logs, Workers Logs, Logpush, and Tail record the full URL, and nothing in the Worker can rewrite those. Do not enable the URL token on a public `workers.dev` hostname if those logs are on. Rotate `HEALTH_INGEST_URL_TOKEN` on its own when a URL may have been exposed. Header clients keep working across that rotation.

Use at least 32 random bytes. This prints 32 bytes as hex:

```bash
openssl rand -hex 32
```

Put that value in `HEALTH_INGEST_TOKEN` (a Worker secret, or the process environment for Node and Docker). Do not commit it.

Prefer the `HEALTH_INGEST_TOKEN` environment variable over the CLI `--token` flag. The import command reads the environment variable when `--token` is omitted. A value passed as `--token` is visible to other users on the machine, in the process list and often in shell history.

To rotate the token, generate a new value with `openssl rand -hex 32` and replace `HEALTH_INGEST_TOKEN`. On Cloudflare, run `npx wrangler secret put HEALTH_INGEST_TOKEN`. On Node or Docker, update the environment and restart the process. Then update every client that sends `Authorization: Bearer …` (automations, shortcuts, and MCP clients). The previous token stops working as soon as the running server is using the new value. There is no overlap between the two.

`workers_dev = true` in [`wrangler.example.toml`](../wrangler.example.toml) exposes a public `workers.dev` URL. Anyone who learns that hostname and has the token can call the API. Set `workers_dev = false` in your local `wrangler.toml` when the Worker should not be reachable on `workers.dev`.

Requests without an `Origin` header are allowed. Native clients call `/mcp` that way. A request that sends `Origin` is rejected with `403` unless that origin is listed in `MCP_ALLOWED_ORIGINS`.

`HEALTH_STORE_RAW` defaults to off, so nothing is written to `raw_payloads` unless you set it to `true`, `1`, `yes`, or `on`. When it is on, the row is the post-filter document of stored points and workouts, not the original request. Removed ingest paths return 410 and logs redact the token segment after `/ingest/<name>/`.

### Browser-based MCP clients get `403`

A client that sends an `Origin` header (usually one running in a browser) gets `403` `{ "error": "forbidden_origin" }` until that origin is listed in `MCP_ALLOWED_ORIGINS`. Set it to a comma-separated list such as `https://example.com`. On Cloudflare, put it under `[vars]` in `wrangler.toml` and run `npx wrangler deploy` again. On Node or Docker, set it in the environment and restart.
