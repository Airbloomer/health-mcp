# iPhone: the Shortcuts app

Shortcuts is the only live iPhone path. The Shortcuts app that comes with iPhone (Apple Shortcuts) reads Health with the **Find Health Samples** action and sends the samples to `POST /ingest/shortcuts` with **Get Contents of URL**. A personal automation runs it once a day.

> **Status: unverified on a real iPhone.** The server side (format, auth, validation) is covered by `test/shortcuts.test.mjs`. The steps below use documented actions in the Shortcuts app, but the exact menu wording, the output of Format Date, and the limits have not been checked on a device. Steps marked *(unverified)* are the most likely to differ. Please report what you see.

## Two modes

- **Daily totals (default, recommended).** The Shortcut asks Health for one value per metric per day with the **Group By** option of **Find Health Samples** set to **Day**. Health is expected to combine iPhone and Apple Watch samples into one de-duplicated daily sum *(unverified on a real iPhone; please check the number against the Health app)*. Each entry is sent with `"kind": "daily"` and is stored as that day's total.
- **Raw samples.** The Shortcut sends individual samples. Use this only if Group By Day does not work for you. A **Source** filter step is required (see below), and the server also keeps one source per metric per day as a backstop.

Either way, a request sent with the `Authorization: Bearer` header **replaces** the stored day for every metric-day it contains. Re-sending the same day gives the same result, and a later value wins even if it is lower. Sample counts are not compared. Requests authenticated with the URL token do not replace (see Auth).

**One ingest path per metric.** A Bearer daily total is meant to be the complete day, because Health already merges every source. It therefore replaces that metric-day **whatever wrote it** (an HC Webhook sync, an Apple Health import, or an earlier Shortcut run). This is intended. If another source also sends steps, the last writer wins for that day, so send each metric through only one path. So a Shortcut must only send days it has complete data for, or today's running total (see the date window step below).

## Request format

Daily mode:

```json
{
  "samples": [
    { "kind": "daily", "type": "Steps", "value": "8123", "unit": "count", "date": "2026-10-14" },
    { "kind": "daily", "type": "Active Energy", "value": "512", "unit": "kcal", "date": "2026-10-14" },
    { "kind": "daily", "type": "Weight", "value": "72.5", "unit": "kg", "date": "2026-10-14" }
  ]
}
```

Raw mode:

```json
{
  "samples": [
    { "type": "Steps", "value": "4000", "unit": "count", "source": "Example Apple Watch", "start": "2026-10-14T09:00:00-07:00", "end": "2026-10-14T09:30:00-07:00" }
  ],
  "workouts": [
    { "type": "Running", "start": "2026-10-14T17:30:00-07:00", "end": "2026-10-14T18:15:00-07:00", "energy": "310", "energyUnit": "kcal" }
  ]
}
```

The body is an object with a `samples` array, a `workouts` array, or both. Daily and raw entries may be mixed in one request, but not for the same metric and day: a daily total and raw samples for the same metric-day are rejected with `400` and a locator on the second of them (`"field":"kind"`).

**Sample fields**

| Field | Required | Notes |
| --- | --- | --- |
| `kind` | no | `"daily"` for a day total, or `"sample"` (default) for a raw sample. Two `daily` entries for the same metric and day are rejected. |
| `type` | yes | Health name or stored name, case-insensitive; spaces and hyphens become `_`. Mapped: `Steps`, `Active Energy`, `Resting Energy` (also `Basal Energy`), `Weight` (also `Body Mass`), `Body Fat Percentage` (also `Body Fat`), `Dietary Energy`, `Protein`, `Carbohydrates`, `Total Fat`. Any other `[a-z0-9_]` name is accepted and stored only if `HEALTH_METRIC_ALLOWLIST` lists it; the response's `dropped` count tells you how many entries were not stored for that reason. |
| `value` | yes | A number, or a numeric string such as `"8123"`, `" 72.5 "`, or `"72,5"`. Grouped strings such as `"1,234"` or `"1 234"` are rejected because the separator is ambiguous. |
| `unit` | no | Energy: `kcal` (default), `Cal`, or `kJ`; stored as kcal. Weight: `kg` (default), `g`, `lb`, `lbs`, or `st`; stored as kg. Body fat: `%` (0 to 100). Protein, carbohydrates, fat: `g`. |
| `start` | yes | ISO 8601. `date` is accepted as an alias. For a daily entry, a date alone is enough. |
| `end` | no | ISO 8601, not before `start`. |
| `source` | no | Raw mode: the sample's source name, used to pick one source per metric-day. Raw samples **without** `source` are all treated as one source and summed, so iPhone and Apple Watch samples for the same minutes may be counted twice. The Source filter step in raw mode is the fix. |

**Workout fields:** `start` (required), `type` (activity name, for example `Running`), `end` (not before `start`) and/or `duration` (seconds, up to two days), `energy` with optional `energyUnit` (`kcal` or `kJ`).

**Dates.** ISO 8601 only: `2026-10-14T09:00:00-07:00`, `2026-10-14T09:00:00-0700`, `2026-10-14T16:00:00Z`, `2026-10-14 09:00:00`, or `2026-10-14`. With an offset, the written calendar day is the stored day. With `Z`, the day comes from `HEALTH_TIMEZONE`. With no offset, the time is read in `HEALTH_TIMEZONE` (not the server's own zone), so set `HEALTH_TIMEZONE` to the phone's zone. A local time that does not exist because of a daylight-saving jump (for example `2026-03-08T02:30:00` in `America/Los_Angeles`) is rejected with `400`. Locale text such as `Oct 14, 2026 at 9:00 AM` or `14/10/2026` is rejected. In the Shortcuts app, use **Format Date** with **Date Format** set to **ISO 8601**.

**Midnight.** A sample that crosses midnight (for example 23:50 to 00:10) counts entirely on its **start** day. Daily mode avoids this as far as Health's grouping does.

**Raw-mode source rule.** For each metric and day, samples are grouped by `source`. The first entry of `HEALTH_SHORTCUTS_SOURCE_PRIORITY` (comma-separated, case-insensitive, matched as part of the source name) that matches a source wins. The default is `watch,iphone`, so a source whose name contains "watch" wins over one containing "iphone". If nothing matches, the source with the largest total wins (the newest reading for weight and body fat). Only the winning source's samples are summed. This is a backstop for overlap; it is not a substitute for the Source filter.

**Errors.** One bad entry rejects the whole request with `400`, for example `{"error":"invalid_payload","at":"samples[12]","field":"start"}`. `at` is the position and `field` the field name. The value you sent is never echoed back. Common causes: a date not in ISO 8601, a value with a thousands separator, an unknown unit, or an `end` before `start`.

Send one local day per request. After missed days, catch-up loops oldest first, one request per day, and stops at the first non-2xx. The next run resumes from that day. A 7-day body can exceed the free profile's stored-row cap and return `413` with `retry` set to `split`.

**Response.** `{"ok":true,"id":"...","dates":[...],"points":N,"workouts":N,"dropped":N}`. `points` counts stored entries; `dropped` counts entries whose metric is not in the allowlist. A workout whose start cannot be parsed is omitted and counted in `dropped_workouts`. An empty valid body returns `200` with zero counts and does not write a row.

**Limits.** Same as the other adapters: steps 0 to 1,000,000 per entry, energy 0 to 100,000 kcal, weight 0.5 to 500 kg, body fat 0 to 100 %, dates from 2000-01-01 to two days after the server's today, at most 100,000 entries per request.

## Auth

Recommended: the header `Authorization: Bearer <HEALTH_INGEST_TOKEN>` on `https://<your-host>/ingest/shortcuts`. **Get Contents of URL** can set headers, so this works in the Shortcuts app.

> **The Bearer header is required for exact daily totals.** Only a request with the header replaces a stored day. A request authenticated with the URL token can add a day that has no data yet, and can update a day that earlier URL-token requests wrote, but it **cannot correct or lower** a day written any other way (with the header, by another app, or by an import). Workouts sent with the URL token are insert-only: a new workout is added, but an existing one (same type and start) is never changed. This keeps a leaked URL token from overwriting your data.

Secondary, only if you prefer not to use a header: the write-only `HEALTH_INGEST_URL_TOKEN` in the path, `https://<your-host>/ingest/shortcuts/<HEALTH_INGEST_URL_TOKEN>`, with no `Authorization` header. A `?token=<HEALTH_INGEST_URL_TOKEN>` query also works, but prefer the path, and prefer the header over both. The same rules as HC Webhook apply: the value must match `^[A-Za-z0-9_-]{32,}$`, must differ from `HEALTH_INGEST_TOKEN`, only authenticates `POST` to `/ingest/hc-webhook` and `/ingest/shortcuts`, and is off when unset. A token in a URL can leak through logs and screenshots; see [Security](security.md). A shortcut you share includes its URL and headers, so never share yours.

## Test with curl first

Before building the Shortcut, check the server with synthetic data. Replace the host and date (use yesterday or today; dates more than two days ahead are rejected).

```sh
curl -sS -X POST "https://<your-host>/ingest/shortcuts" \
  -H "Authorization: Bearer $HEALTH_INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"samples":[
        {"kind":"daily","type":"Steps","value":"1234","unit":"count","date":"2026-10-15"},
        {"kind":"daily","type":"Active Energy","value":"210,5","unit":"kcal","date":"2026-10-15"},
        {"kind":"daily","type":"Weight","value":"70.0","unit":"kg","date":"2026-10-15"}],
       "workouts":[{"type":"Walking","start":"2026-10-15T12:00:00","duration":"1800"}]}'

curl -sS "https://<your-host>/summary?date=2026-10-15" -H "Authorization: Bearer $HEALTH_INGEST_TOKEN"
```

Expect `{"ok":true,...,"points":3,"workouts":1,"dropped":0}` and a summary with `steps: 1234`. Because the day is replaced, the next real run for that day overwrites these synthetic values. Workouts are not replaced, so use a test server or a past date if you do not want the synthetic walk to stay.

## Build the Shortcut (daily mode)

Open the Shortcuts app, tap **+** to make a new shortcut, and name it, for example `Health to server`.

### 1. Date window

1. Add **Date**, set to **Current Date**.
2. Add **Adjust Date**: **Subtract** **1** **days** from the Date.
3. Add **Adjust Date** again on that result with **Get Start of Day** *(unverified option name)*. Rename the result `Window Start`.

This sends yesterday (complete) and today (a running total that the next run replaces). Do not use a rolling "in the last 2 days" filter: its oldest day would be partial and would overwrite a complete stored day.

### 2. One block per metric

1. Add **Find Health Samples**. Type **Steps**. Filter: **Start Date** *is after* `Window Start` *(unverified wording)*. Set **Group By** to **Day** *(unverified; this is what makes the value a daily total)*. Leave **Limit** off.
2. Add **Repeat with Each** with the Health Samples from step 1 as input.
3. Inside the repeat:
   1. **Format Date**: input **Repeat Item › Start Date**, **Date Format** **ISO 8601**.
   2. **Dictionary** with Text keys: `kind` = `daily`, `type` = `Steps`, `value` = **Repeat Item › Value**, `unit` = **Repeat Item › Unit**, `date` = the Formatted Date. (In the variable picker, tap the magic variable and choose the property.)
   3. **Add to Variable**: variable name `Samples`.
4. Repeat steps 1 to 3 for each metric you store: **Active Energy**, **Resting Energy**, **Dietary Energy**, **Protein**, **Carbohydrates**, **Total Fat**, **Weight**, **Body Fat Percentage**. Change only the type in Find Health Samples and the `type` text in the Dictionary. Add every block to the same `Samples` variable. For weight and body fat, Group By Day may give the day's average rather than the last reading *(unverified)*.

### 3. Workouts (optional)

1. **Find Health Samples** with type **Workouts** *(unverified)*, filter **Start Date** *is after* `Window Start`, no grouping.
2. **Repeat with Each**, then **Format Date** (ISO 8601) for **Start Date** and **End Date**, and a **Dictionary** with `type` = **Repeat Item › Type** *(unverified property name)*, `start`, `end`, `energy` = the active energy property if offered *(unverified)*, `energyUnit` = `kcal`.
3. **Add to Variable**: `Workouts`.

### 4. Upload

1. **Combine Text**: input the variable `Samples`, separator **Custom**, and type `,` *(unverified that each Dictionary becomes JSON text here)*.
2. **Text**: type `{"samples":[`, insert the **Combined Text** variable, then type `]}`. With workouts, add a second Combine Text for `Workouts` and write `{"samples":[` *Combined Text* `],"workouts":[` *Combined Text 2* `]}`.
3. **Get Contents of URL**:
   - URL: `https://<your-host>/ingest/shortcuts`
   - Tap **Show More**. **Method** `POST`.
   - **Headers**: `Authorization` = `Bearer <HEALTH_INGEST_TOKEN>` and `Content-Type` = `application/json`.
   - **Request Body**: **File**, and pick the Text from step 2 *(unverified that File sends the text unchanged; the server does not check `Content-Type`)*.
4. Optional: **Show Result** at the end while testing, to see `{"ok":true,...}` or the error locator.

Run the shortcut once by hand with the phone unlocked. Allow Health access for each type when asked. Then call `GET /summary?date=YYYY-MM-DD` for today and yesterday and compare steps with the Health app. If they match, daily mode works on your phone.

If you get `invalid_payload`, read `at` and `field` in the response. Temporarily replace Get Contents of URL with **Quick Look** on the Text to see what would be sent.

## Raw mode (fallback)

Use this only if Group By Day is not available or gives wrong totals.

1. Build each metric block as above, but leave **Group By** off, and **add a Source filter: Source** *is* your watch (or your phone) *(required; unverified wording)*. Without it, iPhone and Apple Watch samples for the same minutes are both sent.
2. In the Dictionary, leave out `kind`, use `start` and `end` (both formatted as ISO 8601) instead of `date`, and add `source` = **Repeat Item › Source** *(unverified property name)*.
3. Upload the same way.

The server keeps one source per metric and day (see the source rule above). Set `HEALTH_SHORTCUTS_SOURCE_PRIORITY` to change the order, for example `iphone,watch`. Raw mode sends many more entries than daily mode and is slower.

## Daily automation

1. In the Shortcuts app, open the **Automation** tab and tap **+** (or **New Automation**).
2. Choose **Time of Day**. Pick a time when the phone is usually unlocked and in use, for example 21:00, and **Daily**.
3. Turn off **Ask Before Running**. On iOS 17 and later this is shown as choosing **Run Immediately** instead of **Run After Confirmation** *(unverified on each iOS version)*. Optionally turn off **Notify When Run**.
4. Pick the shortcut `Health to server`.

Each run sends yesterday in full and today so far. If a run is missed, the day before yesterday keeps whatever was last sent for it.

## Known limits

- **The phone must be unlocked.** iOS protects Health data while the device is locked. An automation that fires while locked cannot read samples (or may fail); it does not retry later. Choose a time you normally use the phone.
- **Per-run sample limit.** Find Health Samples, Repeat, and building text for many samples is slow and can hit a limit in the Shortcuts app or time out *(the exact limit is unverified)*. Daily mode keeps this small. For a long backfill, use [Export from Apple Health](sources.md) instead.
- **Schedule only.** A shortcut runs when you run it or when the automation fires. It does not sync in the background.
- **Replace semantics.** Each run replaces the metric-days it sends. A run that sends an incomplete past day overwrites a complete one, which is why the window starts at the start of yesterday.
- **Units.** The units the Shortcuts app reports depend on the phone's Health settings. Unknown units are rejected, never guessed.

## Disclaimer

health-mcp is an independent open-source project by Airbloomer, LLC. It is not affiliated with, endorsed by, or sponsored by Apple Inc. or Google LLC. Apple, iPhone, Apple Watch, Apple Health, HealthKit and Shortcuts are trademarks of Apple Inc., registered in the U.S. and other countries. Google, Android and Health Connect are trademarks of Google LLC. They are used here only to describe compatibility.

health-mcp is not a medical device and does not provide medical advice, diagnosis or treatment. Talk to a qualified professional about any health decision.

health-mcp is self-hosted software. You run it and you control your data, and you are responsible for securing your server. Airbloomer, LLC does not host, receive or access your health data.

Any third-party apps mentioned in this project's docs are owned by their respective owners and are not affiliated with or endorsed by Airbloomer, LLC. Use them under their own terms and privacy policies.

Provided under the license in LICENSE, "as is", without warranty of any kind.
