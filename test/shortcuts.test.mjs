import assert from "node:assert/strict";
import { test } from "node:test";
import { redactRequestTarget } from "../src/core/auth.js";
import { handleRequest } from "../src/core/http.js";
import { MemoryStorage } from "../src/core/memory.js";
import { parseShortcuts, shortcutMetric, shortcutNumber, shortcutsError } from "../src/core/shortcuts.js";

const URL_SECRET = "a".repeat(20) + "B_c-".repeat(4);
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
  const one = (sample) => shortcutsError({ samples: [sample] }, opts);
  const ok = { type: "steps", value: "10", start: "2026-10-14T09:00:00Z" };
  assert.equal(one(ok), null);
  assert.equal(shortcutsError({}, opts), "invalid_payload");
  assert.equal(shortcutsError([], opts), "invalid_payload");
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
  assert.equal(shortcutsError({ workouts: [{ type: "Running", start: ok.start, duration: "999999" }] }, opts), "invalid_payload");
  assert.equal(shortcutsError({ workouts: [{ type: "Running", start: ok.start, duration: "1800", energy: "x" }] }, opts), "invalid_payload");
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
  for (const name of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf", "__defineGetter__"]) {
    assert.equal(shortcutMetric(name), null);
    assert.equal(shortcutsError({ samples: [{ type: name, value: "1", start: "2026-10-14T09:00:00Z" }] }, opts), "invalid_payload");
  }
  assert.equal(parseShortcuts({ samples: [{ type: "__proto__", value: "1", start: "2026-10-14T09:00:00Z" }] }, opts).points.length, 0);
  for (const unit of ["__proto__", "constructor", "toString"]) {
    assert.equal(shortcutsError({ samples: [{ type: "weight", value: "70", unit, start: "2026-10-14T09:00:00Z" }] }, opts), "invalid_payload");
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
