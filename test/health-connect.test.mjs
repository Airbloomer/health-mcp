import assert from "node:assert/strict";
import { test } from "node:test";
import { activeUrlToken, authed, redactRequestTarget, resetUrlTokenWarnings } from "../src/core/auth.js";
import { exerciseName } from "../src/core/health-connect.js";
import { parseHcWebhook } from "../src/core/hc-webhook.js";
import { handleRequest } from "../src/core/http.js";
import { MemoryStorage } from "../src/core/memory.js";
import { summaryDate } from "./expected.mjs";

const URL_SECRET = `${"a".repeat(31)}-`;

function request(pathname, { method = "POST", token = "tok", body, headers = {} } = {}) {
  const initHeaders = new Headers(headers);
  if (token) initHeaders.set("authorization", /^bearer\s/i.test(token) ? token : `Bearer ${token}`);
  if (body != null) initHeaders.set("content-type", "application/json");
  return new Request(`http://localhost${pathname}`, { method, headers: initHeaders, body });
}

function ctx(storage = new MemoryStorage(), extra = {}) {
  return { token: "tok", timeZone: "UTC", storage, now: new Date("2026-10-16T12:00:00Z"), ...extra };
}

function hcBody(steps = [4000, 5321]) {
  return {
    timestamp: "2026-10-16T12:00:00.123Z",
    app_version: "1.2.3",
    steps: steps.map((count, index) => ({
      count,
      start_time: `2026-10-14T${String(9 + index).padStart(2, "0")}:00:00Z`,
      end_time: `2026-10-14T${String(10 + index).padStart(2, "0")}:00:00Z`,
    })),
    heart_rate: [
      { time: "2026-10-14T08:15:00Z", avg: 72, min: 68, max: 80, bpm: 72 },
    ],
    active_calories: [{ calories: 500, start_time: "2026-10-14T09:00:00Z", end_time: "2026-10-14T10:00:00Z" }],
    total_calories: [{ calories: 2250, start_time: "2026-10-14T00:00:00Z", end_time: "2026-10-14T23:00:00Z" }],
    distance: [{ meters: 7100, start_time: "2026-10-14T09:00:00Z", end_time: "2026-10-14T10:00:00Z" }],
    weight: [
      { kilograms: 80, time: "2026-10-14T07:00:00Z" },
      { kilograms: 81.7, time: "2026-10-14T21:00:00Z" },
    ],
    body_fat: [{ percentage: 18.4, time: "2026-10-14T07:00:00Z" }],
    nutrition: [{
      calories: 1200.5,
      protein_grams: 40,
      carbs_grams: 120,
      fat_grams: 35,
      sugar_grams: 10,
      name: "Synthetic meal",
      start_time: "2026-10-14T08:00:00Z",
      end_time: "2026-10-14T08:20:00Z",
    }],
    basal_metabolic_rate: [{ watts: 80, time: "2026-10-14T00:00:00Z" }],
    sleep: [{
      session_end_time: "2026-10-14T06:30:00Z",
      duration_seconds: 28800,
      stages: [{ stage: "STAGE_TYPE_DEEP", start_time: "2026-10-13T23:00:00Z", end_time: "2026-10-14T01:00:00Z", duration_seconds: 7200 }],
    }],
    exercise: [
      { type: "56", title: "Morning", start_time: "2026-10-14T17:30:00Z", end_time: "2026-10-14T18:15:00Z", duration_seconds: 2700, distance_meters: 5000, steps: 6000 },
      { type: "79", start_time: "2026-10-14T12:00:00Z", end_time: "2026-10-14T12:30:00Z", duration_seconds: 1800 },
      { type: "70", start_time: "2026-10-14T19:00:00Z", end_time: "2026-10-14T19:40:00Z", duration_seconds: 2400 },
    ],
    bmi: [{ value: 24.2, time: "2026-10-14T21:00:00Z", weight_kg: 81.7, height_meters: 1.84 }],
  };
}

test("exercise type decimals and names match Health Connect constants", () => {
  assert.equal(exerciseName("56"), "Running");
  assert.equal(exerciseName("79"), "Walking");
  assert.equal(exerciseName(70), "Strength Training");
  assert.equal(exerciseName("running"), "Running");
  assert.equal(exerciseName("running_treadmill"), "Running Treadmill");
  assert.equal(exerciseName("999"), "Workout 999");
});

test("HC Webhook maps summary metrics and does not double an aggregate heart rate", () => {
  const parsed = parseHcWebhook(hcBody());
  assert.equal(parsed.points.filter((point) => point.metric === "step_count").reduce((sum, point) => sum + point.qty, 0), 9321);
  assert.equal(parsed.points.find((point) => point.metric === "heart_rate").qty, 72);
  assert.equal(parsed.points.filter((point) => point.metric === "heart_rate").length, 1);
  assert.equal(parsed.points.find((point) => point.metric === "weight_body_mass").units, "kg");
  assert.equal(parsed.points.find((point) => point.metric === "basal_metabolic_rate").units, "W");
  assert.equal(parsed.points.some((point) => point.metric === "basal_energy_burned"), false);
  assert.deepEqual(parsed.workouts.map((workout) => workout.name), ["Running", "Walking", "Strength Training"]);
  assert.equal(parsed.workouts[0].duration_min, 45);
  assert.equal(parsed.workouts[0].kcal, null);
});

test("POST /ingest/hc-webhook upserts whole days and ignores a shorter resend", async () => {
  const storage = new MemoryStorage();
  const environment = ctx(storage);
  const denied = await handleRequest(request("/ingest/hc-webhook", { token: "", body: "{}" }), environment);
  assert.equal(denied.status, 401);

  const response = await handleRequest(request("/ingest/hc-webhook", { body: JSON.stringify(hcBody()) }), environment);
  assert.equal(response.status, 200);
  const summary = await storage.queryDaySummary(summaryDate);
  assert.equal(summary.steps, 9321);
  assert.equal(summary.active_kcal, 500);
  assert.equal(summary.dietary_kcal, 1200.5);
  assert.equal(summary.protein_g, 40);
  assert.equal(summary.carbs_g, 120);
  assert.equal(summary.fat_g, 35);
  assert.equal(summary.basal_kcal, null);
  assert.deepEqual(summary.weight, { value: 81.7, units: "kg" });
  assert.equal(summary.body_fat_pct, 18.4);
  assert.equal(summary.workouts.length, 3);
  assert.equal(summary.workouts.find((workout) => workout.name === "Running").kcal, null);
  assert.equal((await storage.listMetrics()).includes("heart_rate"), false);
  assert.equal((await storage.listMetrics()).includes("total_calories"), false);
  assert.equal((await storage.listMetrics()).includes("sleep_analysis"), false);
  assert.equal((await storage.listMetrics()).includes("body_mass_index"), false);
  assert.equal(storage.payloads.length, 0);

  const again = await handleRequest(request("/ingest/hc-webhook", { body: JSON.stringify(hcBody()) }), environment);
  assert.equal(again.status, 200);
  assert.equal((await storage.queryDaySummary(summaryDate)).steps, 9321);

  const shorter = await handleRequest(request("/ingest/hc-webhook", { body: JSON.stringify(hcBody([5])) }), environment);
  assert.equal(shorter.status, 200);
  assert.equal((await storage.queryDaySummary(summaryDate)).steps, 9321);

  const replaced = await handleRequest(request("/ingest/hc-webhook", { body: JSON.stringify(hcBody([100, 50])) }), environment);
  assert.equal(replaced.status, 200);
  assert.equal((await storage.queryDaySummary(summaryDate)).steps, 150);

  const stored = new MemoryStorage();
  await handleRequest(request("/ingest/hc-webhook", { body: JSON.stringify(hcBody()) }), ctx(stored, { storeRaw: true, metricAllowlist: "heart_rate,sleep_analysis" }));
  assert.equal(stored.payloads.length, 1);
  assert.equal((await stored.queryMetricRange("heart_rate", summaryDate, summaryDate))[0].sum_qty, 72);
  assert.equal((await stored.queryMetricRange("sleep_analysis", summaryDate, summaryDate))[0].sum_qty, 28800);

  const zoned = new MemoryStorage();
  await handleRequest(request("/ingest/hc-webhook", {
    body: JSON.stringify({
      timestamp: "2026-10-16T00:00:00Z",
      app_version: "1.2.3",
      steps: [{ count: 8, start_time: "2026-10-15T05:00:00Z", end_time: "2026-10-15T06:00:00Z" }],
    }),
  }), ctx(zoned, { timeZone: "America/Los_Angeles" }));
  assert.equal((await zoned.queryDaySummary("2026-10-14")).steps, 8);
});

test("HC Webhook route rejects the wrong shape", async () => {
  const storage = new MemoryStorage();
  const environment = ctx(storage);
  const bad = await handleRequest(request("/ingest/hc-webhook", { body: "{" }), environment);
  assert.equal(bad.status, 400);
  const shape = await handleRequest(request("/ingest/hc-webhook", { body: JSON.stringify({ timestamp: "2026-10-16T00:00:00Z", app_version: "1.2.3", steps: [{ count: "4" }] }) }), environment);
  assert.equal(shape.status, 400);
  const hae = await handleRequest(request("/ingest/hc-webhook", { body: JSON.stringify({ data: { metrics: [] } }) }), environment);
  assert.equal(hae.status, 400);
  assert.equal(
    redactRequestTarget("POST /ingest/hc-webhook/s3cret-value?token=s3cret-value failed s3cret-value", "s3cret-value", "other-secret"),
    "POST /ingest/hc-webhook/[redacted]?token=[redacted] failed [redacted]",
  );
  assert.equal(redactRequestTarget("url-only leaked", "bearer-secret", "url-only"), "[redacted] leaked");
  assert.equal(redactRequestTarget("/ingest/hc-webhook"), "/ingest/hc-webhook");
});

test("URL ingest token is write-only, limited to two POST routes, and off by default", async () => {
  const storage = new MemoryStorage();
  const off = ctx(storage);
  const disabledQuery = await handleRequest(request("/ingest/hc-webhook?token=tok", { token: "", body: JSON.stringify(hcBody([9])) }), off);
  assert.equal(disabledQuery.status, 401);
  const disabledPath = await handleRequest(request("/ingest/shortcuts/tok", { token: "", body: "{}" }), off);
  assert.equal(disabledPath.status, 401);
  assert.equal(authed(new Request(`http://localhost/ingest/hc-webhook?token=${URL_SECRET}`, { method: "POST" }), { HEALTH_INGEST_TOKEN: "tok" }), false);
  assert.equal(authed(new Request(`http://localhost/ingest/hc-webhook?token=${URL_SECRET}`, { method: "POST" }), ""), false);
  assert.equal(authed(new Request(`http://localhost/ingest/hc-webhook?token=${URL_SECRET}`, { method: "POST" }), { HEALTH_INGEST_TOKEN: "", HEALTH_INGEST_URL_TOKEN: "" }), false);
  assert.equal(authed(new Request(`http://localhost/ingest/hc-webhook?token=${URL_SECRET}`, { method: "POST" }), { HEALTH_INGEST_URL_TOKEN: "   " }), false);

  const environment = ctx(storage, { urlToken: `${URL_SECRET}` });
  const mainAsUrl = await handleRequest(request("/ingest/hc-webhook?token=tok", { token: "", body: JSON.stringify(hcBody([9])) }), environment);
  assert.equal(mainAsUrl.status, 401);
  const wrongQuery = await handleRequest(request("/ingest/hc-webhook?token=nope", { token: "", body: "{}" }), environment);
  assert.equal(wrongQuery.status, 401);
  const basic = new Request(`http://localhost/ingest/hc-webhook?token=${URL_SECRET}`, {
    method: "POST",
    headers: { authorization: `Basic ${URL_SECRET}`, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal((await handleRequest(basic, environment)).status, 401);
  const urlAsBearer = await handleRequest(request("/ingest/hc-webhook", { token: `${URL_SECRET}`, body: JSON.stringify(hcBody([9])) }), environment);
  assert.equal(urlAsBearer.status, 401);

  const query = await handleRequest(request(`/ingest/hc-webhook?token=${URL_SECRET}`, { token: "", body: JSON.stringify(hcBody([9])) }), environment);
  assert.equal(query.status, 200);
  assert.equal((await storage.queryDaySummary(summaryDate)).steps, 9);
  const path = await handleRequest(request(`/ingest/hc-webhook/${URL_SECRET}`, { token: "", body: JSON.stringify(hcBody([9, 1])) }), environment);
  assert.equal(path.status, 200);
  assert.equal((await storage.queryDaySummary(summaryDate)).steps, 10);
  const removed = await handleRequest(request(`/ingest/life-dashboard/${URL_SECRET}`, { token: "", body: "{}" }), ctx(new MemoryStorage(), { urlToken: `${URL_SECRET}` }));
  assert.equal(removed.status, 401);
  const removedBearer = await handleRequest(request(`/ingest/life-dashboard/${URL_SECRET}`, { body: "{}" }), ctx(new MemoryStorage(), { urlToken: `${URL_SECRET}` }));
  assert.equal(removedBearer.status, 410);

  const wrongBearer = await handleRequest(request(`/ingest/hc-webhook?token=${URL_SECRET}`, { token: "nope", body: "{}" }), environment);
  assert.equal(wrongBearer.status, 401);
  const encodedKey = await handleRequest(request(`/ingest/hc-webhook?%74oken=${URL_SECRET}`, { token: "", body: "{}" }), environment);
  assert.equal(encodedKey.status, 401);
  assert.equal(redactRequestTarget("POST /ingest/hc-webhook?%74oken=s3cret-value failed", "s3cret-value").includes("s3cret-value"), false);
  assert.equal(
    redactRequestTarget("POST /ingest/hc-webhook?%74oken=s3cret-value failed", "s3cret-value"),
    "POST /ingest/hc-webhook?token=[redacted] failed",
  );
  assert.equal(redactRequestTarget("POST /ingest/hc-webhook?%2574oken=s3cret-value", "s3cret-value").includes("s3cret-value"), false);

  const denied = [
    ["GET", `/summary?date=${summaryDate}&token=${URL_SECRET}`],
    ["POST", `/summary?date=${summaryDate}&token=${URL_SECRET}`],
    ["GET", `/summary?date=${summaryDate}&token=tok`],
    ["GET", `/mcp?token=${URL_SECRET}`],
    ["POST", `/mcp?token=${URL_SECRET}`],
    ["DELETE", `/mcp?token=${URL_SECRET}`],
    ["GET", `/ingest?token=${URL_SECRET}`],
    ["POST", `/ingest?token=${URL_SECRET}`],
    ["PUT", `/ingest?token=${URL_SECRET}`],
    ["POST", `/ingest/health-export-pro?token=${URL_SECRET}`],
    ["GET", `/ingest/syncfit?token=${URL_SECRET}`],
    ["POST", `/ingest/syncfit?token=${URL_SECRET}`],
    ["POST", `/ingest/syncfit/${URL_SECRET}`],
    ["POST", `/import/apple-health?token=${URL_SECRET}`],
    ["POST", `/import/apple-health/chunk?token=${URL_SECRET}`],
    ["GET", `/ingest/hc-webhook?token=${URL_SECRET}`],
    ["PUT", `/ingest/hc-webhook?token=${URL_SECRET}`],
    ["DELETE", `/ingest/hc-webhook?token=${URL_SECRET}`],
    ["GET", `/ingest/hc-webhook/${URL_SECRET}`],
    ["POST", `/ingest/life-dashboard/${URL_SECRET}`],
    ["POST", `/ingest/${URL_SECRET}`],
  ];
  for (const [method, pathname] of denied) {
    const body = method === "GET" || method === "DELETE" ? undefined : "{}";
    const response = await handleRequest(request(pathname, { method, token: "", body }), environment);
    assert.equal(response.status, 401, `${method} ${pathname}`);
  }
  for (const pathname of ["/ingest", "/ingest/life-dashboard", "/ingest/health-export-pro", "/ingest/syncfit"]) {
    const response = await handleRequest(request(pathname, { body: "{}" }), environment);
    assert.equal(response.status, 410, pathname);
    assert.deepEqual(await response.json(), { error: "gone" }, pathname);
  }
  const summaryBearer = await handleRequest(request(`/summary?date=${summaryDate}`, { method: "GET", token: `${URL_SECRET}` }), environment);
  assert.equal(summaryBearer.status, 401);
  const mcpBearer = await handleRequest(request("/mcp", { method: "POST", token: `${URL_SECRET}`, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' }), environment);
  assert.equal(mcpBearer.status, 401);

  const summary = await handleRequest(request(`/summary?date=${summaryDate}`, { method: "GET" }), environment);
  assert.equal(summary.status, 200);
  assert.equal((await summary.json()).steps, 10);
});

test("encoded, padded, short, and reused URL tokens are rejected", async () => {
  const environment = ctx(new MemoryStorage(), { urlToken: URL_SECRET });
  const encodedPath = [...URL_SECRET].map((char) => `%${char.charCodeAt(0).toString(16).padStart(2, "0")}`).join("");
  const hyphenEncoded = URL_SECRET.replace("-", "%2D");
  const rejected = [
    `/ingest/hc-webhook/${encodedPath}`,
    `/ingest/hc-webhook/${hyphenEncoded}`,
    `/ingest/hc-webhook/${URL_SECRET}%20`,
    `/ingest/hc-webhook?token=${encodedPath}`,
    `/ingest/hc-webhook?token=${URL_SECRET}%20`,
    `/ingest/hc-webhook?token=%20${URL_SECRET}`,
    `/ingest/hc-webhook?%74oken=${URL_SECRET}`,
  ];
  for (const pathname of rejected) {
    const response = await handleRequest(request(pathname, { token: "", body: "{}" }), environment);
    assert.equal(response.status, 401, pathname);
  }
  for (const pathname of [`/ingest/life-dashboard/${encodedPath}`, `/ingest/life-dashboard/${URL_SECRET}%20`]) {
    const response = await handleRequest(request(pathname, { token: "", body: "{}" }), environment);
    assert.equal(response.status, 401, pathname);
    const authedGone = await handleRequest(request(pathname, { body: "{}" }), environment);
    assert.equal(authedGone.status, 410, pathname);
  }

  const logs = [];
  const original = console.error;
  console.error = (message) => logs.push(String(message));
  try {
    resetUrlTokenWarnings();
    const short = ctx(new MemoryStorage(), { urlToken: "url-secret" });
    assert.equal((await handleRequest(request("/ingest/hc-webhook/url-secret", { token: "", body: "{}" }), short)).status, 401);
    assert.equal((await handleRequest(request(`/ingest/hc-webhook/${URL_SECRET}`, { token: "", body: "{}" }), short)).status, 401);
    assert.equal((await handleRequest(request("/ingest/hc-webhook?token=url-secret", { token: "", body: "{}" }), short)).status, 401);
    assert.equal(logs.join("\n").includes("url-secret"), false);
    assert.ok(logs.some((line) => line.includes("must match ^[A-Za-z0-9_-]{32,}$")));

    resetUrlTokenWarnings();
    logs.length = 0;
    assert.equal(activeUrlToken("", "tok"), "");
    assert.equal(logs.length, 0);

    const reused = await handleRequest(request(`/ingest/hc-webhook/${URL_SECRET}`, { token: "", body: "{}" }), ctx(new MemoryStorage(), { token: URL_SECRET, urlToken: URL_SECRET }));
    assert.equal(reused.status, 401);
    const paddedBearer = await handleRequest(request(`/ingest/hc-webhook?token=${URL_SECRET}`, { token: "", body: "{}" }), ctx(new MemoryStorage(), { token: `  ${URL_SECRET}  `, urlToken: URL_SECRET }));
    assert.equal(paddedBearer.status, 401);
    const warning = logs.join("\n");
    assert.match(warning, /HEALTH_INGEST_URL_TOKEN matches HEALTH_INGEST_TOKEN/);
    assert.equal(warning.includes(URL_SECRET), false);
  } finally {
    console.error = original;
    resetUrlTokenWarnings();
  }
});

test("Health Connect dates and values stay inside a real window", async () => {
  const environment = ctx(new MemoryStorage());
  const postHc = (body) => handleRequest(request("/ingest/hc-webhook", { body: JSON.stringify(body) }), environment);
  const withSteps = (start) => {
    const body = hcBody([4]);
    body.steps = [{ count: 4, start_time: start, end_time: start }];
    return body;
  };
  assert.equal((await postHc(withSteps("2026-13-45T00:00:00Z"))).status, 400);
  assert.equal((await postHc(withSteps("9999-01-01T00:00:00Z"))).status, 400);
  assert.equal((await postHc(withSteps("1999-12-31T00:00:00Z"))).status, 400);
  assert.equal((await postHc(withSteps("2026-02-29T00:00:00Z"))).status, 400);
  assert.equal((await postHc(hcBody([-5]))).status, 400);
  assert.equal((await postHc(hcBody([1e12]))).status, 400);
  const heavy = structuredClone(hcBody([1]));
  heavy.weight = [{ kilograms: 5000, time: "2026-10-14T07:00:00Z" }];
  assert.equal((await handleRequest(request("/ingest/hc-webhook", { body: JSON.stringify(heavy) }), environment)).status, 400);
  const fat = structuredClone(hcBody([1]));
  fat.body_fat = [{ percentage: 250, time: "2026-10-14T07:00:00Z" }];
  assert.equal((await handleRequest(request("/ingest/hc-webhook", { body: JSON.stringify(fat) }), environment)).status, 400);
  const energy = structuredClone(hcBody([1]));
  energy.active_calories = [{ calories: -1, start_time: "2026-10-14T08:00:00Z", end_time: "2026-10-14T09:00:00Z" }];
  assert.equal((await handleRequest(request("/ingest/hc-webhook", { body: JSON.stringify(energy) }), environment)).status, 400);

  const edge = ctx(new MemoryStorage());
  const accepted = structuredClone(hcBody([0]));
  accepted.steps = [{ count: 0, start_time: "2000-01-01T00:00:00Z", end_time: "2000-01-01T01:00:00Z" }];
  accepted.weight = [{ kilograms: 0.5, time: "2000-01-01T00:00:00Z" }];
  accepted.body_fat = [{ percentage: 100, time: "2000-01-01T00:00:00Z" }];
  const low = await handleRequest(request("/ingest/hc-webhook", { body: JSON.stringify(accepted) }), edge);
  assert.equal(low.status, 200);
  assert.equal((await edge.storage.queryDaySummary("2000-01-01")).steps, 0);
  assert.deepEqual((await edge.storage.queryDaySummary("2000-01-01")).weight, { value: 0.5, units: "kg" });
  const future = structuredClone(hcBody([3]));
  future.steps = [{ count: 3, start_time: "2026-10-18T00:00:00Z", end_time: "2026-10-18T01:00:00Z" }];
  assert.equal((await handleRequest(request("/ingest/hc-webhook", { body: JSON.stringify(future) }), edge)).status, 200);
  const beyond = structuredClone(hcBody([3]));
  beyond.steps = [{ count: 3, start_time: "2026-10-19T00:00:00Z", end_time: "2026-10-19T01:00:00Z" }];
  assert.equal((await handleRequest(request("/ingest/hc-webhook", { body: JSON.stringify(beyond) }), edge)).status, 400);
});
