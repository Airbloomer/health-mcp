import { LATEST_METRICS, MAX_RAW_BYTES, SUM_METRICS } from "./metrics.js";

/** Metrics that affect GET /summary. Everything else is dropped unless allowlisted. */
export function summaryMetricNames() {
  return [...Object.keys(SUM_METRICS), ...Object.keys(LATEST_METRICS)];
}

export function parseAllowlist(value) {
  if (value == null || value === false) return [];
  const list = Array.isArray(value) ? value : String(value).split(",");
  return list.map((name) => String(name).trim().toLowerCase()).filter(Boolean);
}

/** Summary metrics, plus any extra names from `HEALTH_METRIC_ALLOWLIST`. */
export function storedMetricSet(allowlist) {
  return new Set([...summaryMetricNames(), ...parseAllowlist(allowlist)]);
}

/** Raw request bodies are stored only when the flag is explicitly enabled. */
export function rawStorageEnabled(value) {
  if (typeof value === "boolean") return value;
  if (value == null || String(value).trim() === "") return false;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

/** Byte length of a string in UTF-8, which is what SQLite and D1 store. */
export function utf8Bytes(text) {
  return new TextEncoder().encode(text ?? "").length;
}

/**
 * Whether this batch should insert a raw_payloads row.
 * Storage is optional, and a body over about 1.5MB is skipped so the row
 * stays under D1's 2MB limit. Metrics in that body are still ingested.
 */
export function shouldStoreRaw(batch) {
  if (!rawStorageEnabled(batch?.storeRaw) || batch?.payload == null) return false;
  return utf8Bytes(batch.payload) <= MAX_RAW_BYTES;
}

/**
 * One row per (metric, date) for this payload.
 *
 * Duplicate (metric, ts) pairs keep the last sample in payload order, which
 * matches the old per-sample primary key. `sum_qty` adds the remaining
 * samples. `last_qty` / `last_ts` are the latest timestamp. `n` is the
 * number of samples after that collapse.
 *
 * Storage replaces an existing (metric, date) row only when this row's `n`
 * is at least the stored `n`. A shorter re-send leaves the fuller day in
 * place. Sending the same whole day again (`n` unchanged) keeps the same
 * totals, and storage skips the write when those values already match.
 */
export function aggregateDays(points, allow = storedMetricSet()) {
  const byTimestamp = new Map();
  for (const point of points || []) {
    if (allow && !allow.has(point.metric)) continue;
    byTimestamp.set(`${point.metric}\0${point.ts}`, point);
  }

  const groups = new Map();
  for (const point of byTimestamp.values()) {
    const key = `${point.metric}\0${point.date}`;
    let group = groups.get(key);
    if (!group) {
      group = { metric: point.metric, date: point.date, samples: [] };
      groups.set(key, group);
    }
    group.samples.push(point);
  }

  const rows = [];
  for (const group of groups.values()) {
    let sum = 0;
    let last = group.samples[0];
    for (const sample of group.samples) {
      sum += sample.qty;
      if (String(sample.ts) >= String(last.ts)) last = sample;
    }
    rows.push({
      metric: group.metric,
      date: group.date,
      sum_qty: sum,
      last_qty: last.qty,
      last_ts: String(last.ts),
      units: last.units ?? null,
      n: group.samples.length,
    });
  }

  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.metric < b.metric ? -1 : a.metric > b.metric ? 1 : 0));
  return rows;
}
