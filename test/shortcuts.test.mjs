import assert from "node:assert/strict";
import { test } from "node:test";
import { redactRequestTarget } from "../src/core/auth.js";
import { handleRequest } from "../src/core/http.js";
import { MemoryStorage } from "../src/core/memory.js";
import { parseShortcuts, shortcutDays, shortcutMetric, shortcutNumber, shortcutsError } from "../src/core/shortcuts.js";

const URL_SECRET = "a".repeat(20) + "B_c-".repeat(4);
const errorOf = (...args) => shortcutsError(...args)?.error ?? null;
const NOW = new Date("2026-10-16T12:00:00Z");

function request(pathname, { method = "POST", token = "tok", body } = {}) {
  const headers = new Headers();
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (body != null) headers.set("content-type", "application/json");
  return new Request(`http://localhost${pathname}`, { method, headers, body });
}

function ctx(storage = new MemoryStorage(), extra = {}) {
  return { token: "tok", timeZone: "UTC", storage, now: NOW, ...extra };
}

// Synthetic values only.
function body() {
  return {
    samples: [
      { type: "Steps", value: "4000", unit: "count", start: "2026-10-14T09:00:00-07:00", end: "2026-10-14T09:30:00-07:00" },
      { type: "Steps", value: 5321, unit: "count", start: "2026-10-14T18:00:00-07:00", end: "2026-10-14T18:45:00-07:00" },
      { type: "Active Energy", value: "2092", unit: "kJ", start: "2026-10-14T10:00:00-07:00" },
      { type: "Resting Energy", value: "1750", unit: "kcal", start: "2026-10-14T00:00:00-07:00" },
      { type: "Weight", value: "180,2", unit: "lb", start: "2026-10-14T07:00:00-07:00" },
      { type: "Body Fat Percentage", value: "18.4", unit: "%", start: "2026-10-14T07:00:00-07:00" },
      { type: "Dietary Energy", value: "1200.5", unit: "kcal", start: "2026-10-14T08:00:00-07:00" },
      { type: "Protein", value: "40", unit: "g", start: "2026-10-14T08:00:00-07:00" },
      { type: "heart_rate", value: "60", unit: "count/min", start: "2026-10-14T09:00:00-07:00" },
    ],
    workouts: [
      { type: "Running", start: "2026-10-14T17:30:00-07:00", end: "2026-10-14T18:15:00-07:00", energy: "310", energyUnit: "kcal" },
    ],
  };
}

test("shortcutNumber accepts numbers and numeric strings, rejects grouping", () => {
  assert.equal(shortcutNumber(" 72.5 "), 72.5);
  assert.equal(shortcutNumber("72,5"), 72.5);
  assert.equal(shortcutNumber(8123), 8123);
  assert.equal(shortcutNumber("1,234"), null);
  assert.equal(shortcutNumber("1 234"), null);
  assert.equal(shortcutNumber("abc"), null);
  assert.equal(shortcutNumber(true), null);
});

test("parseShortcuts normalizes names and units", () => {
  const { points, workouts } = parseShortcuts(body(), { timeZone: "UTC", now: NOW });
  const find = (metric) => points.find((row) => row.metric === metric);
  assert.equal(Math.round(find("active_energy").qty), 500);
  assert.equal(find("basal_energy_burned").units, "kcal");
  assert.equal(find("weight_body_mass").units, "kg");
  assert.ok(Math.abs(find("weight_body_mass").qty - 81.737) < 0.01);
  assert.equal(points.every((row) => row.date === "2026-10-14"), true);
  assert.deepEqual(workouts[0], { name: "Running", start: "2026-10-14T17:30:00-07:00", date: "2026-10-14", duration_min: 45, kcal: 310 });
});

test("dates: offset keeps written day, Z uses HEALTH_TIMEZONE, no offset keeps written day", () => {
  const opts = { timeZone: "America/Los_Angeles", now: NOW };
  const rows = parseShortcuts({ samples: [
    { type: "steps", value: 1, start: "2026-10-14T23:30:00-07:00" },
    { type: "steps", value: 2, start: "2026-10-15T03:00:00Z" },
    { type: "steps", value: 3, start: "2026-10-14 08:00:00" },
    { type: "steps", value: 4, start: "2026-10-14" },
    { type: "steps", value: 5, start: "2026-10-14T08:00:00-0700" },
  ] }, opts).points.map((row) => row.date);
  assert.deepEqual(rows, ["2026-10-14", "2026-10-14", "2026-10-14", "2026-10-14", "2026-10-14"]);
});

test("shortcutsError rejects bad entries and out-of-range values", () => {
  const opts = { timeZone: "UTC", now: NOW };
  const one = (sample) => errorOf({ samples: [sample] }, opts);
  const ok = { type: "steps", value: "10", start: "2026-10-14T09:00:00Z" };
  assert.equal(one(ok), null);
  assert.equal(errorOf({}, opts), "invalid_payload");
  assert.equal(errorOf([], opts), "invalid_payload");
  assert.equal(one({ ...ok, start: "Oct 14, 2026 at 9:00 AM" }), "invalid_payload");
  assert.equal(one({ ...ok, start: "14/10/2026" }), "invalid_payload");
  assert.equal(one({ ...ok, start: "2026-02-30T09:00:00Z" }), "invalid_payload");
  assert.equal(one({ ...ok, start: "1999-12-31T09:00:00Z" }), "invalid_payload");
  assert.equal(one({ ...ok, start: "2026-10-20T09:00:00Z" }), "invalid_payload");
  assert.equal(one({ ...ok, value: "2000000" }), "invalid_payload");
  assert.equal(one({ ...ok, value: "-1" }), "invalid_payload");
  assert.equal(one({ ...ok, type: "" }), "invalid_payload");
  assert.equal(one({ ...ok, type: "Héart" }), "invalid_payload");
  assert.equal(one({ type: "weight", value: "700", unit: "kg", start: ok.start }), "invalid_payload");
  assert.equal(one({ type: "weight", value: "70", unit: "furlong", start: ok.start }), "invalid_payload");
  assert.equal(one({ type: "body fat", value: "120", unit: "%", start: ok.start }), "invalid_payload");
  assert.equal(one({ type: "active energy", value: "10", unit: "mg", start: ok.start }), "invalid_payload");
  assert.equal(errorOf({ workouts: [{ type: "Running", start: ok.start, duration: "999999" }] }, opts), "invalid_payload");
  assert.equal(errorOf({ workouts: [{ type: "Running", start: ok.start, duration: "1800", energy: "x" }] }, opts), "invalid_payload");
});

test("POST /ingest/shortcuts stores one row per metric per day and honors the allowlist", async () => {
  const storage = new MemoryStorage();
  const response = await handleRequest(request("/ingest/shortcuts", { body: JSON.stringify(body()) }), ctx(storage));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).workouts, 1);
  const summary = await storage.queryDaySummary("2026-10-14");
  assert.equal(summary.steps, 9321);
  assert.equal(Math.round(summary.active_kcal), 500);
  assert.equal(summary.basal_kcal, 1750);
  assert.equal(summary.dietary_kcal, 1200.5);
  assert.equal(summary.protein_g, 40);
  assert.equal(summary.body_fat_pct, 18.4);
  assert.equal(summary.weight.units, "kg");
  assert.equal(summary.workouts[0].name, "Running");
  assert.equal((await storage.listMetrics()).includes("heart_rate"), false);

  const again = await handleRequest(request("/ingest/shortcuts", { body: JSON.stringify(body()) }), ctx(storage));
  assert.equal(again.status, 200);
  assert.equal((await storage.queryDaySummary("2026-10-14")).steps, 9321);

  const allowed = new MemoryStorage();
  await handleRequest(request("/ingest/shortcuts", { body: JSON.stringify(body()) }), ctx(allowed, { metricAllowlist: "heart_rate" }));
  assert.equal((await allowed.listMetrics()).includes("heart_rate"), true);
});

test("POST /ingest/shortcuts rejects bad JSON, bad payloads, and bad auth", async () => {
  const storage = new MemoryStorage();
  assert.equal((await handleRequest(request("/ingest/shortcuts", { body: "{" }), ctx(storage))).status, 400);
  assert.equal((await handleRequest(request("/ingest/shortcuts", { body: "{}" }), ctx(storage))).status, 400);
  assert.equal((await handleRequest(request("/ingest/shortcuts", { token: "nope", body: JSON.stringify(body()) }), ctx(storage))).status, 401);
  assert.equal((await handleRequest(request("/ingest/shortcuts", { token: "", body: JSON.stringify(body()) }), ctx(storage))).status, 401);
  assert.equal((await handleRequest(request("/ingest/shortcuts", { method: "GET" }), ctx(storage))).status, 404);
});

test("HEALTH_INGEST_URL_TOKEN works on /ingest/shortcuts, write-only and off when unset", async () => {
  const payload = JSON.stringify(body());
  const on = () => ctx(new MemoryStorage(), { urlToken: URL_SECRET });
  assert.equal((await handleRequest(request(`/ingest/shortcuts/${URL_SECRET}`, { token: "", body: payload }), on())).status, 200);
  assert.equal((await handleRequest(request(`/ingest/shortcuts?token=${URL_SECRET}`, { token: "", body: payload }), on())).status, 200);
  assert.equal((await handleRequest(request(`/ingest/shortcuts/${URL_SECRET}`, { token: "", body: payload }), ctx())).status, 401);
  assert.equal((await handleRequest(request(`/ingest/shortcuts/${URL_SECRET}`, { token: URL_SECRET, body: payload }), on())).status, 401);
  assert.equal((await handleRequest(request(`/ingest/shortcuts/${URL_SECRET}`, { method: "GET", token: "" }), on())).status, 401);
  assert.equal((await handleRequest(request(`/summary?date=2026-10-14&token=${URL_SECRET}`, { method: "GET", token: "" }), on())).status, 401);
  assert.equal((await handleRequest(request(`/ingest?token=${URL_SECRET}`, { token: "", body: payload }), on())).status, 401);
  assert.equal(redactRequestTarget(`POST /ingest/shortcuts/${URL_SECRET}`, "tok", ""), "POST /ingest/shortcuts/[redacted]");
});

test("prototype keys are not treated as known types or units", () => {
  const opts = { timeZone: "UTC", now: NOW };
  for (const name of ["__proto__", "constructor", "Constructor", "__defineGetter__", "__lookupSetter__"]) {
    assert.equal(shortcutMetric(name), null);
    assert.equal(errorOf({ samples: [{ type: name, value: "1", start: "2026-10-14T09:00:00Z" }] }, opts), "invalid_payload");
  }
  // Mixed-case names are lowercased first, so "toString" becomes an ordinary name, not a prototype key.
  assert.equal(shortcutMetric("toString"), "tostring");
  assert.equal(parseShortcuts({ samples: [{ type: "__proto__", value: "1", start: "2026-10-14T09:00:00Z" }] }, opts).points.length, 0);
  for (const unit of ["__proto__", "constructor", "toString"]) {
    assert.equal(errorOf({ samples: [{ type: "weight", value: "70", unit, start: "2026-10-14T09:00:00Z" }] }, opts), "invalid_payload");
  }
});

test("POST /ingest/shortcuts rejects an oversized declared Content-Length", async () => {
  const req = new Request("http://localhost/ingest/shortcuts", {
    method: "POST",
    headers: { authorization: "Bearer tok", "content-length": "20000001" },
    body: "{}",
  });
  const response = await handleRequest(req, ctx());
  assert.equal(response.status, 413);
});

function post(storage, payload, extra = {}) {
  return handleRequest(request("/ingest/shortcuts", { body: JSON.stringify(payload) }), ctx(storage, extra));
}

test("raw mode: iPhone and Watch overlap counts one source (Watch first by default)", async () => {
  const samples = [
    { type: "Steps", value: "100", source: "Synthetic iPhone", start: "2026-10-14T09:00:00-07:00", end: "2026-10-14T09:10:00-07:00" },
    { type: "Steps", value: "100", source: "Synthetic Apple Watch", start: "2026-10-14T09:01:00-07:00", end: "2026-10-14T09:11:00-07:00" },
    { type: "Steps", value: "40", source: "Synthetic Apple Watch", start: "2026-10-14T12:00:00-07:00", end: "2026-10-14T12:05:00-07:00" },
  ];
  const storage = new MemoryStorage();
  assert.equal((await post(storage, { samples })).status, 200);
  assert.equal((await storage.queryDaySummary("2026-10-14")).steps, 140);

  const phoneFirst = new MemoryStorage();
  await post(phoneFirst, { samples }, { shortcutsSourcePriority: "iphone,watch" });
  assert.equal((await phoneFirst.queryDaySummary("2026-10-14")).steps, 100);

  const rows = shortcutDays(parseShortcuts({ samples }, { timeZone: "UTC", now: NOW }).points, ["nothing"]);
  assert.equal(rows[0].sum_qty, 140);
});

test("daily mode stores the day total and a re-send replaces it, even with a lower value", async () => {
  const storage = new MemoryStorage();
  const day = (value) => ({ samples: [
    { kind: "daily", type: "Steps", value, date: "2026-10-14" },
    { type: "Steps", value: "999", start: "2026-10-14T10:00:00-07:00" },
  ] });
  assert.equal((await post(storage, day("8000"))).status, 200);
  assert.equal((await storage.queryDaySummary("2026-10-14")).steps, 8000);
  await post(storage, day("8000"));
  assert.equal((await storage.queryDaySummary("2026-10-14")).steps, 8000);
  await post(storage, day("7500"));
  assert.equal((await storage.queryDaySummary("2026-10-14")).steps, 7500);

  const raw = new MemoryStorage();
  const many = { samples: [1, 2, 3, 4].map((h) => ({ type: "Steps", value: "10", start: `2026-10-14T0${h}:00:00Z` })) };
  await post(raw, many);
  await post(raw, { samples: [{ type: "Steps", value: "5", start: "2026-10-14T09:00:00Z" }] });
  assert.equal((await raw.queryDaySummary("2026-10-14")).steps, 5);

  const dup = shortcutsError({ samples: [
    { kind: "daily", type: "Steps", value: "1", date: "2026-10-14" },
    { kind: "daily", type: "steps", value: "2", date: "2026-10-14" },
  ] }, { timeZone: "UTC", now: NOW });
  assert.deepEqual(dup, { error: "invalid_payload", at: "samples[1]", field: "start" });
});

test("offset-less times use HEALTH_TIMEZONE, not the host zone (DST fall-back in LA)", () => {
  const opts = { timeZone: "America/Los_Angeles", now: NOW };
  const { workouts } = parseShortcuts({ workouts: [{ type: "Walking", start: "2025-11-02T00:30:00", end: "2025-11-02T03:30:00" }] }, opts);
  assert.equal(workouts[0].duration_min, 240);
  assert.equal(workouts[0].date, "2025-11-02");
  const utc = parseShortcuts({ workouts: [{ type: "Walking", start: "2025-11-02T00:30:00", end: "2025-11-02T03:30:00" }] }, { timeZone: "UTC", now: NOW });
  assert.equal(utc.workouts[0].duration_min, 180);
});

test("end before start is rejected with a locator that does not echo input", async () => {
  const sentinel = "2026-10-14T08:59:00-07:00";
  const response = await post(new MemoryStorage(), { samples: [
    { type: "Steps", value: "1", start: "2026-10-14T08:00:00-07:00" },
    { type: "Steps", value: "1", start: "2026-10-14T09:00:00-07:00", end: sentinel },
  ] });
  assert.equal(response.status, 400);
  const text = await response.text();
  assert.deepEqual(JSON.parse(text), { error: "invalid_payload", at: "samples[1]", field: "end" });
  assert.equal(text.includes(sentinel), false);
  const bad = await post(new MemoryStorage(), { samples: [{ type: "Steps", value: "SENTINEL_9", start: "2026-10-14" }] });
  const badText = await bad.text();
  assert.deepEqual(JSON.parse(badText), { error: "invalid_payload", at: "samples[0]", field: "value" });
  assert.equal(badText.includes("SENTINEL"), false);
  assert.deepEqual(shortcutsError({ workouts: [{ start: "x" }] }, { timeZone: "UTC", now: NOW }), { error: "invalid_payload", at: "workouts[0]", field: "start" });
});

test("a sample crossing midnight counts on its start day", () => {
  const { points } = parseShortcuts({ samples: [{ type: "Steps", value: "50", start: "2026-10-13T23:50:00-07:00", end: "2026-10-14T00:10:00-07:00" }] }, { timeZone: "America/Los_Angeles", now: NOW });
  assert.equal(points[0].date, "2026-10-13");
});

test("response reports samples dropped by the metric allowlist", async () => {
  const response = await post(new MemoryStorage(), { samples: [
    { type: "Steps", value: "1", start: "2026-10-14" },
    { type: "Heart Rate", value: "60", start: "2026-10-14" },
    { type: "Heart Rate", value: "61", start: "2026-10-14T01:00:00" },
  ] });
  const result = await response.json();
  assert.equal(result.points, 1);
  assert.equal(result.dropped, 2);
});

test("SQLite replace rows overwrite the day regardless of stored n", async () => {
  const { createSqliteStorage } = await import("../src/adapters/sqlite.js");
  const storage = createSqliteStorage(":memory:");
  const base = { id: "a", date: "2026-10-14", receivedAt: "2026-10-16T12:00:00Z", bytes: 1, payload: null, workouts: [] };
  const row = { date: "2026-10-14", metric: "step_count", units: "count", last_ts: "2026-10-14T09:00:00Z" };
  await storage.insertIngest({ ...base, points: [{ ...row, sum_qty: 10, last_qty: 1, n: 4 }] });
  await storage.insertIngest({ ...base, id: "b", points: [{ ...row, sum_qty: 3, last_qty: 3, n: 1 }] });
  assert.equal((await storage.queryDaySummary("2026-10-14")).steps, 10);
  await storage.insertIngest({ ...base, id: "c", points: [{ ...row, sum_qty: 5, last_qty: 5, n: 1, replace: true }] });
  assert.equal((await storage.queryDaySummary("2026-10-14")).steps, 5);
});

test("URL-token requests cannot lower a day written with Bearer; Bearer resends still replace", async () => {
  const storage = new MemoryStorage();
  const extra = { urlToken: URL_SECRET };
  const day = (value) => JSON.stringify({ samples: [{ kind: "daily", type: "Steps", value, date: "2026-10-14" }] });
  const raw = JSON.stringify({ samples: [1, 2, 3].map((h) => ({ type: "Steps", value: "0.5", start: `2026-10-14T0${h}:00:00Z` })) });
  const viaBearer = (body) => handleRequest(request("/ingest/shortcuts", { body }), ctx(storage, extra));
  const viaUrl = (body) => handleRequest(request(`/ingest/shortcuts/${URL_SECRET}`, { token: "", body }), ctx(storage, extra));
  const steps = async () => (await storage.queryDaySummary("2026-10-14")).steps;

  assert.equal((await viaBearer(day("5000"))).status, 200);
  assert.equal(await steps(), 5000);
  assert.equal((await viaUrl(day("1"))).status, 200);
  assert.equal(await steps(), 5000);
  assert.equal((await viaUrl(raw)).status, 200);
  assert.equal(await steps(), 5000);
  assert.equal((await viaBearer(day("4200"))).status, 200);
  assert.equal(await steps(), 4200);

  const fresh = new MemoryStorage();
  const urlOnly = (body) => handleRequest(request(`/ingest/shortcuts/${URL_SECRET}`, { token: "", body }), ctx(fresh, extra));
  await urlOnly(day("300"));
  assert.equal((await fresh.queryDaySummary("2026-10-14")).steps, 300);
  await urlOnly(day("900"));
  assert.equal((await fresh.queryDaySummary("2026-10-14")).steps, 900);
});
