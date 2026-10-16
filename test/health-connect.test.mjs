import assert from "node:assert/strict";
import { test } from "node:test";
import { authed, redactRequestTarget } from "../src/core/auth.js";
import { exerciseName } from "../src/core/health-connect.js";
import { parseHcWebhook } from "../src/core/hc-webhook.js";
import { handleRequest } from "../src/core/http.js";
import { parseLifeDashboard } from "../src/core/life-dashboard.js";
import { MemoryStorage } from "../src/core/memory.js";
import { summaryDate } from "./expected.mjs";

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

function lifeBody({ steps = 9321, daily = true, rawSteps = [1, 2] } = {}) {
  const body = {
    timestamp: "2026-10-16T12:00:00.481Z",
    app_version: "1.23.0",
    source: "health_connect",
    sequence: 1842,
    steps: rawSteps.map((count, index) => ({
      uuid: `00000000-0000-4000-8000-00000000000${index}`,
      source: "com.example.watch",
      count,
      start_time: `2026-10-14T${String(8 + index).padStart(2, "0")}:00:00Z`,
      end_time: `2026-10-14T${String(9 + index).padStart(2, "0")}:00:00Z`,
    })),
    heart_rate: [{
      uuid: "00000000-0000-4000-8000-000000000099#1",
      source: "com.example.watch",
      bpm: 61,
      time: "2026-10-14T06:58:00Z",
    }],
    weight: [{ uuid: "00000000-0000-4000-8000-000000000010", source: "com.example.scale", kilograms: 81.7, time: "2026-10-14T07:00:00Z" }],
    body_fat: [{ uuid: "00000000-0000-4000-8000-000000000011", source: "com.example.scale", percentage: 18.4, time: "2026-10-14T07:00:00Z" }],
    nutrition: [{
      uuid: "00000000-0000-4000-8000-000000000012",
      source: "com.example.food",
      calories: 1200.5,
      protein_grams: 40,
      carbs_grams: 120,
      fat_grams: 35,
      dietary_fibre_g: 6.2,
      sodium_mg: 180,
      name: "Synthetic meal",
      meal_type: "breakfast",
      start_time: "2026-10-14T08:00:00Z",
      end_time: "2026-10-14T08:20:00Z",
    }],
    basal_metabolic_rate: [{ uuid: "00000000-0000-4000-8000-000000000013", source: "com.example.watch", kilocalories_per_day: 1750, time: "2026-10-14T00:00:00Z" }],
    exercise: [
      { uuid: "00000000-0000-4000-8000-000000000014", source: "com.example.watch", type: "56", start_time: "2026-10-14T17:30:00Z", end_time: "2026-10-14T18:15:00Z", duration_seconds: 2700, segments: [{ type: "51", start_time: "2026-10-14T17:30:00Z", end_time: "2026-10-14T17:31:00Z", repetitions: 5 }] },
      { uuid: "00000000-0000-4000-8000-000000000015", source: "com.example.watch", type: "running", start_time: "2026-10-14T19:00:00Z", end_time: "2026-10-14T19:20:00Z", duration_seconds: 1200 },
    ],
    sleep: [{
      uuid: "00000000-0000-4000-8000-000000000016",
      source: "com.example.watch",
      session_end_time: "2026-10-14T06:30:00Z",
      duration_seconds: 28800,
      stages: [],
    }],
  };
  if (daily) {
    body.daily_totals = [{
      date: summaryDate,
      steps,
      distance_meters: 7100,
      active_calories: 500,
      total_calories: 2250,
    }];
  }
  return body;
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
  const disabledPath = await handleRequest(request("/ingest/life-dashboard/tok", { token: "", body: JSON.stringify(lifeBody({ steps: 9, rawSteps: [] })) }), off);
  assert.equal(disabledPath.status, 401);
  assert.equal(authed(new Request("http://localhost/ingest/hc-webhook?token=url-secret", { method: "POST" }), { HEALTH_INGEST_TOKEN: "tok" }), false);
  assert.equal(authed(new Request("http://localhost/ingest/hc-webhook?token=url-secret", { method: "POST" }), ""), false);
  assert.equal(authed(new Request("http://localhost/ingest/hc-webhook?token=url-secret", { method: "POST" }), { HEALTH_INGEST_TOKEN: "", HEALTH_INGEST_URL_TOKEN: "" }), false);
  assert.equal(authed(new Request("http://localhost/ingest/hc-webhook?token=url-secret", { method: "POST" }), { HEALTH_INGEST_URL_TOKEN: "   " }), false);

  const environment = ctx(storage, { urlToken: "url-secret" });
  const mainAsUrl = await handleRequest(request("/ingest/hc-webhook?token=tok", { token: "", body: JSON.stringify(hcBody([9])) }), environment);
  assert.equal(mainAsUrl.status, 401);
  const wrongQuery = await handleRequest(request("/ingest/hc-webhook?token=nope", { token: "", body: "{}" }), environment);
  assert.equal(wrongQuery.status, 401);
  const basic = new Request("http://localhost/ingest/hc-webhook?token=url-secret", {
    method: "POST",
    headers: { authorization: "Basic url-secret", "content-type": "application/json" },
    body: "{}",
  });
  assert.equal((await handleRequest(basic, environment)).status, 401);
  const urlAsBearer = await handleRequest(request("/ingest/hc-webhook", { token: "url-secret", body: JSON.stringify(hcBody([9])) }), environment);
  assert.equal(urlAsBearer.status, 401);

  const query = await handleRequest(request("/ingest/hc-webhook?token=url-secret", { token: "", body: JSON.stringify(hcBody([9])) }), environment);
  assert.equal(query.status, 200);
  assert.equal((await storage.queryDaySummary(summaryDate)).steps, 9);
  const path = await handleRequest(request("/ingest/hc-webhook/url-secret", { token: "", body: JSON.stringify(hcBody([9, 1])) }), environment);
  assert.equal(path.status, 200);
  assert.equal((await storage.queryDaySummary(summaryDate)).steps, 10);
  const life = await handleRequest(request("/ingest/life-dashboard/url-secret", { token: "", body: JSON.stringify(lifeBody({ steps: 11, rawSteps: [] })) }), ctx(new MemoryStorage(), { urlToken: "url-secret" }));
  assert.equal(life.status, 200);

  const summaryUrl = await handleRequest(request(`/summary?date=${summaryDate}&token=url-secret`, { method: "GET", token: "" }), environment);
  assert.equal(summaryUrl.status, 401);
  const summaryBearer = await handleRequest(request(`/summary?date=${summaryDate}`, { method: "GET", token: "url-secret" }), environment);
  assert.equal(summaryBearer.status, 401);
  const mcpUrl = await handleRequest(request("/mcp?token=url-secret", { method: "POST", token: "", body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' }), environment);
  assert.equal(mcpUrl.status, 401);
  const mcpBearer = await handleRequest(request("/mcp", { method: "POST", token: "url-secret", body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' }), environment);
  assert.equal(mcpBearer.status, 401);
  const ingest = await handleRequest(request("/ingest?token=url-secret", { token: "", body: "{}" }), environment);
  assert.equal(ingest.status, 401);
  const syncfit = await handleRequest(request("/ingest/syncfit?token=url-secret", { token: "", body: "{}" }), environment);
  assert.equal(syncfit.status, 401);
  const readMethod = await handleRequest(request("/ingest/hc-webhook?token=url-secret", { method: "GET", token: "" }), environment);
  assert.equal(readMethod.status, 401);

  const summary = await handleRequest(request(`/summary?date=${summaryDate}`, { method: "GET" }), environment);
  assert.equal(summary.status, 200);
  assert.equal((await summary.json()).steps, 10);
});

test("Life Dashboard uses daily totals and a same-size resend replaces the running total", async () => {
  const parsed = parseLifeDashboard(lifeBody());
  assert.equal(parsed.points.filter((point) => point.metric === "step_count").reduce((sum, point) => sum + point.qty, 0), 9321);
  assert.equal(parsed.points.filter((point) => point.metric === "step_count").length, 1);
  assert.deepEqual(parsed.workouts.map((workout) => [workout.name, workout.kcal]), [["Running", null], ["Running", null]]);

  const storage = new MemoryStorage();
  const environment = ctx(storage);
  const response = await handleRequest(request("/ingest/life-dashboard", { body: JSON.stringify(lifeBody()) }), environment);
  assert.equal(response.status, 200);
  const summary = await storage.queryDaySummary(summaryDate);
  assert.equal(summary.steps, 9321);
  assert.equal(summary.active_kcal, 500);
  assert.equal(summary.basal_kcal, 1750);
  assert.equal(summary.dietary_kcal, 1200.5);
  assert.deepEqual(summary.weight, { value: 81.7, units: "kg" });
  assert.equal(summary.body_fat_pct, 18.4);
  assert.equal(summary.workouts[0].name, "Running");
  assert.equal((await storage.listMetrics()).includes("dietary_fibre_g"), false);
  assert.equal((await storage.listMetrics()).includes("distance"), false);
  assert.equal(storage.payloads.length, 0);

  const updated = await handleRequest(request("/ingest/life-dashboard", { body: JSON.stringify(lifeBody({ steps: 10000 })) }), environment);
  assert.equal(updated.status, 200);
  assert.equal((await storage.queryDaySummary(summaryDate)).steps, 10000);

  const rawOnly = lifeBody({ daily: false, rawSteps: [4000, 5321] });
  const rawStorage = new MemoryStorage();
  await handleRequest(request("/ingest/life-dashboard", { body: JSON.stringify(rawOnly) }), ctx(rawStorage));
  assert.equal((await rawStorage.queryDaySummary(summaryDate)).steps, 9321);
  const partial = lifeBody({ daily: false, rawSteps: [5] });
  await handleRequest(request("/ingest/life-dashboard", { body: JSON.stringify(partial) }), ctx(rawStorage));
  assert.equal((await rawStorage.queryDaySummary(summaryDate)).steps, 9321);
  const dailyAfterRaw = lifeBody({ steps: 10000, rawSteps: [] });
  await handleRequest(request("/ingest/life-dashboard", { body: JSON.stringify(dailyAfterRaw) }), ctx(rawStorage));
  assert.equal((await rawStorage.queryDaySummary(summaryDate)).steps, 9321);

  const buckets = {
    timestamp: "2026-10-16T12:00:00Z",
    app_version: "1.23.0",
    source: "health_connect",
    sequence: 9,
    _resolutions: { steps: "1h", heart_rate: "1m" },
    steps: [{ bucket_start: "2026-10-14T08:00:00Z", bucket_end: "2026-10-14T09:00:00Z", sample_count: 12, total: 1840, complete: true }],
    heart_rate: [{ bucket_start: "2026-10-14T08:00:00Z", bucket_end: "2026-10-14T08:01:00Z", sample_count: 58, avg: 72.4, min: 66, max: 81, sources: ["com.example.watch"] }],
  };
  const bucketStorage = new MemoryStorage();
  await handleRequest(request("/ingest/life-dashboard", { body: JSON.stringify(buckets) }), ctx(bucketStorage, { metricAllowlist: "heart_rate" }));
  assert.equal((await bucketStorage.queryDaySummary(summaryDate)).steps, 1840);
  assert.equal((await bucketStorage.queryMetricRange("heart_rate", summaryDate, summaryDate))[0].sum_qty, 72.4);
});

test("Life Dashboard route keeps Health Auto Export on /ingest and rejects screen time", async () => {
  const storage = new MemoryStorage();
  const environment = ctx(storage);
  const ingested = await handleRequest(request("/ingest", { body: JSON.stringify(lifeBody()) }), environment);
  assert.equal(ingested.status, 200);
  assert.equal((await storage.queryDaySummary(summaryDate)).steps, 9321);

  const hc = new MemoryStorage();
  const hcResponse = await handleRequest(request("/ingest", { body: JSON.stringify(hcBody()) }), ctx(hc));
  assert.equal(hcResponse.status, 200);
  assert.equal((await hc.queryDaySummary(summaryDate)).steps, 9321);

  const ping = await handleRequest(request("/ingest/life-dashboard", {
    body: JSON.stringify({
      test: true,
      message: "Test ping from Life Dashboard Companion",
      timestamp: "2026-10-16T12:00:00Z",
      app_version: "1.23.0",
      source: "health_connect",
    }),
  }), environment);
  assert.equal(ping.status, 200);
  assert.equal((await ping.json()).points, 0);
  assert.equal((await storage.queryDaySummary(summaryDate)).steps, 9321);

  const deleted = await handleRequest(request("/ingest/life-dashboard", {
    body: JSON.stringify({
      timestamp: "2026-10-16T12:05:00Z",
      app_version: "1.23.0",
      source: "health_connect",
      sequence: 1843,
      deleted_records: [{ type: "steps", uuid: "00000000-0000-4000-8000-000000000000" }],
    }),
  }), environment);
  assert.equal(deleted.status, 200);
  assert.equal((await storage.queryDaySummary(summaryDate)).steps, 9321);

  const screen = await handleRequest(request("/ingest/life-dashboard", {
    body: JSON.stringify({
      timestamp: "2026-10-16T12:00:00Z",
      app_version: "1.23.0",
      source: "screen_time",
      sequence: 3,
      screen_time: [{ date: summaryDate, total_screen_time_minutes: 10, apps: [] }],
    }),
  }), environment);
  assert.equal(screen.status, 400);

  const zoned = new MemoryStorage();
  await handleRequest(request("/ingest/life-dashboard", {
    body: JSON.stringify({
      timestamp: "2026-10-16T12:00:00Z",
      app_version: "1.23.0",
      source: "health_connect",
      sequence: 4,
      steps: [{
        uuid: "00000000-0000-4000-8000-000000000020",
        source: "com.example.watch",
        count: 6,
        start_time: "2026-10-14T18:00:00Z",
        end_time: "2026-10-14T19:00:00Z",
        metadata: { zone_offset: "+10:00", recording_method: "automatic", last_modified: "2026-10-14T19:00:00Z" },
      }],
    }),
  }), ctx(zoned, { timeZone: "UTC" }));
  assert.equal((await zoned.queryDaySummary("2026-10-15")).steps, 6);

  const fallback = new MemoryStorage();
  await handleRequest(request("/ingest/life-dashboard", {
    body: JSON.stringify({
      timestamp: "2026-10-16T12:00:00Z",
      app_version: "1.23.0",
      source: "healthkit_ios",
      sequence: 5,
      steps: [{ count: 4, start_time: "2026-10-15T05:00:00Z", end_time: "2026-10-15T06:00:00Z", uuid: "a", source: "Watch" }],
    }),
  }), ctx(fallback, { timeZone: "America/Los_Angeles" }));
  assert.equal((await fallback.queryDaySummary("2026-10-14")).steps, 4);

  const denied = await handleRequest(request("/ingest/life-dashboard/nope", { token: "", body: "{}" }), environment);
  assert.equal(denied.status, 401);
  const unset = await handleRequest(request("/ingest/life-dashboard/tok", { token: "", body: JSON.stringify(lifeBody({ steps: 11, rawSteps: [] })) }), ctx(new MemoryStorage()));
  assert.equal(unset.status, 401);
});
