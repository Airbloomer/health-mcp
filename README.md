# health-mcp

![An AI assistant answering "How did I sleep and train this week?" with health-mcp tool calls (sample data)](https://raw.githubusercontent.com/Airbloomer/health-mcp/main/docs/hero.png)

*Self-hosted · read-only MCP · iPhone and Android*

Ask your AI chatbot about your own health data. health-mcp takes the steps, calories, weight, body fat, workouts and nutrition your phone already collects (iPhone or Android) and makes them available to any AI chatbot that supports MCP connectors. Sleep can be added as an option on Android. It runs on a small server that you own, so your data stays with you.

Not medical advice. See [Disclaimer](#disclaimer).

## How it works

- **Your phone app sends your data.** An export app on your phone (HC Webhook or Life Dashboard Companion on Android, Health Auto Export on iPhone) posts your health data to your server.
- **Your server keeps it.** health-mcp stores one row per metric per day in a database that you control.
- **Your chatbot connects.** You add your server to your chatbot as an MCP connector. It can read your data, but never change it.

## Quick start

> **What you need**
>
> - A computer with a terminal
> - [Node.js](https://nodejs.org) 22 or newer
> - A free [Cloudflare](https://www.cloudflare.com) account
> - The phone app: HC Webhook or Life Dashboard Companion (Android), or Health Auto Export (iPhone)
> - A chatbot that supports MCP connectors
> - About 15 minutes

The terminal is the app where you type commands: **Terminal** on Mac, **PowerShell** on Windows. Keep it open for every step below.

### 1. Deploy your server

The simplest option is Cloudflare Workers with a D1 database. Copy and paste these commands one at a time:

```bash
git clone https://github.com/Airbloomer/health-mcp.git
cd health-mcp
npm install
cp wrangler.example.toml wrangler.toml
npx wrangler login
npx wrangler d1 create health-mcp
```

The last command prints a `database_id`. Open `wrangler.toml` in a text editor and paste that value in place of `replace-with-d1-database-id`. While you are there, change `HEALTH_TIMEZONE` to your own time zone, for example `Europe/Rome`.

Optional, Android only: sleep is not stored by default. To keep sleep duration from HC Webhook or Life Dashboard Companion, add `HEALTH_METRIC_ALLOWLIST = "sleep_analysis"` under `[vars]` in `wrangler.toml`.

Then create the database tables. Do this **before** you deploy:

```bash
npx wrangler d1 migrations apply health-mcp --remote
```

✅ **Checkpoint:** the command lists `0001_init.sql` and `0002_daily_points.sql` as applied, with no error.

Prefer your own machine, a VPS, or Docker? See [Self-hosting](https://github.com/Airbloomer/health-mcp/blob/main/docs/self-hosting.md) for the Node.js and Docker options (SQLite or Postgres).

### 2. Create your token

The token is the password for your server. Generate a random one:

```bash
openssl rand -hex 32
```

Copy the line it prints. That is your **`<HEALTH_INGEST_TOKEN>`**. Save it somewhere private, such as a password manager. Then store it on your server and deploy:

```bash
npx wrangler secret put HEALTH_INGEST_TOKEN
npx wrangler deploy
```

Paste the token when `secret put` asks for it. `wrangler deploy` prints your server's address, something like `https://health-mcp.<your-subdomain>.workers.dev`. Copy it. That address without `https://` is your **`<your-host>`**.

Anyone with this token can read and write your data. Never share it or post it in a screenshot. More in [Security](https://github.com/Airbloomer/health-mcp/blob/main/docs/security.md).

✅ **Checkpoint:** ask your server for a day's summary (on Windows, type `curl.exe` instead of `curl`):

```bash
curl -H "Authorization: Bearer <HEALTH_INGEST_TOKEN>" "https://<your-host>/summary?date=2026-01-01"
```

You should get back JSON that starts with `{"date":"2026-01-01"`, with empty values for now. `{"error":"unauthorized"}` means the token doesn't match.

### 3. Connect your phone

<details>
<summary><strong>Android: HC Webhook or Life Dashboard Companion</strong></summary>

Both apps read Health Connect, so anything Health Connect already collects (for example from a smart scale or a fitness band app) can be sent. Install one of them, grant it Health Connect read access, and add a webhook:

- **HC Webhook:** URL `https://<your-host>/ingest/hc-webhook`, format JSON.
- **Life Dashboard Companion:** on the **Health** tab, URL `https://<your-host>/ingest/life-dashboard`. Leave **Daily totals in payload** on.

Then add a header with key `Authorization` and value `Bearer <HEALTH_INGEST_TOKEN>` (the word `Bearer`, a space, then the token). Run a sync (in Life Dashboard Companion, tap **Test ping**, then **Sync Now**).

<details>
<summary>Can't add a header?</summary>

Some setups can't send a header, for example a URL added by QR pairing in Life Dashboard Companion. In that case, create a second, separate token and put it in the URL:

```bash
openssl rand -hex 32
npx wrangler secret put HEALTH_INGEST_URL_TOKEN
```

Then use the path form: `https://<your-host>/ingest/hc-webhook/<HEALTH_INGEST_URL_TOKEN>` (or `/ingest/life-dashboard/<HEALTH_INGEST_URL_TOKEN>`).

> **Security note:** this URL token can only send data, never read it. Still, a URL can end up in logs, history, screenshots and QR codes, and Cloudflare's request logs keep the full URL. Prefer the header when you can. Never put your main `HEALTH_INGEST_TOKEN` in a URL. If the URL may have leaked, run `npx wrangler secret put HEALTH_INGEST_URL_TOKEN` again with a new value. See [Security](https://github.com/Airbloomer/health-mcp/blob/main/docs/security.md).

</details>

Full setup for both apps: [Data sources](https://github.com/Airbloomer/health-mcp/blob/main/docs/sources.md#hc-webhook).

</details>

<details>
<summary><strong>iPhone: Health Auto Export</strong></summary>

In [Health Auto Export](https://help.healthyapps.dev/en/health-auto-export/automations/rest-api), open **Automations**, tap **New Automation**, choose **REST API**, and set:

- **URL:** `https://<your-host>/ingest`
- **Header:** key `Authorization`, value `Bearer <HEALTH_INGEST_TOKEN>` (the word `Bearer`, a space, then the token)
- **Export format:** JSON. **Export version:** Version 2
- **Data type:** Health Metrics

Create a second automation the same way, with data type **Workouts**. Tap **Manual Export** to send your first data. Automations only run while the phone is unlocked. Full details: [Data sources](https://github.com/Airbloomer/health-mcp/blob/main/docs/sources.md#health-auto-export).

</details>

✅ **Checkpoint:** run the same `curl` command from step 2 with yesterday's date (`YYYY-MM-DD`). You should now see numbers, such as `"steps"`, instead of empty values.

### 4. Connect your chatbot

Every chatbot that supports remote MCP servers needs the same two things:

- **Server URL:** `https://<your-host>/mcp`
- **Authorization header:** `Bearer <HEALTH_INGEST_TOKEN>`

Your server must be reachable on the public internet (the `workers.dev` address is).

<details>
<summary><strong>Claude</strong> (web and desktop)</summary>

Go to **Customize > Connectors**, click **Add**, then add a custom connector. Enter a name and the server URL, choose **No sign in**, and under **Request headers** add `Authorization` with the value `Bearer <HEALTH_INGEST_TOKEN>`. Request headers are a beta feature; see [Claude's help article](https://support.claude.com/en/articles/11176164-use-connectors-to-extend-claude-s-capabilities). On Team and Enterprise plans, an owner adds the connector first.

</details>

<details>
<summary><strong>ChatGPT</strong></summary>

Not supported yet: ChatGPT custom connectors need OAuth; health-mcp uses a bearer token. OpenAI's [custom MCP server documentation](https://developers.openai.com/api/docs/guides/custom-mcp-server) lists OAuth or no authentication as the only options.

</details>

<details>
<summary><strong>Cursor and other clients</strong></summary>

Add a remote MCP server with the URL and header above. A Cursor `mcp.json` example is in the [API reference](https://github.com/Airbloomer/health-mcp/blob/main/docs/api.md#cursor).

</details>

✅ **Checkpoint:** the connector shows four tools: `get_daily_summary`, `get_metric`, `list_metrics`, and `list_workouts`.

### 5. Try it

Start a new chat with the connector turned on and ask:

- "How did I train this week?"
- "How many steps did I take yesterday?"
- "How did I sleep this week?" (Android, with sleep enabled)

Your data appears only after the phone app's first sync. The sleep question works only on Android, after you enable sleep with the optional `HEALTH_METRIC_ALLOWLIST` setting in step 1.

✅ **Checkpoint:** the chatbot calls a health-mcp tool and answers with your numbers.

## Troubleshooting

- **The chatbot or phone app says unauthorized (`401`).** Check that the header is exactly `Bearer`, one space, then the token. The URL token works only on the two Android webhook routes, never for `/mcp`.
- **Sending data fails right after deploying.** Run `npx wrangler d1 migrations apply health-mcp --remote`, then `npx wrangler deploy` again.
- **A day is missing or shows up on the wrong date.** Set `HEALTH_TIMEZONE` in `wrangler.toml` to your zone, then run `npx wrangler deploy` again.
- **Totals look too low.** Send whole days. A later sync with fewer samples for a day does not replace a fuller one. See [Data sources](https://github.com/Airbloomer/health-mcp/blob/main/docs/sources.md).
- **Nothing arrives from the iPhone.** Unlock the phone and tap **Manual Export**. Health Auto Export runs only while the phone is unlocked.

## More documentation

- [API reference](https://github.com/Airbloomer/health-mcp/blob/main/docs/api.md): routes, payload formats, limits, and MCP tools
- [Data sources](https://github.com/Airbloomer/health-mcp/blob/main/docs/sources.md): every supported exporter and full app setup
- [Self-hosting](https://github.com/Airbloomer/health-mcp/blob/main/docs/self-hosting.md): Cloudflare, Docker, Node, configuration, migrations, development
- [Security](https://github.com/Airbloomer/health-mcp/blob/main/docs/security.md): tokens, rotation, URL-token caveats, logs, and browser clients

## Disclaimer

Not affiliated with, endorsed or sponsored by Apple Inc. Apple, Apple Health and HealthKit are trademarks of Apple Inc. Health Auto Export, SyncFit, Health Export Pro, Google, Health Connect, HC Webhook and Life Dashboard Companion are trademarks of their respective owners and are mentioned only to describe compatibility; no endorsement is implied.

Not medical advice and not a medical device. This software is for personal informational use only and is not intended to diagnose, treat or prevent any condition. Consult a qualified professional for medical decisions.

Self-hosted: you run this software and you are responsible for securing your endpoint and your health data. Airbloomer, LLC does not host, receive or access any user data. Provided 'as is' under the MIT License, without warranty.

## Hosted version

We're exploring a hosted health-mcp for people who don't want to run their own server. It isn't available, and there's no commitment to launch it, or to any pricing or timing. To hear if it happens, email oss@airbloomer.com with the subject 'hosted waitlist'. Please don't include any health information in your email. We'll use your email address only to contact you about a hosted version, keep it no longer than 24 months, and delete it sooner if you ask (reply 'remove' at any time). Details: https://airbloomer.com/privacy. Nothing in this section changes the self-hosted software: Airbloomer, LLC still does not host, receive or access any of your health data.

## License

[MIT](https://github.com/Airbloomer/health-mcp/blob/main/LICENSE)
