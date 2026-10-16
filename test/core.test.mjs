import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { aggregateDays, rawStorageEnabled, shouldStoreRaw, storedMetricSet } from "../src/core/aggregate.js";
import { authed } from "../src/core/auth.js";
import { handleRequest } from "../src/core/http.js";
import { MemoryStorage } from "../src/core/memory.js";
import { LATEST_METRICS, MAX_RAW_BYTES, SUM_METRICS, SUMMARY_FIELDS } from "../src/core/metrics.js";
import { localDate } from "../src/core/parse.js";
import { summarizeDay } from "../src/core/summary.js";
import { expectedSummary, summaryChunk, summaryDate } from "./expected.mjs";

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

test("auth compares the bearer token and fails closed", () => {
  const env = { HEALTH_INGEST_TOKEN: "abc" };
  const call = (header, context = env) => authed(request("/summary?date=2026-10-14", { token: header }), context);
  assert.equal(call("Bearer abc"), true);
  assert.equal(call("bearer abc"), true);
  assert.equal(call("Bearer abd"), false);
  assert.equal(call(undefined, env), false);
  assert.equal(authed(request("/summary?date=2026-10-14", { token: "Bearer abc" }), {}), false);
  assert.equal(authed(request("/summary?date=2026-10-14", { token: "Bearer abc" }), { HEALTH_INGEST_TOKEN: "" }), false);
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
  const points = [
    { metric: "dietary_energy", ts: "2026-10-14 08:00:00 -0700", date: summaryDate, units: "kcal", qty: 500 },
    { metric: "dietary_energy", ts: "2026-10-14 13:00:00 -0700", date: summaryDate, units: "kcal", qty: 700.5 },
    { metric: "protein", ts: "2026-10-14 08:00:00 -0700", date: summaryDate, units: "g", qty: 40 },
    { metric: "carbohydrates", ts: "2026-10-14 08:00:00 -0700", date: summaryDate, units: "g", qty: 120 },
    { metric: "total_fat", ts: "2026-10-14 08:00:00 -0700", date: summaryDate, units: "g", qty: 35 },
    { metric: "active_energy", ts: "2026-10-14 10:00:00 -0700", date: summaryDate, units: "kcal", qty: 500 },
    { metric: "basal_energy_burned", ts: "2026-10-14 00:00:00 -0700", date: summaryDate, units: "kcal", qty: 1750 },
    { metric: "step_count", ts: "2026-10-14 09:00:00 -0700", date: summaryDate, units: "count", qty: 4000 },
    { metric: "step_count", ts: "2026-10-14 18:00:00 -0700", date: summaryDate, units: "count", qty: 5321 },
    { metric: "weight_body_mass", ts: "2026-10-14 07:00:00 -0700", date: summaryDate, units: "lb", qty: 180.2 },
    { metric: "body_fat_percentage", ts: "2026-10-14 07:00:00 -0700", date: summaryDate, units: "%", qty: 18.4 },
  ];
  const workouts = summaryChunk.workouts;
  const daily = aggregateDays(points);
  const fromSamples = summarizeDay(summaryDate, points, workouts);
  const fromDays = summarizeDay(summaryDate, daily, workouts);
  assert.deepEqual(fromDays, fromSamples);
  assert.deepEqual(fromDays, expectedSummary);
  assert.equal(daily.length, Object.keys(SUM_METRICS).length + Object.keys(LATEST_METRICS).length);
  assert.ok(daily.every((row) => row.n >= 1 && row.last_ts && row.sum_qty != null));
});

test("memory storage serves the ingest and summary API", async () => {
  const storage = new MemoryStorage();
  const ctx = { token: "tok", timeZone: "UTC", storage, now: new Date("2026-10-16T12:00:00Z") };

  const denied = await handleRequest(request("/summary?date=2026-10-14", { token: "" }), ctx);
  assert.equal(denied.status, 401);
  assert.deepEqual(await denied.json(), { error: "unauthorized" });

  const missing = await handleRequest(request("/summary"), ctx);
  assert.equal(missing.status, 400);
  assert.deepEqual(await missing.json(), { error: "date=YYYY-MM-DD required" });

  const unknown = await handleRequest(request("/health"), ctx);
  assert.equal(unknown.status, 404);
  assert.deepEqual(await unknown.json(), { error: "not_found" });

  const ingested = await handleRequest(request("/import/apple-health/chunk", { method: "POST", body: JSON.stringify(summaryChunk) }), ctx);
  assert.equal(ingested.status, 200);
  const ingestBody = await ingested.json();
  assert.equal(ingestBody.ok, true);
  assert.deepEqual(ingestBody.dates, [summaryDate]);
  assert.equal(ingestBody.points, 10);
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

  const replaced = {
    points: [{ metric: "step_count", date: summaryDate, sum_qty: 150, last_qty: 50, last_ts: "2026-10-14 18:00:00 -0700", units: "count", n: 2 }],
    workouts: [],
  };
  await handleRequest(request("/import/apple-health/chunk", { method: "POST", body: JSON.stringify(replaced) }), ctx);
  const after = await (await handleRequest(request(`/summary?date=${summaryDate}`), ctx)).json();
  assert.equal(after.steps, 150);
  assert.equal(after.dietary_kcal, expectedSummary.dietary_kcal);

  await handleRequest(request("/import/apple-health/chunk", { method: "POST", body: JSON.stringify(summaryChunk) }), ctx);
  await handleRequest(request("/import/apple-health/chunk", { method: "POST", body: JSON.stringify(summaryChunk) }), ctx);
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
    timestamp: "2026-10-16T12:00:00Z",
    app_version: "1.2.3",
    steps: [{ count: 42, start_time: "2026-10-14T16:00:00Z", end_time: "2026-10-14T17:00:00Z" }],
  });
  const off = new MemoryStorage();
  const skipped = await handleRequest(request("/ingest/hc-webhook", { method: "POST", body }), {
    token: "tok",
    storage: off,
    now: new Date("2026-10-16T12:00:00Z"),
  });
  assert.equal(skipped.status, 200);
  assert.equal(off.payloads.length, 0);
  assert.equal((await (await handleRequest(request("/summary?date=2026-10-14"), { token: "tok", storage: off })).json()).steps, 42);

  const on = new MemoryStorage();
  const stored = await handleRequest(request("/ingest/hc-webhook", { method: "POST", body }), {
    token: "tok",
    storage: on,
    storeRaw: "true",
    now: new Date("2026-10-16T12:00:00Z"),
  });
  assert.equal(stored.status, 200);
  assert.equal(on.payloads.length, 1);
  const storedPayload = JSON.parse(on.payloads[0].payload);
  assert.equal(storedPayload.route, "hc-webhook");
  assert.equal(storedPayload.points[0].metric, "step_count");
  assert.equal(storedPayload.points[0].sum_qty, 42);
  assert.deepEqual(storedPayload.workouts, []);
  assert.equal(storedPayload.points[0].last_ts.includes("2026-10-14T16:00:00Z"), true);
  assert.equal(JSON.stringify(storedPayload).includes("app_version"), false);
});

test("allowlist stores extra metrics and raw storage can be turned off", async () => {
  const storage = new MemoryStorage();
  const body = {
    timestamp: "2026-10-16T12:00:00Z",
    app_version: "1.2.3",
    steps: [{ count: 10, start_time: "2026-10-14T16:00:00Z", end_time: "2026-10-14T17:00:00Z" }],
    heart_rate: [{ time: "2026-10-14T16:00:00Z", bpm: 60 }],
  };
  const ctx = { token: "tok", storage, storeRaw: "false", metricAllowlist: "heart_rate", now: new Date("2026-10-16T12:00:00Z") };
  const ingested = await handleRequest(request("/ingest/hc-webhook", { method: "POST", body: JSON.stringify(body) }), ctx);
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
  const ctx = { token: "tok", storage, now: new Date("2026-10-16T12:00:00Z") };
  const full = {
    points: [
      { metric: "step_count", date: summaryDate, sum_qty: 6000, last_qty: 3000, last_ts: "2026-10-14 18:00:00 -0700", units: "count", n: 3 },
      { metric: "dietary_energy", date: summaryDate, sum_qty: 400, last_qty: 400, last_ts: "2026-10-14 08:00:00 -0700", units: "kcal", n: 1 },
    ],
    workouts: [],
  };
  const partial = {
    points: [
      { metric: "step_count", date: summaryDate, sum_qty: 5, last_qty: 5, last_ts: "2026-10-14 08:00:00 -0700", units: "count", n: 1 },
    ],
    workouts: [],
  };
  await handleRequest(request("/import/apple-health/chunk", { method: "POST", body: JSON.stringify(full) }), ctx);
  const again = await handleRequest(request("/import/apple-health/chunk", { method: "POST", body: JSON.stringify(partial) }), ctx);
  assert.equal(again.status, 200);
  const summary = await (await handleRequest(request("/summary?date=2026-10-14"), ctx)).json();
  assert.equal(summary.steps, 6000);
  assert.equal(summary.dietary_kcal, 400);
  assert.equal(storage.points.get("2026-10-14\0step_count").n, 3);
});

test("removed ingest routes match any other unknown route", async () => {
  const ctx = { token: "tok", storage: new MemoryStorage(), now: new Date("2026-10-16T12:00:00Z") };
  const unknown = await handleRequest(request("/no-such-route", { method: "POST", body: "{}" }), ctx);
  assert.equal(unknown.status, 404);
  assert.deepEqual(await unknown.json(), { error: "not_found" });
  const paths = [
    "/ingest",
    "/ingest/life-dashboard",
    "/ingest/life-dashboard/tok",
    "/ingest/health-export-pro",
    "/ingest/syncfit",
  ];
  for (const pathname of paths) {
    const anonymous = await handleRequest(request(pathname, { method: "POST", token: "", body: "{}" }), ctx);
    assert.equal(anonymous.status, 401, pathname);
    const response = await handleRequest(request(pathname, { method: "POST", body: "{}" }), ctx);
    assert.equal(response.status, 410, pathname);
    assert.deepEqual(await response.json(), { error: "gone" }, pathname);
  }
});

test("a raw payload over 1.5MB is not stored", async () => {
  const storage = new MemoryStorage();
  const ctx = { token: "tok", storage, now: new Date("2026-10-16T12:00:00Z"), limitsProfile: "node", adapter: "node" };
  const body = {
    timestamp: "2026-10-16T12:00:00Z",
    app_version: "1.2.3",
    steps: [{ count: 42, start_time: "2026-10-14T16:00:00Z", end_time: "2026-10-14T17:00:00Z" }],
    padding: "x".repeat(MAX_RAW_BYTES),
  };
  const text = JSON.stringify(body);
  assert.ok(text.length > MAX_RAW_BYTES);
  const ingested = await handleRequest(request("/ingest/hc-webhook", { method: "POST", body: text }), ctx);
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
