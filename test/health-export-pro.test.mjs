import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { handleRequest } from "../src/core/http.js";
import { isHealthExportPro, parseHealthExportPro } from "../src/core/health-export-pro.js";
import { MemoryStorage } from "../src/core/memory.js";
import { expectedSummary, summaryDate } from "./expected.mjs";

const sample = JSON.parse(fs.readFileSync(new URL("./sample.json", import.meta.url), "utf8"));

function request(pathname, { method = "POST", token = "tok", body } = {}) {
  const headers = new Headers();
  if (token) headers.set("authorization", /^bearer\s/i.test(token) ? token : `Bearer ${token}`);
  if (body != null) headers.set("content-type", "application/json");
  return new Request(`http://localhost${pathname}`, {
    method,
    headers,
    body: body == null ? undefined : body,
  });
}

function ctx(storage = new MemoryStorage(), extra = {}) {
  return { token: "tok", timeZone: "UTC", storage, now: new Date("2026-10-16T12:00:00Z"), ingestMaxAgeDays: 36500, ingestRatePerHour: 0, ...extra };
}

function sampleAt(qty, unit, start) {
  return {
    uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    value: qty,
    unit,
    startDate: start,
    endDate: start,
  };
}

function exportBody(steps = [4000, 5321]) {
  return {
    exportDate: "2026-10-16T12:00:00.000Z",
    startDate: "2026-10-14T00:00:00-07:00",
    endDate: "2026-10-15T00:00:00-07:00",
    syncSource: "background-delivery",
    characteristics: { biologicalSex: "notSet" },
    data: {
      HKQuantityTypeIdentifierDietaryEnergyConsumed: [sampleAt(1200.5, "kcal", "2026-10-14 08:00:00 -0700")],
      HKQuantityTypeIdentifierDietaryProtein: [sampleAt(40, "g", "2026-10-14 08:00:00 -0700")],
      HKQuantityTypeIdentifierDietaryCarbohydrates: [sampleAt(120, "g", "2026-10-14 08:00:00 -0700")],
      HKQuantityTypeIdentifierDietaryFatTotal: [sampleAt(35, "g", "2026-10-14 08:00:00 -0700")],
      HKQuantityTypeIdentifierActiveEnergyBurned: [sampleAt(2092, "kJ", "2026-10-14 09:00:00 -0700")],
      HKQuantityTypeIdentifierBasalEnergyBurned: [sampleAt(1750, "kcal", "2026-10-14 00:00:00 -0700")],
      HKQuantityTypeIdentifierStepCount: steps.map((qty, index) => sampleAt(qty, "count", `2026-10-14 ${String(9 + index).padStart(2, "0")}:00:00 -0700`)),
      HKQuantityTypeIdentifierBodyMass: [sampleAt(180.2, "lb", "2026-10-14 07:00:00 -0700")],
      HKQuantityTypeIdentifierBodyFatPercentage: [sampleAt(0.184, "%", "2026-10-14 07:00:00 -0700")],
      HKQuantityTypeIdentifierHeartRate: [sampleAt(60, "count/min", "2026-10-14 09:00:00 -0700")],
      HKCategoryTypeIdentifierSleepAnalysis: [{ uuid: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", value: 1, startDate: "2026-10-14 00:00:00 -0700", endDate: "2026-10-14 06:00:00 -0700" }],
      workouts: [{
        uuid: "cccccccc-cccc-cccc-cccc-cccccccccccc",
        workoutActivityType: 50,
        durationSeconds: 2700,
        startDate: "2026-10-14 17:30:00 -0700",
        endDate: "2026-10-14 18:15:00 -0700",
        totalEnergyBurned: 310,
      }],
      medicationDoseEvents: [{ uuid: "dddddddd-dddd-dddd-dddd-dddddddddddd", startDate: "2026-10-14 08:00:00 -0700", endDate: "2026-10-14 08:00:00 -0700", medicationName: "Example tablet" }],
      medications: [{ uuid: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", displayName: "Example tablet" }],
    },
    workoutRoutes: { "cccccccc-cccc-cccc-cccc-cccccccccccc": [{ lat: 0, lon: 0 }] },
  };
}

test("Health Export Pro maps quantity types and workout integers", () => {
  const parsed = parseHealthExportPro(exportBody());
  assert.equal(parsed.points.length, 11);
  assert.equal(parsed.points.some((point) => point.metric === "heart_rate"), true);
  assert.equal(parsed.points.some((point) => point.metric === "sleep_analysis"), false);
  const active = parsed.points.find((point) => point.metric === "active_energy");
  assert.equal(active.qty, 500);
  assert.equal(active.units, "kcal");
  assert.deepEqual(parsed.workouts[0], {
    name: "Traditional Strength Training",
    start: "2026-10-14 17:30:00 -0700",
    date: summaryDate,
    duration_min: 45,
    kcal: 310,
  });
  assert.equal(parseHealthExportPro({
    exportDate: "2026-10-16T00:00:00Z",
    startDate: "2026-10-14T00:00:00Z",
    endDate: "2026-10-15T00:00:00Z",
    syncSource: "widget",
    data: {
      workouts: [
        { workoutActivityType: 37, durationSeconds: 1800, startDate: "2026-10-14T12:00:00Z", endDate: "2026-10-14T12:30:00Z", totalEnergyBurned: 150 },
        { workoutActivityType: 52, durationSeconds: 600, startDate: "2026-10-14T13:00:00Z", endDate: "2026-10-14T13:10:00Z" },
      ],
    },
  }).workouts.map((workout) => workout.name).join(","), "Running,Walking");
});

test("POST /ingest detects Health Export Pro and still accepts Health Auto Export", async () => {
  assert.equal(isHealthExportPro(sample), false);
  assert.equal(isHealthExportPro(exportBody()), true);
  const storage = new MemoryStorage();
  const environment = ctx(storage);
  const ingested = await handleRequest(request("/ingest", { body: JSON.stringify(exportBody()) }), environment);
  assert.equal(ingested.status, 200);
  assert.equal((await ingested.json()).workouts, 1);
  assert.deepEqual(await storage.queryDaySummary(summaryDate), expectedSummary);
  assert.equal((await storage.listMetrics()).includes("heart_rate"), false);

  const hae = new MemoryStorage();
  const haeResponse = await handleRequest(request("/ingest", { body: JSON.stringify(sample) }), ctx(hae));
  assert.equal(haeResponse.status, 200);
  assert.deepEqual(await hae.queryDaySummary(summaryDate), expectedSummary);

  const disguised = {
    exportDate: "2026-10-16T00:00:00Z",
    startDate: "2026-10-14T00:00:00Z",
    endDate: "2026-10-15T00:00:00Z",
    syncSource: "manual-upload",
    data: { metrics: [{ name: "step_count", units: "count", data: [{ date: "2026-10-14 09:00:00 -0700", qty: 12 }] }] },
  };
  assert.equal(isHealthExportPro(disguised), false);
  const asHae = new MemoryStorage();
  const kept = await handleRequest(request("/ingest", { body: JSON.stringify(disguised) }), ctx(asHae));
  assert.equal(kept.status, 200);
  assert.equal((await asHae.queryDaySummary(summaryDate)).steps, 12);
});

test("explicit Health Export Pro route rejects the wrong shape and enforces the daily upsert", async () => {
  const storage = new MemoryStorage();
  const environment = ctx(storage);
  const denied = await handleRequest(request("/ingest/health-export-pro", { token: "", body: "{}" }), environment);
  assert.equal(denied.status, 401);

  const response = await handleRequest(request("/ingest/health-export-pro", { body: JSON.stringify(exportBody()) }), environment);
  assert.equal(response.status, 200);
  assert.equal((await storage.queryDaySummary(summaryDate)).steps, 9321);
  const alias = await handleRequest(request("/api/health-data", { body: JSON.stringify(exportBody()) }), environment);
  assert.equal(alias.status, 404);

  const shorter = exportBody([5]);
  const ignored = await handleRequest(request("/ingest/health-export-pro", { body: JSON.stringify(shorter) }), environment);
  assert.equal(ignored.status, 200);
  assert.equal((await storage.queryDaySummary(summaryDate)).steps, 9321);

  const replaced = exportBody([100, 50]);
  const again = await handleRequest(request("/ingest/health-export-pro", { body: JSON.stringify(replaced) }), environment);
  assert.equal(again.status, 200);
  assert.equal((await storage.queryDaySummary(summaryDate)).steps, 150);

  const haeOnExplicit = await handleRequest(request("/ingest/health-export-pro", { body: JSON.stringify(sample) }), environment);
  assert.equal(haeOnExplicit.status, 400);
  const broken = exportBody();
  broken.data.HKQuantityTypeIdentifierStepCount = {};
  const invalid = await handleRequest(request("/ingest/health-export-pro", { body: JSON.stringify(broken) }), environment);
  assert.equal(invalid.status, 400);

  const zoned = new MemoryStorage();
  await handleRequest(request("/ingest", {
    body: JSON.stringify({
      exportDate: "2026-10-16T00:00:00Z",
      startDate: "2026-10-14T00:00:00Z",
      endDate: "2026-10-15T00:00:00Z",
      syncSource: "manual-upload",
      data: {
        HKQuantityTypeIdentifierStepCount: [sampleAt(8, "count", "2026-10-15T05:00:00Z")],
      },
    }),
  }), ctx(zoned, { timeZone: "America/Los_Angeles" }));
  assert.equal((await zoned.queryDaySummary("2026-10-14")).steps, 8);
});
