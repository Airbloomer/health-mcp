import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { handleRequest } from "../src/core/http.js";
import { MemoryStorage } from "../src/core/memory.js";
import { isSyncFit, parseSyncFit } from "../src/core/syncfit.js";
import { summaryDate } from "./expected.mjs";

const sample = JSON.parse(fs.readFileSync(new URL("./sample.json", import.meta.url), "utf8"));

function request(pathname, { method = "POST", token = "tok", body } = {}) {
  const headers = new Headers();
  if (token) headers.set("authorization", /^bearer\s/i.test(token) ? token : `Bearer ${token}`);
  if (body != null) headers.set("content-type", "application/json");
  return new Request(`http://localhost${pathname}`, { method, headers, body });
}

function ctx(storage = new MemoryStorage(), extra = {}) {
  return { token: "tok", timeZone: "UTC", storage, now: new Date("2026-10-16T12:00:00Z"), ...extra };
}

function point(metric, value, unit, start, extra = {}) {
  return {
    id: `00000000-0000-4000-8000-${metric.replaceAll("_", "").padEnd(12, "0").slice(0, 12)}`,
    metric,
    start,
    end: start,
    value,
    unit,
    aggregation: "raw",
    ...extra,
  };
}

function exportBody(steps = [4000, 5321]) {
  return {
    schemaVersion: 1,
    samples: [
      point("dietary_energy_consumed", 1200.5, "kcal", "2026-10-14T08:00:00-07:00"),
      point("dietary_protein", 40, "g", "2026-10-14T08:00:00-07:00"),
      point("dietary_carbohydrates", 120, "g", "2026-10-14T08:00:00-07:00"),
      point("dietary_fat_total", 35, "g", "2026-10-14T08:00:00-07:00"),
      point("active_energy", 2092, "kJ", "2026-10-14T09:00:00-07:00"),
      point("basal_energy", 1750, "kcal", "2026-10-14T00:00:00-07:00"),
      ...steps.map((qty, index) => point("step_count", qty, "count", `2026-10-14T${String(9 + index).padStart(2, "0")}:00:00-07:00`, { id: `00000000-0000-4000-8000-00000000000${index}` })),
      point("body_mass", 180.2, "lb", "2026-10-14T07:00:00-07:00"),
      point("body_fat_percentage", 18.4, "%", "2026-10-14T07:00:00-07:00"),
      point("heart_rate", 60, "count/min", "2026-10-14T09:00:00-07:00"),
      point("sleep_analysis", 1, "count", "2026-10-14T00:00:00-07:00"),
      {
        id: "00000000-0000-4000-8000-000000000099",
        metric: "workout",
        start: "2026-10-14T17:30:00-07:00",
        end: "2026-10-14T18:15:00-07:00",
        value: 2700,
        unit: "s",
        aggregation: "raw",
        details: {
          activityType: 50,
          totalEnergy: 310,
          route: [{ lat: 0, lon: 0 }],
        },
      },
    ],
  };
}

test("SyncFit maps native metrics and workout details", () => {
  const parsed = parseSyncFit(exportBody());
  assert.equal(parsed.points.find((row) => row.metric === "active_energy").qty, 500);
  assert.equal(parsed.points.find((row) => row.metric === "basal_energy_burned").qty, 1750);
  assert.equal(parsed.points.find((row) => row.metric === "weight_body_mass").units, "lb");
  assert.equal(parsed.points.find((row) => row.metric === "protein").qty, 40);
  assert.equal(parsed.points.some((row) => row.metric === "heart_rate"), true);
  assert.deepEqual(parsed.workouts[0], {
    name: "Traditional Strength Training",
    start: "2026-10-14T17:30:00-07:00",
    date: summaryDate,
    duration_min: 45,
    kcal: 310,
  });
  const names = parseSyncFit({
    schemaVersion: 1,
    samples: [
      { id: "a", metric: "workout", start: "2026-10-14T12:00:00Z", value: 1800, unit: "s", details: { activityType: 37, totalEnergy: 150 } },
      { id: "b", metric: "workout", start: "2026-10-14T13:00:00Z", value: 600, unit: "s", details: { activityType: 52 } },
    ],
  }).workouts.map((workout) => workout.name);
  assert.deepEqual(names, ["Running", "Walking"]);

  const collapsed = parseSyncFit({
    schemaVersion: 1,
    samples: [
      point("step_count", 1, "count", "2026-10-14T09:00:00-07:00", { id: "00000000-0000-4000-8000-000000000001" }),
      point("step_count", 4, "count", "2026-10-14T09:00:00-07:00", { id: "00000000-0000-4000-8000-000000000002" }),
    ],
  });
  assert.equal(collapsed.points.length, 2);
  assert.equal(collapsed.points[1].qty, 4);
});

test("POST /ingest detects SyncFit and still accepts Health Auto Export", async () => {
  assert.equal(isSyncFit(sample), false);
  assert.equal(isSyncFit(exportBody()), true);
  const storage = new MemoryStorage();
  const ingested = await handleRequest(request("/ingest", { body: JSON.stringify(exportBody()) }), ctx(storage));
  assert.equal(ingested.status, 200);
  assert.equal((await ingested.json()).workouts, 1);
  const summary = await storage.queryDaySummary(summaryDate);
  assert.equal(summary.dietary_kcal, 1200.5);
  assert.equal(summary.protein_g, 40);
  assert.equal(summary.carbs_g, 120);
  assert.equal(summary.fat_g, 35);
  assert.equal(summary.active_kcal, 500);
  assert.equal(summary.basal_kcal, 1750);
  assert.equal(summary.steps, 9321);
  assert.deepEqual(summary.weight, { value: 180.2, units: "lb" });
  assert.equal(summary.body_fat_pct, 18.4);
  assert.equal(summary.workouts[0].name, "Traditional Strength Training");
  assert.equal(summary.workouts[0].duration_min, 45);
  assert.equal(summary.workouts[0].kcal, 310);
  assert.equal((await storage.listMetrics()).includes("heart_rate"), false);
  assert.equal((await storage.listMetrics()).includes("sleep_analysis"), false);

  const again = await handleRequest(request("/ingest", { body: JSON.stringify(exportBody()) }), ctx(storage));
  assert.equal(again.status, 200);
  assert.equal((await storage.queryDaySummary(summaryDate)).steps, 9321);

  const hae = new MemoryStorage();
  const haeResponse = await handleRequest(request("/ingest", { body: JSON.stringify(sample) }), ctx(hae));
  assert.equal(haeResponse.status, 200);
  assert.equal((await hae.queryDaySummary(summaryDate)).steps, 9321);

  const mixed = new MemoryStorage();
  const mixedBody = { ...sample, schemaVersion: 1, samples: [] };
  const mixedResponse = await handleRequest(request("/ingest", { body: JSON.stringify(mixedBody) }), ctx(mixed));
  assert.equal(mixedResponse.status, 200);
  assert.equal((await mixed.queryDaySummary(summaryDate)).steps, 9321);
});

test("explicit SyncFit route rejects the wrong shape and keeps the fuller day", async () => {
  const storage = new MemoryStorage();
  const environment = ctx(storage);
  const denied = await handleRequest(request("/ingest/syncfit", { token: "", body: "{}" }), environment);
  assert.equal(denied.status, 401);

  const response = await handleRequest(request("/ingest/syncfit", { body: JSON.stringify(exportBody()) }), environment);
  assert.equal(response.status, 200);
  assert.equal((await storage.queryDaySummary(summaryDate)).steps, 9321);
  const alias = await handleRequest(request("/export", { body: JSON.stringify(exportBody()) }), environment);
  assert.equal(alias.status, 404);

  const shorter = exportBody([5]);
  shorter.samples = shorter.samples.map((row) => (row.metric === "step_count" ? { ...row, aggregation: "day" } : row));
  const ignored = await handleRequest(request("/ingest/syncfit", { body: JSON.stringify(shorter) }), environment);
  assert.equal(ignored.status, 200);
  assert.equal((await storage.queryDaySummary(summaryDate)).steps, 9321);

  const replaced = exportBody([100, 50]);
  const again = await handleRequest(request("/ingest/syncfit", { body: JSON.stringify(replaced) }), environment);
  assert.equal(again.status, 200);
  assert.equal((await storage.queryDaySummary(summaryDate)).steps, 150);

  const haeOnExplicit = await handleRequest(request("/ingest/syncfit", { body: JSON.stringify(sample) }), environment);
  assert.equal(haeOnExplicit.status, 400);
  const broken = { schemaVersion: 2, samples: [] };
  const invalid = await handleRequest(request("/ingest", { body: JSON.stringify(broken) }), environment);
  assert.equal(invalid.status, 400);
  const badSample = exportBody();
  badSample.samples[0].value = "1200";
  const bad = await handleRequest(request("/ingest/syncfit", { body: JSON.stringify(badSample) }), environment);
  assert.equal(bad.status, 400);

  const zoned = new MemoryStorage();
  await handleRequest(request("/ingest", {
    body: JSON.stringify({
      schemaVersion: 1,
      samples: [point("step_count", 8, "count", "2026-10-15T05:00:00Z")],
    }),
  }), ctx(zoned, { timeZone: "America/Los_Angeles" }));
  assert.equal((await zoned.queryDaySummary("2026-10-14")).steps, 8);

  const offset = new MemoryStorage();
  await handleRequest(request("/ingest/syncfit", {
    body: JSON.stringify({
      schemaVersion: 1,
      samples: [point("step_count", 3, "count", "2026-10-14T23:30:00+10:00")],
    }),
  }), ctx(offset));
  assert.equal((await offset.queryDaySummary("2026-10-14")).steps, 3);
});
