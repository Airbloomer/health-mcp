# iPhone: Apple Shortcuts

A free iPhone option with no extra app. Apple's built-in **Shortcuts** app reads Health with the **Find Health Samples** action and sends the samples to `POST /ingest/shortcuts` with **Get Contents of URL**. A personal automation runs it once a day.

> **Status: unverified on a real iPhone.** The server side (format, auth, validation) is covered by `test/shortcuts.test.mjs`. The Shortcut steps below use documented Shortcuts actions, but the exact menu wording, the output of Format Date, and the limits have not been checked on a device. Steps marked *(unverified)* are the most likely to differ. Please report what you see.

## Request format

```json
{
  "samples": [
    { "type": "Steps", "value": "4000", "unit": "count", "start": "2026-10-14T09:00:00-07:00", "end": "2026-10-14T09:30:00-07:00" },
    { "type": "Active Energy", "value": "512", "unit": "kcal", "start": "2026-10-14T10:00:00-07:00" },
    { "type": "Weight", "value": "72.5", "unit": "kg", "start": "2026-10-14T07:00:00-07:00" }
  ],
  "workouts": [
    { "type": "Running", "start": "2026-10-14T17:30:00-07:00", "end": "2026-10-14T18:15:00-07:00", "energy": "310", "energyUnit": "kcal" }
  ]
}
```

The body is an object with a `samples` array, a `workouts` array, or both.

**Sample fields**

| Field | Required | Notes |
| --- | --- | --- |
| `type` | yes | Health name or stored name, case-insensitive; spaces and hyphens become `_`. Mapped: `Steps`, `Active Energy`, `Resting Energy` (also `Basal Energy`), `Weight` (also `Body Mass`), `Body Fat Percentage` (also `Body Fat`), `Dietary Energy`, `Protein`, `Carbohydrates`, `Total Fat`. Any other `[a-z0-9_]` name is accepted and stored only if `HEALTH_METRIC_ALLOWLIST` lists it. |
| `value` | yes | A number, or a numeric string such as `"8123"`, `" 72.5 "`, or `"72,5"`. Grouped strings such as `"1,234"` or `"1 234"` are rejected because the separator is ambiguous. |
| `unit` | no | Energy: `kcal` (default), `Cal`, or `kJ`; stored as kcal. Weight: `kg` (default), `g`, `lb`, `lbs`, or `st`; stored as kg. Body fat: `%` (0 to 100). Protein, carbohydrates, fat: `g`. |
| `start` | yes | ISO 8601. `date` is accepted as an alias. |
| `end` | no | ISO 8601. Two samples with the same start but different ends are both kept. |

**Workout fields:** `start` (required), `type` (activity name, for example `Running`), `end` and/or `duration` (seconds, up to two days), `energy` with optional `energyUnit` (`kcal` or `kJ`).

**Dates.** ISO 8601 only: `2026-10-14T09:00:00-07:00`, `2026-10-14T09:00:00-0700`, `2026-10-14T16:00:00Z`, `2026-10-14 09:00:00`, or `2026-10-14`. With an offset, the written calendar day is the stored day. With `Z`, the day comes from `HEALTH_TIMEZONE`. With no offset, the written day is used as is. Locale text such as `Oct 14, 2026 at 9:00 AM` or `14/10/2026` is rejected. In Shortcuts, use **Format Date** with **Date Format** set to **ISO 8601** (see below).

**Validation.** One bad entry rejects the whole request with `400 { "error": "invalid_payload" }`, so a formatting mistake is visible instead of storing part of a day. Limits match the other adapters: steps 0 to 1,000,000 per sample, energy 0 to 100,000 kcal, weight 0.5 to 500 kg, body fat 0 to 100 %, dates from 2000-01-01 to two days after the server's today. At most 100,000 entries per request.

**Storage.** Samples collapse into one row per metric per day, like the other adapters. Steps and energy are summed, weight and body fat keep the latest reading. Re-sending the same whole day does not double it. A request with fewer samples for a day than are already stored does not replace that day.

## Auth

Either:

- Header `Authorization: Bearer <HEALTH_INGEST_TOKEN>` on `https://<your-host>/ingest/shortcuts` (preferred), or
- the write-only `HEALTH_INGEST_URL_TOKEN` in the path, `https://<your-host>/ingest/shortcuts/<HEALTH_INGEST_URL_TOKEN>`, with no `Authorization` header. Same rules as HC Webhook and Life Dashboard Companion: it must match `^[A-Za-z0-9_-]{32,}$`, must differ from `HEALTH_INGEST_TOKEN`, only authenticates `POST` to these ingest routes, and is off when unset. A URL token can leak through logs and screenshots; see [Security](security.md). A shared Shortcut includes its URL and headers, so never share yours.

## Test with curl first

Before building the Shortcut, check the server with synthetic data. Replace the host, token, and date (use yesterday or today; dates more than two days ahead are rejected).

```sh
curl -sS -X POST "https://<your-host>/ingest/shortcuts" \
  -H "Authorization: Bearer $HEALTH_INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"samples":[
        {"type":"Steps","value":"1234","unit":"count","start":"2026-10-15T09:00:00-07:00"},
        {"type":"Active Energy","value":"210,5","unit":"kcal","start":"2026-10-15T09:00:00-07:00"},
        {"type":"Weight","value":"70.0","unit":"kg","start":"2026-10-15T07:00:00-07:00"}],
       "workouts":[{"type":"Walking","start":"2026-10-15T12:00:00-07:00","duration":"1800"}]}'

curl -sS "https://<your-host>/summary?date=2026-10-15" -H "Authorization: Bearer $HEALTH_INGEST_TOKEN"
```

Expect `{"ok":true,...}` and a summary with `steps: 1234`. This writes synthetic values into that day; send real data for the day afterwards, or use a test server.

## Build the Shortcut

Open **Shortcuts**, tap **+** to make a new shortcut, and name it, for example `Health to server`. Build one block per metric (steps shown), then the upload.

### 1. One block per metric

1. Add **Find Health Samples**. Set the type to **Steps**. Add a filter **Start Date** *is in the last* **2** **days** *(unverified wording)*. Leave **Limit** off, or set it high (see limits).
2. Add **Repeat with Each** with the Health Samples from step 1 as input.
3. Inside the repeat:
   1. **Format Date**: input **Repeat Item › Start Date**, **Date Format** **ISO 8601**, and turn on **Include ISO 8601 Time** if shown *(unverified)*.
   2. **Format Date** again for **Repeat Item › End Date**.
   3. **Dictionary** with Text keys: `type` = `Steps`, `value` = **Repeat Item › Value**, `unit` = **Repeat Item › Unit**, `start` = first Formatted Date, `end` = second Formatted Date. (In the variable picker, tap the magic variable and choose the property.)
   4. **Add to Variable**: variable name `Samples`.
4. Repeat steps 1 to 3 for each metric you store: **Active Energy**, **Resting Energy**, **Weight**, **Body Fat Percentage**, **Dietary Energy**, **Protein**, **Carbohydrates**, **Total Fat**. Change only the type in Find Health Samples and the `type` text in the Dictionary. Add every block to the same `Samples` variable.

### 2. Workouts (optional)

1. **Find Health Samples** with type **Workouts** *(unverified)* and the same date filter.
2. **Repeat with Each**, then format **Start Date** and **End Date** as above, and build a **Dictionary** with `type` = **Repeat Item › Type** *(unverified property name)*, `start`, `end`, `energy` = the active energy property if offered *(unverified)*, `energyUnit` = `kcal`.
3. **Add to Variable**: `Workouts`.

### 3. Upload

1. **Combine Text**: input the variable `Samples`, separator **Custom**, and type `,` *(unverified that each Dictionary becomes JSON text here)*.
2. **Text**: type `{"samples":[`, insert the **Combined Text** variable, then type `]}`. With workouts, add a second Combine Text for `Workouts` and write `{"samples":[` *Combined Text* `],"workouts":[` *Combined Text 2* `]}`.
3. **Get Contents of URL**:
   - URL: `https://<your-host>/ingest/shortcuts`
   - Tap **Show More**. **Method** `POST`.
   - **Headers**: `Authorization` = `Bearer <HEALTH_INGEST_TOKEN>` and `Content-Type` = `application/json`.
   - **Request Body**: **File**, and pick the Text from step 2 *(unverified that File sends the text unchanged; the server does not check `Content-Type`)*.
   - URL-token alternative: URL `https://<your-host>/ingest/shortcuts/<HEALTH_INGEST_URL_TOKEN>` and no `Authorization` header.
4. Optional: **Show Result** at the end while testing, to see `{"ok":true,...}` or the error.

Run the shortcut once by hand with the phone unlocked. Allow Health access for each type when asked. Then call `GET /summary?date=YYYY-MM-DD` for today and yesterday.

If you get `invalid_payload`, the usual causes are a date not formatted as ISO 8601, a value with a thousands separator, or a unit the server does not know. Temporarily replace Get Contents of URL with **Quick Look** on the Text to see what would be sent.

## Daily automation

1. In Shortcuts, open the **Automation** tab and tap **+** (or **New Automation**).
2. Choose **Time of Day**. Pick a time when the phone is usually unlocked and in use, for example 21:00, and **Daily**.
3. Turn off **Ask Before Running**. On iOS 17 and later this is shown as choosing **Run Immediately** instead of **Run After Confirmation** *(unverified on each iOS version)*. Optionally turn off **Notify When Run**.
4. Pick the shortcut `Health to server`.

The 2-day window resends yesterday each night, so a day sent while still partial is completed by the next run.

## Known limits

- **The phone must be unlocked.** iOS protects Health data while the device is locked. An automation that fires while locked cannot read samples (or may fail); it does not retry later. Choose a time you normally use the phone.
- **Per-run sample limit.** Find Health Samples, Repeat, and building text for thousands of samples is slow and can hit a Shortcuts limit or time out *(the exact limit is unverified)*. Steps and energy produce many samples per day. Keep the window at 1 to 2 days and send only metrics you store. For a long backfill, use [Export from Apple Health](sources.md) instead.
- **Slower than the apps.** A Shortcut takes noticeably longer than Health Auto Export or SyncFit and only runs on schedule, not in the background.
- **Duplicate sources.** Find Health Samples may return iPhone and Apple Watch samples for the same period; summed metrics can then double-count *(unverified whether Health de-duplicates here)*. If totals look high, add a filter on **Source** to one device.
- **Units.** The units Shortcuts reports depend on the phone's Health settings. Unknown units are rejected, never guessed.
