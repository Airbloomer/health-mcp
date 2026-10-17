import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { aggregateDays, rawStorageEnabled, shouldStoreRaw, storedMetricSet } from "../src/core/aggregate.js";
import { authed } from "../src/core/auth.js";
import { handleRequest } from "../src/core/http.js";
import { MemoryStorage } from "../src/core/memory.js";
import { LATEST_METRICS, MAX_RAW_BYTES, SUM_METRICS, SUMMARY_FIELDS } from "../src/core/metrics.js";
import { localDate, parse } from "../src/core/parse.js";
import { summarizeDay } from "../src/core/summary.js";
import { expectedSummary, summaryDate } from "./expected.mjs";

const sample = JSON.parse(fs.readFileSync(new URL("./sample.json", import.meta.url), "utf8"));
const fixtureIngest = { ingestMaxAgeDays: 36500, ingestRatePerHour: 0, ingestMaxBodyBytes: 5_000_000 };

function request(pathname, { method = "GET", token = "tok", body } = {}) {
  const headers = new Headers();
  if (token) headers.set("authorization", /^bearer\s/i.test(token) ? token : `Bearer ${token}`);
  if (body != null) headers.set("content-type", "application/json");
  return new Request(`http://localhost${pathname}`, {
    method,
    headers,
    body: body == null ? undefined : body,
  });
}

test("localDate keeps an explicit offset and otherwise uses the timezone", () => {
  assert.equal(localDate("2026-10-14 23:30:00 -0700"), "2026-10-14");
  assert.equal(localDate("2026-10-14 23:30:00 -07:00"), "2026-10-14");
  assert.equal(localDate("2026-10-15T05:00:00Z", "America/Los_Angeles"), "2026-10-14");
  assert.equal(localDate("2026-10-15T05:00:00Z"), "2026-10-15");
  assert.equal(localDate(""), null);
});

test("parse metrics and workouts, converting kJ to kcal", () => {
  const parsed = parse(sample);
  assert.equal(parsed.points.length, 11);
  const active = parsed.points.find((point) => point.metric === "active_energy");
  assert.equal(Math.round(active.qty), 500);
  assert.equal(active.units, "kcal");
  assert.deepEqual(parsed.workouts[0], {
    name: "Traditional Strength Training",
    start: "2026-10-14 17:30:00 -0700",
    date: "2026-10-14",
    duration_min: 45,
    kcal: 310,
  });
});

test("parse derives workout duration and sums energy samples", () => {
  const parsed = parse({
    workouts: [
      {
        name: "Walk",
        start: "2026-10-14 12:00:00 -0700",
        end: "2026-10-14 12:30:00 -0700",
        activeEnergy: [{ qty: 100 }, { qty: 20.4 }],
      },
    ],
  });
  assert.deepEqual(parsed.workouts[0], {
    name: "Walk",
    start: "2026-10-14 12:00:00 -0700",
    date: "2026-10-14",
    duration_min: 30,
    kcal: 120,
  });
});

test("auth compares the bearer token and fails closed", () => {
  const env = { HEALTH_INGEST_TOKEN: "abc" };
  const call = (header, context = env) => authed(request("/ingest", { method: "POST", token: header }), context);
  assert.equal(call("Bearer abc"), true);
  assert.equal(call("bearer abc"), true);
  assert.equal(call("Bearer abd"), false);
  assert.equal(call(undefined, env), false);
  assert.equal(authed(request("/ingest", { method: "POST", token: "Bearer abc" }), {}), false);
  assert.equal(authed(request("/ingest", { method: "POST", token: "Bearer abc" }), { HEALTH_INGEST_TOKEN: "" }), false);
});

test("summarizeDay sums the day, keeps the latest weight, and scales fractional body fat", () => {
  const summary = summarizeDay("2026-10-14", [
    { metric: "step_count", ts: "2026-10-14 09:00:00", qty: "10.4", units: "count" },
    { metric: "weight_body_mass", ts: "2026-10-14 07:00:00", qty: 180, units: "lb" },
    { metric: "weight_body_mass", ts: "2026-10-14 21:00:00", qty: 179.4, units: "lb" },
    { metric: "body_fat_percentage", ts: "2026-10-14 07:00:00", qty: 0.184, units: "%" },
    { metric: "heart_rate", ts: "2026-10-14 08:00:00", qty: 60, units: "count/min" },
  ], [
    { name: "Later", start: "2026-10-14 18:00:00", duration_min: "10", kcal: "80" },
    { name: "Earlier", start: "2026-10-14 08:00:00", duration_min: 5, kcal: null },
  ]);
  assert.equal(summary.steps, 10);
  assert.deepEqual(summary.weight, { value: 179.4, units: "lb" });
  assert.equal(summary.body_fat_pct, 18.4);
  assert.deepEqual(summary.workouts.map((workout) => workout.name), ["Earlier", "Later"]);
  assert.equal(summary.workouts[0].kcal, null);
  assert.deepEqual(Object.keys(summary), SUMMARY_FIELDS);
});

test("daily rows summarize to the same object as the raw samples", () => {
  const parsed = parse(sample);
  const daily = aggregateDays(parsed.points);
  const fromSamples = summarizeDay(summaryDate, parsed.points, parsed.workouts);
  const fromDays = summarizeDay(summaryDate, daily, parsed.workouts);
  assert.deepEqual(fromDays, fromSamples);
  assert.deepEqual(fromDays, expectedSummary);
  assert.equal(daily.length, Object.keys(SUM_METRICS).length + Object.keys(LATEST_METRICS).length);
  assert.ok(daily.every((row) => row.n >= 1 && row.last_ts && row.sum_qty != null));
});

test("memory storage serves the ingest and summary API", async () => {
  const storage = new MemoryStorage();
  const ctx = { token: "tok", timeZone: "UTC", storage, now: new Date("2026-10-16T12:00:00Z"), ...fixtureIngest };

  const denied = await handleRequest(request("/summary?date=2026-10-14", { token: "" }), ctx);
  assert.equal(denied.status, 401);
  assert.deepEqual(await denied.json(), { error: "unauthorized" });

  const bad = await handleRequest(request("/ingest", { method: "POST", body: "{" }), ctx);
  assert.equal(bad.status, 400);

  const missing = await handleRequest(request("/summary"), ctx);
  assert.equal(missing.status, 400);
  assert.deepEqual(await missing.json(), { error: "date=YYYY-MM-DD required" });

  const unknown = await handleRequest(request("/health"), ctx);
  assert.equal(unknown.status, 404);

  const ingested = await handleRequest(request("/ingest", { method: "POST", body: JSON.stringify(sample) }), ctx);
  assert.equal(ingested.status, 200);
  const ingestBody = await ingested.json();
  assert.equal(ingestBody.ok, true);
  assert.deepEqual(ingestBody.dates, [summaryDate]);
  assert.equal(ingestBody.points, 11);
  assert.equal(ingestBody.workouts, 1);
  assert.match(ingestBody.id, /^2026-10-14\//);
  assert.equal(storage.payloads.length, 0);

  const summarized = await handleRequest(request(`/summary?date=${summaryDate}`), ctx);
  assert.equal(summarized.headers.get("cache-control"), "no-store");
  assert.deepEqual(await summarized.json(), expectedSummary);

  const empty = await handleRequest(request("/summary?date=2026-01-01"), ctx);
  const emptyBody = await empty.json();
  assert.equal(emptyBody.dietary_kcal, null);
  assert.deepEqual(emptyBody.workouts, []);

  const replaced = structuredClone(sample);
  replaced.data.metrics.find((metric) => metric.name === "step_count").data = [
    { date: "2026-10-14 09:00:00 -0700", qty: 100 },
    { date: "2026-10-14 18:00:00 -0700", qty: 50 },
  ];
  await handleRequest(request("/ingest", { method: "POST", body: JSON.stringify(replaced) }), ctx);
  const after = await (await handleRequest(request(`/summary?date=${summaryDate}`), ctx)).json();
  assert.equal(after.steps, 150);
  assert.equal(after.dietary_kcal, expectedSummary.dietary_kcal);

  await handleRequest(request("/ingest", { method: "POST", body: JSON.stringify(sample) }), ctx);
  await handleRequest(request("/ingest", { method: "POST", body: JSON.stringify(sample) }), ctx);
  const retried = await (await handleRequest(request(`/summary?date=${summaryDate}`), ctx)).json();
  assert.deepEqual(retried, expectedSummary);
  assert.equal(storage.points.size, Object.keys(SUM_METRICS).length + Object.keys(LATEST_METRICS).length);
});

test("HEALTH_STORE_RAW defaults to off", async () => {
  assert.equal(rawStorageEnabled(undefined), false);
  assert.equal(rawStorageEnabled(null), false);
  assert.equal(rawStorageEnabled(""), false);
  assert.equal(rawStorageEnabled("  "), false);
  assert.equal(rawStorageEnabled(false), false);
  assert.equal(rawStorageEnabled("false"), false);
  assert.equal(rawStorageEnabled("0"), false);
  assert.equal(rawStorageEnabled("no"), false);
  assert.equal(rawStorageEnabled("off"), false);
  assert.equal(rawStorageEnabled("maybe"), false);
  assert.equal(rawStorageEnabled(true), true);
  assert.equal(rawStorageEnabled("true"), true);
  assert.equal(rawStorageEnabled("TRUE"), true);
  assert.equal(rawStorageEnabled("1"), true);
  assert.equal(rawStorageEnabled("yes"), true);
  assert.equal(rawStorageEnabled("on"), true);

  const small = "x".repeat(32);
  assert.equal(shouldStoreRaw({ payload: small }), false);
  assert.equal(shouldStoreRaw({ storeRaw: "", payload: small }), false);
  assert.equal(shouldStoreRaw({ storeRaw: "true", payload: small }), true);

  const body = JSON.stringify({
    data: {
      metrics: [
        { name: "step_count", units: "count", data: [{ date: "2026-10-14 09:00:00 -0700", qty: 42 }] },
      ],
    },
  });
  const off = new MemoryStorage();
  const skipped = await handleRequest(request("/ingest", { method: "POST", body }), {
    token: "tok",
    storage: off,
    now: new Date("2026-10-16T12:00:00Z"),
    ...fixtureIngest,
  });
  assert.equal(skipped.status, 200);
  assert.equal(off.payloads.length, 0);
  assert.equal((await (await handleRequest(request("/summary?date=2026-10-14"), { token: "tok", storage: off })).json()).steps, 42);

  const on = new MemoryStorage();
  const stored = await handleRequest(request("/ingest", { method: "POST", body }), {
    token: "tok",
    storage: on,
    storeRaw: "true",
    now: new Date("2026-10-16T12:00:00Z"),
    ...fixtureIngest,
  });
  assert.equal(stored.status, 200);
  assert.equal(on.payloads.length, 1);
  assert.equal(on.payloads[0].payload, body);
});

test("allowlist stores extra metrics and raw storage can be turned off", async () => {
  const storage = new MemoryStorage();
  const body = {
    data: {
      metrics: [
        { name: "step_count", units: "count", data: [{ date: "2026-10-14 09:00:00 -0700", qty: 10 }] },
        { name: "heart_rate", units: "count/min", data: [{ date: "2026-10-14 09:00:00 -0700", qty: 60 }] },
      ],
    },
  };
  const ctx = { token: "tok", storage, storeRaw: "false", metricAllowlist: "heart_rate", now: new Date("2026-10-16T12:00:00Z"), ...fixtureIngest };
  const ingested = await handleRequest(request("/ingest", { method: "POST", body: JSON.stringify(body) }), ctx);
  assert.equal((await ingested.json()).points, 2);
  assert.equal(storage.payloads.length, 0);
  assert.equal(storage.points.size, 2);
  const summary = await (await handleRequest(request("/summary?date=2026-10-14"), ctx)).json();
  assert.equal(summary.steps, 10);
  assert.deepEqual(Object.keys(summary), SUMMARY_FIELDS);
  assert.equal(storedMetricSet("heart_rate, heart_rate").has("heart_rate"), true);
});

test("a partial re-send leaves the full-day total unchanged", async () => {
  const storage = new MemoryStorage();
  const ctx = { token: "tok", storage, now: new Date("2026-10-16T12:00:00Z"), ...fixtureIngest };
  const full = {
    data: {
      metrics: [
        {
          name: "step_count",
          units: "count",
          data: [
            { date: "2026-10-14 08:00:00 -0700", qty: 1000 },
            { date: "2026-10-14 12:00:00 -0700", qty: 2000 },
            { date: "2026-10-14 18:00:00 -0700", qty: 3000 },
          ],
        },
        { name: "dietary_energy", units: "kcal", data: [{ date: "2026-10-14 08:00:00 -0700", qty: 400 }] },
      ],
    },
  };
  const partial = {
    data: {
      metrics: [
        { name: "step_count", units: "count", data: [{ date: "2026-10-14 08:00:00 -0700", qty: 5 }] },
      ],
    },
  };
  await handleRequest(request("/ingest", { method: "POST", body: JSON.stringify(full) }), ctx);
  const again = await handleRequest(request("/ingest", { method: "POST", body: JSON.stringify(partial) }), ctx);
  assert.equal(again.status, 200);
  const summary = await (await handleRequest(request("/summary?date=2026-10-14"), ctx)).json();
  assert.equal(summary.steps, 6000);
  assert.equal(summary.dietary_kcal, 400);
  assert.equal(storage.points.get("2026-10-14\0step_count").n, 3);
});

test("malformed ingest bodies return 400", async () => {
  const storage = new MemoryStorage();
  const ctx = { token: "tok", storage };
  const bodies = [
    "{}",
    "[null]",
    "null",
    "[]",
    JSON.stringify({ data: null }),
    JSON.stringify({ data: { metrics: [null] } }),
    JSON.stringify({ data: { workouts: [null] } }),
    JSON.stringify({ data: { metrics: [{ name: "step_count", data: [null] }] } }),
    JSON.stringify({ data: { metrics: "step_count" } }),
    JSON.stringify({ metrics: null }),
  ];
  for (const body of bodies) {
    const response = await handleRequest(request("/ingest", { method: "POST", body }), ctx);
    assert.equal(response.status, 400, body);
    assert.equal((await response.json()).error, "invalid_payload");
  }
  const empty = await handleRequest(request("/ingest", {
    method: "POST",
    body: JSON.stringify({ data: { metrics: [], workouts: [] } }),
  }), ctx);
  assert.equal(empty.status, 200);
  assert.equal(storage.points.size, 0);
});

test("a raw payload over 1.5MB is not stored", async () => {
  const storage = new MemoryStorage();
  const ctx = { token: "tok", storage, now: new Date("2026-10-16T12:00:00Z"), ...fixtureIngest };
  const body = {
    data: {
      metrics: [
        { name: "step_count", units: "count", data: [{ date: "2026-10-14 09:00:00 -0700", qty: 42 }] },
      ],
      padding: "x".repeat(MAX_RAW_BYTES),
    },
  };
  const text = JSON.stringify(body);
  assert.ok(text.length > MAX_RAW_BYTES);
  const ingested = await handleRequest(request("/ingest", { method: "POST", body: text }), ctx);
  assert.equal(ingested.status, 200);
  assert.equal((await ingested.json()).points, 1);
  assert.equal(storage.payloads.length, 0);
  const summary = await (await handleRequest(request("/summary?date=2026-10-14"), ctx)).json();
  assert.equal(summary.steps, 42);

  const small = "x".repeat(MAX_RAW_BYTES);
  assert.equal(shouldStoreRaw({ storeRaw: true, payload: small }), true);
  assert.equal(shouldStoreRaw({ storeRaw: true, payload: `${small}y` }), false);
  assert.equal(shouldStoreRaw({ storeRaw: false, payload: small }), false);
  await storage.insertIngest({
    id: "over",
    date: "2026-10-14",
    receivedAt: "2026-10-16T12:00:00.000Z",
    bytes: MAX_RAW_BYTES + 1,
    payload: `${small}y`,
    storeRaw: true,
    points: [],
    workouts: [],
  });
  assert.equal(storage.payloads.length, 0);
});

test("core modules do not import a platform", () => {
  const dir = new URL("../src/core/", import.meta.url);
  for (const name of fs.readdirSync(dir)) {
    const text = fs.readFileSync(new URL(name, dir), "utf8");
    assert.doesNotMatch(text, /from\s+["']node:/);
    assert.doesNotMatch(text, /better-sqlite3|cloudflare:|wrangler|from\s+["']pg["']/);
  }
});
