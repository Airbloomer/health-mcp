import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import { createNodeStorage, startServer } from "../src/adapters/node.js";
import { APPLE_COMPRESSION_RATIO_FLOOR, chunkByDate, createAppleExportParser, parseAppleExport } from "../src/core/apple-export.js";
import { handleRequest } from "../src/core/http.js";
import { hkQuantityMetric, hkWorkoutName } from "../src/core/hk.js";
import { MemoryStorage } from "../src/core/memory.js";
import { MAX_APPLE_EXPORT_BYTES } from "../src/core/metrics.js";
import { expectedSummary, summaryDate } from "./expected.mjs";

const sample = JSON.parse(fs.readFileSync(new URL("./sample.json", import.meta.url), "utf8"));

function request(pathname, { method = "GET", token = "tok", body, headers = {} } = {}) {
  const initHeaders = new Headers(headers);
  if (token) initHeaders.set("authorization", /^bearer\s/i.test(token) ? token : `Bearer ${token}`);
  if (body != null && !initHeaders.has("content-type")) initHeaders.set("content-type", "application/json");
  const init = { method, headers: initHeaders };
  if (body != null) {
    init.body = body;
    if (typeof body !== "string" && body?.getReader) init.duplex = "half";
  }
  return new Request(`http://localhost${pathname}`, init);
}

function ctx(storage = new MemoryStorage(), extra = {}) {
  return { token: "tok", timeZone: "UTC", storage, now: new Date("2026-10-16T12:00:00Z"), ingestMaxAgeDays: 36500, ingestRatePerHour: 0, ...extra };
}

function exportXml({ steps = [4000, 5321], heartRate = true } = {}) {
  const stepRecords = steps
    .map((qty, index) => {
      const hour = String(9 + index).padStart(2, "0");
      return `<Record type="HKQuantityTypeIdentifierStepCount" unit="count" value="${qty}" startDate="2026-10-14 ${hour}:00:00 -0700" endDate="2026-10-14 ${hour}:30:00 -0700"/>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE HealthData [
<!ELEMENT HealthData (Record|Workout)*>
<!ELEMENT Record EMPTY>
<!ATTLIST Record type CDATA #REQUIRED>
]>
<HealthData locale="en_US">
<Record type="HKQuantityTypeIdentifierDietaryEnergyConsumed" unit="kcal" value="1200.5" startDate="2026-10-14 08:00:00 -0700" endDate="2026-10-14 08:00:00 -0700"/>
<Record type="HKQuantityTypeIdentifierDietaryProtein" unit="g" value="40" startDate="2026-10-14 08:00:00 -0700" endDate="2026-10-14 08:00:00 -0700"/>
<Record type="HKQuantityTypeIdentifierDietaryCarbohydrates" unit="g" value="120" startDate="2026-10-14 08:00:00 -0700" endDate="2026-10-14 08:00:00 -0700"/>
<Record type="HKQuantityTypeIdentifierDietaryFatTotal" unit="g" value="35" startDate="2026-10-14 08:00:00 -0700" endDate="2026-10-14 08:00:00 -0700"/>
<Record type="HKQuantityTypeIdentifierActiveEnergyBurned" unit="kJ" value="2092" startDate="2026-10-14 09:00:00 -0700" endDate="2026-10-14 10:00:00 -0700"/>
<Record type="HKQuantityTypeIdentifierBasalEnergyBurned" unit="kcal" value="1750" startDate="2026-10-14 00:00:00 -0700" endDate="2026-10-14 23:00:00 -0700"/>
${stepRecords}
<Record type="HKQuantityTypeIdentifierBodyMass" unit="lb" value="180.2" startDate="2026-10-14 07:00:00 -0700" endDate="2026-10-14 07:00:00 -0700"/>
<Record type="HKQuantityTypeIdentifierBodyFatPercentage" unit="%" value="0.184" startDate="2026-10-14 07:00:00 -0700" endDate="2026-10-14 07:00:00 -0700"/>
${heartRate ? `<Record type="HKQuantityTypeIdentifierHeartRate" unit="count/min" value="60" startDate="2026-10-14 09:00:00 -0700" endDate="2026-10-14 09:00:00 -0700"/>` : ""}
<Workout workoutActivityType="HKWorkoutActivityTypeTraditionalStrengthTraining" duration="45" durationUnit="min" sourceName="Watch &amp; Phone" startDate="2026-10-14 17:30:00 -0700" endDate="2026-10-14 18:15:00 -0700" totalEnergyBurned="310" totalEnergyBurnedUnit="kcal">
<WorkoutStatistics type="HKQuantityTypeIdentifierActiveEnergyBurned" startDate="2026-10-14 17:30:00 -0700" endDate="2026-10-14 18:15:00 -0700" sum="310" unit="kcal"/>
<MetadataEntry key="HKIndoorWorkout" value="1"/>
</Workout>
</HealthData>
`;
}

function zipLocal(name, data, { method = 0, flags = 0, compressed = data } = {}) {
  const nameBytes = Buffer.from(name);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(flags, 6);
  header.writeUInt16LE(method, 8);
  header.writeUInt32LE(0, 14);
  header.writeUInt32LE(compressed.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(nameBytes.length, 26);
  return Buffer.concat([header, nameBytes, compressed]);
}

function exportZip(xml, method = 0) {
  const payload = Buffer.from(xml);
  const compressed = method === 8 ? deflateRawSync(payload) : payload;
  const decoy = zipLocal("apple_health_export/export_cda.xml", Buffer.from("<HealthData><Record type=\"HKQuantityTypeIdentifierStepCount\" unit=\"count\" value=\"1\" startDate=\"2026-10-14 01:00:00 -0700\" endDate=\"2026-10-14 01:00:00 -0700\"/></HealthData>"));
  const entry = zipLocal("apple_health_export/export.xml", payload, { method, compressed });
  const trailer = zipLocal("readme.txt", Buffer.from("ignore"));
  return Buffer.concat([decoy, entry, trailer]);
}

test("HealthKit names map onto summary metrics and workout labels", () => {
  assert.equal(hkQuantityMetric("HKQuantityTypeIdentifierStepCount"), "step_count");
  assert.equal(hkQuantityMetric("HKQuantityTypeIdentifierBodyMass"), "weight_body_mass");
  assert.equal(hkQuantityMetric("HKQuantityTypeIdentifierHeartRate"), "heart_rate");
  assert.equal(hkQuantityMetric("HKCategoryTypeIdentifierSleepAnalysis"), null);
  assert.equal(hkWorkoutName("HKWorkoutActivityTypeTraditionalStrengthTraining"), "Traditional Strength Training");
  assert.equal(hkWorkoutName(37), "Running");
  assert.equal(hkWorkoutName(50), "Traditional Strength Training");
  assert.equal(hkWorkoutName(52), "Walking");
  assert.equal(hkWorkoutName(999), "Workout 999");
});

test("a chunked export.xml matches the daily summary and collapses duplicate timestamps", async () => {
  const duplicates = `<HealthData>
<Record type="HKQuantityTypeIdentifierStepCount" unit="count" value="1" startDate="2026-10-14 09:00:00 -0700" endDate="2026-10-14 09:00:00 -0700"/>
<Record type="HKQuantityTypeIdentifierStepCount" unit="count" value="4" startDate="2026-10-14 09:00:00 -0700" endDate="2026-10-14 09:00:00 -0700"/>
<Record type="HKQuantityTypeIdentifierStepCount" unit="count" value="6" startDate="2026-10-14 10:00:00 -0700" endDate="2026-10-14 10:00:00 -0700"/>
</HealthData>`;
  const collapsed = await parseAppleExport(duplicates);
  assert.equal(collapsed.samples, 3);
  assert.equal(collapsed.points[0].n, 2);
  assert.equal(collapsed.points[0].sum_qty, 10);
  assert.equal(collapsed.points[0].last_qty, 6);

  const xml = exportXml();
  const parser = createAppleExportParser({ timeZone: "UTC" });
  for (let index = 0; index < xml.length; index += 3) parser.push(xml.slice(index, index + 3));
  const parsed = parser.finish();
  const steps = parsed.points.find((point) => point.metric === "step_count");
  assert.equal(steps.n, 2);
  assert.equal(steps.sum_qty, 9321);
  assert.equal(parsed.samples, 10);
  assert.equal(parsed.workouts[0].name, "Traditional Strength Training");
  assert.equal(parsed.workouts[0].duration_min, 45);
  assert.equal(parsed.workouts[0].kcal, 310);
  assert.equal(parsed.points.some((point) => point.metric === "heart_rate"), false);

  const storage = new MemoryStorage();
  const ingested = await handleRequest(request("/ingest", { method: "POST", body: xml, headers: { "content-type": "application/xml" } }), ctx(storage));
  assert.equal(ingested.status, 200);
  assert.equal((await ingested.json()).points, 10);
  assert.deepEqual(await storage.queryDaySummary(summaryDate), expectedSummary);
  assert.deepEqual(await storage.listMetrics(), [
    "active_energy",
    "basal_energy_burned",
    "body_fat_percentage",
    "carbohydrates",
    "dietary_energy",
    "protein",
    "step_count",
    "total_fat",
    "weight_body_mass",
  ]);
});

test("POST /ingest still accepts Health Auto Export JSON", async () => {
  const storage = new MemoryStorage();
  const ingested = await handleRequest(request("/ingest", { method: "POST", body: JSON.stringify(sample) }), ctx(storage));
  assert.equal(ingested.status, 200);
  assert.deepEqual(await storage.queryDaySummary(summaryDate), expectedSummary);
});

test("a shorter export does not replace a fuller day", async () => {
  const storage = new MemoryStorage();
  const environment = ctx(storage);
  const first = await handleRequest(request("/ingest", { method: "POST", body: exportXml() }), environment);
  assert.equal(first.status, 200);
  const second = await handleRequest(request("/ingest", { method: "POST", body: exportXml({ steps: [5], heartRate: false }) }), environment);
  assert.equal(second.status, 200);
  const summary = await storage.queryDaySummary(summaryDate);
  assert.equal(summary.steps, 9321);
  const sameCount = exportXml({ steps: [100, 50], heartRate: false });
  const third = await handleRequest(request("/ingest", { method: "POST", body: sameCount }), environment);
  assert.equal(third.status, 200);
  assert.equal((await storage.queryDaySummary(summaryDate)).steps, 150);
});

test("zip entries named export.xml are inflated and other entries are ignored", async () => {
  for (const method of [0, 8]) {
    const parsed = await parseAppleExport(exportZip(exportXml(), method));
    assert.equal(parsed.points.find((point) => point.metric === "step_count").sum_qty, 9321);
    assert.equal(parsed.workouts.length, 1);
  }
  const descriptor = zipLocal("export.xml", Buffer.from("<HealthData></HealthData>"), { flags: 0x8 });
  await assert.rejects(() => parseAppleExport(descriptor), { code: "UNSUPPORTED_ZIP" });
  const missing = zipLocal("apple_health_export/export_cda.xml", Buffer.from("<HealthData></HealthData>"));
  await assert.rejects(() => parseAppleExport(missing), { code: "INVALID_EXPORT" });
});

test("streaming import, chunk upload, and allowlist", async () => {
  const storage = new MemoryStorage();
  const environment = ctx(storage);
  const denied = await handleRequest(request("/import/apple-health", { method: "POST", token: "", body: exportXml() }), environment);
  assert.equal(denied.status, 401);

  const xml = new TextEncoder().encode(exportXml());
  const stream = new ReadableStream({
    start(controller) {
      for (let index = 0; index < xml.length; index += 5) controller.enqueue(xml.subarray(index, index + 5));
      controller.close();
    },
  });
  const imported = await handleRequest(request("/import/apple-health", { method: "POST", body: stream, headers: { "content-type": "application/octet-stream" } }), environment);
  assert.equal(imported.status, 200);
  assert.deepEqual(await storage.queryDaySummary(summaryDate), expectedSummary);

  const plain = await handleRequest(request("/ingest", { method: "POST", body: "<html></html>" }), environment);
  assert.equal(plain.status, 400);
  assert.equal((await plain.json()).error, "invalid_payload");

  const zipped = await handleRequest(request("/ingest", { method: "POST", body: exportZip(exportXml()), headers: { "content-type": "application/zip" } }), ctx(new MemoryStorage()));
  assert.equal(zipped.status, 200);

  const heart = `<HealthData><Record type="HKQuantityTypeIdentifierHeartRate" unit="count/min" value="61" startDate="2026-10-14 09:00:00 -0700" endDate="2026-10-14 09:00:00 -0700"/></HealthData>`;
  const dropped = await handleRequest(request("/ingest", { method: "POST", body: heart }), environment);
  assert.equal((await dropped.json()).points, 0);
  const kept = await handleRequest(request("/ingest", { method: "POST", body: heart }), ctx(new MemoryStorage(), { metricAllowlist: "heart_rate" }));
  assert.equal((await kept.json()).points, 1);

  const losAngeles = `<HealthData><Record type="HKQuantityTypeIdentifierStepCount" unit="count" value="8" startDate="2026-10-15T05:00:00Z" endDate="2026-10-15T05:00:00Z"/></HealthData>`;
  const zoned = new MemoryStorage();
  await handleRequest(request("/ingest", { method: "POST", body: losAngeles }), ctx(zoned, { timeZone: "America/Los_Angeles" }));
  assert.equal((await zoned.queryDaySummary("2026-10-14")).steps, 8);

  const parsed = await parseAppleExport(exportXml());
  const chunks = chunkByDate(parsed.points, parsed.workouts, 1);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].points.length, parsed.points.length);
  const chunkStorage = new MemoryStorage();
  const chunked = await handleRequest(request("/import/apple-health/chunk", { method: "POST", body: JSON.stringify(chunks[0]) }), ctx(chunkStorage));
  assert.equal(chunked.status, 200);
  assert.equal((await chunked.json()).points, parsed.samples);
  assert.deepEqual(await chunkStorage.queryDaySummary(summaryDate), expectedSummary);

  const shorter = {
    points: [{ metric: "step_count", date: summaryDate, sum_qty: 5, last_qty: 5, last_ts: "2026-10-14 09:00:00 -0700", units: "count", n: 1 }],
    workouts: [],
  };
  const ignored = await handleRequest(request("/import/apple-health/chunk", { method: "POST", body: JSON.stringify(shorter) }), ctx(chunkStorage));
  assert.equal(ignored.status, 200);
  assert.equal((await chunkStorage.queryDaySummary(summaryDate)).steps, 9321);

  const bad = await handleRequest(request("/import/apple-health/chunk", { method: "POST", body: JSON.stringify({ points: [{ metric: "step_count", date: summaryDate, sum_qty: 1, last_qty: 1, last_ts: "t", n: 0 }] }) }), ctx(chunkStorage));
  assert.equal(bad.status, 400);
  const duplicate = await handleRequest(request("/import/apple-health/chunk", {
    method: "POST",
    body: JSON.stringify({
      points: [shorter.points[0], shorter.points[0]],
      workouts: [],
    }),
  }), ctx(chunkStorage));
  assert.equal(duplicate.status, 400);
});

test("thousands of records collapse to one row per day", async () => {
  let xml = "<HealthData>\n";
  for (let index = 0; index < 3000; index += 1) {
    const day = String(1 + (index % 3)).padStart(2, "0");
    const minute = Math.floor(index / 3);
    const hour = String(Math.floor(minute / 60)).padStart(2, "0");
    const min = String(minute % 60).padStart(2, "0");
    xml += `<Record type="HKQuantityTypeIdentifierStepCount" unit="count" value="${index + 1}" startDate="2026-10-${day} ${hour}:${min}:00 -0700" endDate="2026-10-${day} ${hour}:${min}:30 -0700"/>\n`;
  }
  xml += "</HealthData>\n";
  const parsed = await parseAppleExport(xml);
  assert.equal(parsed.points.length, 3);
  assert.deepEqual(parsed.points.map((point) => point.n), [1000, 1000, 1000]);
  const first = parsed.points.find((point) => point.date === "2026-10-01");
  assert.equal(first.sum_qty, 1499500);
  assert.equal(first.n, 1000);
});

test("the CLI writes SQLite and can post whole-date chunks", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "apple-export-"));
  const xmlPath = path.join(dir, "export.xml");
  const first = exportXml();
  const second = exportXml().replaceAll("2026-10-14", "2026-10-15");
  const secondRecords = second.slice(second.indexOf("<Record"), second.lastIndexOf("</HealthData>"));
  fs.writeFileSync(xmlPath, first.replace("</HealthData>", `${secondRecords}</HealthData>`));
  const direct = path.join(dir, "direct.sqlite");
  const chunkedDb = path.join(dir, "chunk.sqlite");
  const storage = await createNodeStorage({ SQLITE_PATH: chunkedDb });
  const server = await startServer({ storage, token: "tok", timeZone: "UTC", port: 0, host: "127.0.0.1" });
  const { port } = server.address();
  const run = (args, env) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["src/cli/import-apple-health.js", ...args], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: "", ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  try {
    const local = await run([xmlPath], { SQLITE_PATH: direct, HEALTH_TIMEZONE: "UTC" });
    assert.equal(local.code, 0, local.stderr);
    const opened = await createNodeStorage({ SQLITE_PATH: direct });
    assert.equal((await opened.queryDaySummary(summaryDate)).steps, 9321);
    assert.equal((await opened.queryDaySummary("2026-10-15")).steps, 9321);
    await opened.close();

    const remote = await run([
      xmlPath,
      "--chunk-url",
      `http://127.0.0.1:${port}/import/apple-health/chunk`,
      "--token",
      "tok",
      "--dates-per-chunk",
      "1",
      "--time-zone",
      "UTC",
    ]);
    assert.equal(remote.code, 0, remote.stderr);
    const body = JSON.parse(remote.stdout);
    assert.deepEqual(body.dates, ["2026-10-14", "2026-10-15"]);
    assert.equal((await storage.queryDaySummary(summaryDate)).steps, 9321);
    assert.equal((await storage.queryDaySummary("2026-10-15")).active_kcal, 500);

    const declared = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: "127.0.0.1",
        port,
        path: "/import/apple-health",
        method: "POST",
        headers: {
          authorization: "Bearer tok",
          "content-length": String(MAX_APPLE_EXPORT_BYTES + 1),
        },
      }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      });
      req.on("error", reject);
      req.end("<HealthData></HealthData>");
    });
    assert.equal(declared, 413);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("one sourceName is kept per metric-day, with an optional priority list", async () => {
  const xml = `<HealthData>
<Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" unit="count" value="60" startDate="2026-10-14 09:00:00 -0700" endDate="2026-10-14 10:00:00 -0700"/>
<Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" unit="count" value="40" startDate="2026-10-14 10:00:00 -0700" endDate="2026-10-14 11:00:00 -0700"/>
<Record type="HKQuantityTypeIdentifierStepCount" sourceName="Watch" unit="count" value="90" startDate="2026-10-14 09:00:00 -0700" endDate="2026-10-14 11:00:00 -0700"/>
</HealthData>`;
  const largest = await parseAppleExport(xml);
  assert.equal(largest.points[0].sum_qty, 100);
  assert.equal(largest.points[0].n, 2);
  const preferred = await parseAppleExport(xml, { sourcePriority: "Watch, iPhone" });
  assert.equal(preferred.points[0].sum_qty, 90);
  assert.equal(preferred.points[0].n, 1);
});

test("weight and body fat keep the newest source", async () => {
  const xml = `<HealthData>
<Record type="HKQuantityTypeIdentifierBodyMass" sourceName="Watch" unit="lb" value="200" startDate="2026-10-14 08:00:00 -0700" endDate="2026-10-14 08:00:00 -0700"/>
<Record type="HKQuantityTypeIdentifierBodyMass" sourceName="iPhone" unit="lb" value="180" startDate="2026-10-14 18:00:00 -0700" endDate="2026-10-14 18:00:00 -0700"/>
<Record type="HKQuantityTypeIdentifierBodyFatPercentage" sourceName="Watch" unit="%" value="20" startDate="2026-10-14 07:00:00 -0700" endDate="2026-10-14 07:00:00 -0700"/>
<Record type="HKQuantityTypeIdentifierBodyFatPercentage" sourceName="iPhone" unit="%" value="18" startDate="2026-10-14 19:00:00 -0700" endDate="2026-10-14 19:00:00 -0700"/>
</HealthData>`;
  const parsed = await parseAppleExport(xml);
  const weight = parsed.points.find((point) => point.metric === "weight_body_mass");
  const fat = parsed.points.find((point) => point.metric === "body_fat_percentage");
  assert.equal(weight.last_qty, 180);
  assert.equal(weight.sum_qty, 180);
  assert.equal(weight.n, 1);
  assert.equal(fat.last_qty, 18);
  const preferred = await parseAppleExport(xml, { sourcePriority: "Watch" });
  assert.equal(preferred.points.find((point) => point.metric === "weight_body_mass").last_qty, 200);
});

test("multi-year streaming does not retain input chunks", () => {
  const source = `
    import { createAppleExportParser } from "./src/core/apple-export.js";
    const parser = createAppleExportParser({ timeZone: "UTC" });
    parser.push("<HealthData>");
    global.gc();
    const before = process.memoryUsage().heapUsed;
    const days = 366 * 2;
    for (let i = 0; i < days; i++) {
      const year = 2020 + Math.floor(i / 366);
      const dayOfYear = i % 366;
      const month = String(1 + Math.floor(dayOfYear / 31)).padStart(2, "0");
      const day = String(1 + (dayOfYear % 31)).padStart(2, "0");
      const date = year + "-" + month + "-" + day;
      const record = '<Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" unit="count" value="100" startDate="' + date + ' 09:00:00 -0700" endDate="' + date + ' 10:00:00 -0700"/>';
      const workout = '<Workout workoutActivityType="HKWorkoutActivityTypeWalking" duration="10" durationUnit="min" startDate="' + date + ' 12:00:00 -0700" endDate="' + date + ' 12:10:00 -0700"/>';
      const body = record + workout;
      parser.push(body + " ".repeat(65536 - body.length));
    }
    parser.push("</HealthData>");
    const result = parser.finish();
    global.gc();
    const growth = process.memoryUsage().heapUsed - before;
    if (result.points.length !== days || result.workouts.length !== days) {
      console.error("rows", result.points.length, result.workouts.length);
      process.exit(2);
    }
    if (growth > 8 * 1024 * 1024) {
      console.error("growth", growth);
      process.exit(3);
    }
    console.log(JSON.stringify({ growth, points: result.points.length, workouts: result.workouts.length }));
  `;
  const result = spawnSync(process.execPath, ["--expose-gc", "--input-type=module", "-e", source], {
    cwd: new URL("..", import.meta.url).pathname,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
});

test("days on or after ExportDate are omitted", async () => {
  const xml = `<HealthData>
<ExportDate value="2026-10-14 08:00:00 -0700"/>
<Record type="HKQuantityTypeIdentifierStepCount" unit="count" value="10" startDate="2026-10-13 09:00:00 -0700" endDate="2026-10-13 10:00:00 -0700"/>
<Record type="HKQuantityTypeIdentifierStepCount" unit="count" value="99" startDate="2026-10-14 09:00:00 -0700" endDate="2026-10-14 10:00:00 -0700"/>
<Record type="HKQuantityTypeIdentifierStepCount" unit="count" value="5" startDate="2026-10-15 09:00:00 -0700" endDate="2026-10-15 10:00:00 -0700"/>
<Workout workoutActivityType="HKWorkoutActivityTypeWalking" duration="10" durationUnit="min" startDate="2026-10-13 12:00:00 -0700" endDate="2026-10-13 12:10:00 -0700"/>
<Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="10" durationUnit="min" startDate="2026-10-14 12:00:00 -0700" endDate="2026-10-14 12:10:00 -0700"/>
</HealthData>`;
  const parsed = await parseAppleExport(xml);
  assert.equal(parsed.exportDay, "2026-10-14");
  assert.deepEqual(parsed.points.map((point) => point.date), ["2026-10-13"]);
  assert.equal(parsed.points[0].sum_qty, 10);
  assert.deepEqual(parsed.workouts.map((workout) => workout.name), ["Walking"]);
});

test("DOCTYPE subsets, comments, and CDATA are not records, and external doctypes are rejected", async () => {
  const appleDoctype = `<!DOCTYPE HealthData [
<!ELEMENT HealthData (Record)*>
<!ELEMENT Record EMPTY>
<!ATTLIST Record type CDATA #REQUIRED>
]>`;
  const kept = await parseAppleExport(`${appleDoctype}<HealthData>
<!-- <Record type="HKQuantityTypeIdentifierStepCount" unit="count" value="999" startDate="2026-10-14 09:00:00 -0700" endDate="2026-10-14 09:00:00 -0700"/> -->
<![CDATA[ <Record type="HKQuantityTypeIdentifierStepCount" unit="count" value="888" startDate="2026-10-14 09:00:00 -0700" endDate="2026-10-14 09:00:00 -0700"/> ]]>
<Record type="HKQuantityTypeIdentifierStepCount" unit="count" value="5" startDate="2026-10-14 10:00:00 -0700" endDate="2026-10-14 10:00:00 -0700"/>
</HealthData>`);
  assert.equal(kept.points[0].sum_qty, 5);
  assert.equal(kept.points[0].n, 1);

  await assert.rejects(
    () => parseAppleExport(`<!DOCTYPE HealthData SYSTEM "health.dtd"><HealthData></HealthData>`),
    { code: "INVALID_EXPORT" },
  );
  await assert.rejects(
    () => parseAppleExport(`<!DOCTYPE HealthData PUBLIC "-//example//health" "health.dtd"><HealthData></HealthData>`),
    { code: "INVALID_EXPORT" },
  );
  await assert.rejects(
    () => parseAppleExport(`<!DOCTYPE HealthData [<!ENTITY steps "<Record type='HKQuantityTypeIdentifierStepCount' unit='count' value='999' startDate='2026-10-14 09:00:00 -0700' endDate='2026-10-14 09:00:00 -0700'/>">]><HealthData></HealthData>`),
    { code: "INVALID_EXPORT" },
  );
});

test("a zip whose declared expansion is too large is rejected before inflate", async () => {
  const name = Buffer.from("export.xml");
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(8, 8);
  header.writeUInt32LE(100, 18);
  header.writeUInt32LE(APPLE_COMPRESSION_RATIO_FLOOR + 1000, 22);
  header.writeUInt16LE(name.length, 26);
  const bomb = Buffer.concat([header, name, Buffer.alloc(100)]);
  await assert.rejects(() => parseAppleExport(bomb), { code: "PAYLOAD_TOO_LARGE" });

  const payload = Buffer.from("<HealthData></HealthData>");
  const compressed = deflateRawSync(payload);
  const lying = Buffer.alloc(30);
  lying.writeUInt32LE(0x04034b50, 0);
  lying.writeUInt16LE(20, 4);
  lying.writeUInt16LE(8, 8);
  lying.writeUInt32LE(compressed.length, 18);
  lying.writeUInt32LE(8, 22);
  lying.writeUInt16LE(name.length, 26);
  await assert.rejects(
    () => parseAppleExport(Buffer.concat([lying, name, compressed])),
    { code: "PAYLOAD_TOO_LARGE" },
  );
});

test("streaming aggregation does not retain samples", () => {
  const source = `
    import { createAppleExportParser } from "./src/core/apple-export.js";
    const parser = createAppleExportParser({ timeZone: "UTC" });
    parser.push("<HealthData>");
    global.gc();
    const before = process.memoryUsage().heapUsed;
    const count = 100000;
    for (let i = 0; i < count; i++) {
      const hour = String(Math.floor(i / 3600) % 20).padStart(2, "0");
      const minute = String(Math.floor(i / 60) % 60).padStart(2, "0");
      const second = String(i % 60).padStart(2, "0");
      const day = String(1 + (i % 2)).padStart(2, "0");
      parser.push('<Record type="HKQuantityTypeIdentifierStepCount" sourceName="Phone" unit="count" value="1" startDate="2026-10-' + day + ' ' + hour + ':' + minute + ':' + second + ' -0700" endDate="2026-10-' + day + ' ' + hour + ':' + minute + ':' + second + ' -0700"/>');
    }
    parser.push("</HealthData>");
    const result = parser.finish();
    global.gc();
    const growth = process.memoryUsage().heapUsed - before;
    if (parser.bucketCount() > 4 || result.points.length !== 2) process.exit(2);
    if (growth > 8 * 1024 * 1024) {
      console.error("growth", growth);
      process.exit(3);
    }
    console.log(JSON.stringify({ growth, buckets: parser.bucketCount() }));
  `;
  const result = spawnSync(process.execPath, ["--expose-gc", "--input-type=module", "-e", source], {
    cwd: new URL("..", import.meta.url).pathname,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
});
