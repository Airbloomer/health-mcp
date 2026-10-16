import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { test } from "node:test";
import { Readable } from "node:stream";
import { startServer } from "../src/adapters/node.js";
import { resetCloudflareProfileLog } from "../src/adapters/cloudflare.js";
import { applySqliteMigrations } from "../src/adapters/sqlite.js";
import { migrationFiles } from "../src/adapters/migrate.js";
import { authed, redactRequestTarget, tokenClass } from "../src/core/auth.js";
import { resetDateTimeFormatCache } from "../src/core/datetime.js";
import { canonicalStart } from "../src/core/health-connect.js";
import { handleRequest, json, ROUTES } from "../src/core/http.js";
import { D1_DAILY_ROW_READ_LIMIT, D1_DAILY_ROW_WRITE_LIMIT, d1DailyLimitKind } from "../src/core/free-tier.js";
import { FREE_MAX_BYTES, NODE_MAX_BYTES, resolveLimitsProfile, secondsUntilUtcMidnight } from "../src/core/limits.js";
import { SENSITIVE_METRICS } from "../src/core/metrics.js";
import { localDate } from "../src/core/parse.js";
import { parseShortcuts, shortcutDays } from "../src/core/shortcuts.js";
import worker from "../src/index.js";
import { d1FromSqlite, eachBackend, openD1Pre0003, openMemory, openPostgres, openSqlitePre0003, pointOf, seedPoint, seedWorkout } from "./p0-backends.mjs";

const NOW = new Date("2026-10-16T12:00:00Z");
const TOKEN = "tok";
const URL_SECRET = `${"b".repeat(31)}-`;
const DAY = "2026-10-14";

function request(pathname, { method = "POST", token = TOKEN, body, headers = {} } = {}) {
  const initHeaders = new Headers(headers);
  if (token) {
    const raw = /^bearer\s/i.test(token) || token.startsWith("Basic ") ? token : `Bearer ${token}`;
    initHeaders.set("authorization", raw);
  }
  if (body != null && !initHeaders.has("content-type")) initHeaders.set("content-type", "application/json");
  const init = { method, headers: initHeaders };
  if (body != null) {
    init.body = body;
    if (typeof body !== "string" && body?.getReader) init.duplex = "half";
  }
  return new Request(`http://localhost${pathname}`, init);
}

function ctx(storage, extra = {}) {
  return { token: TOKEN, timeZone: "UTC", storage, now: NOW, ...extra };
}

function hc(extra = {}) {
  return { timestamp: "2026-10-16T12:00:00Z", app_version: "1.2.3", ...extra };
}

function stepsBody(count = 10) {
  return hc({
    steps: [{ count, start_time: "2026-10-14T09:00:00Z", end_time: "2026-10-14T10:00:00Z" }],
  });
}

function shortcutSteps(value = "10") {
  return { samples: [{ type: "Steps", value, start: "2026-10-14T09:00:00Z", end: "2026-10-14T10:00:00Z" }] };
}

function closeServer(server) {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(resolve));
}

async function post(backend, pathname, payload, extra = {}, req = {}) {
  return handleRequest(request(pathname, { body: JSON.stringify(payload), ...req }), ctx(backend.storage, extra));
}

test("1-4, 7-10, 20, 21, 33, 34 token class and workouts on every backend", async () => {
  await eachBackend(async (backend, name) => {
    const urlCtx = { urlToken: URL_SECRET };
    const created = await post(backend, `/ingest/shortcuts?token=${URL_SECRET}`, shortcutSteps("10"), urlCtx, { token: "" });
    assert.equal(created.status, 200, name);
    const createdPoint = await pointOf(backend, DAY, "step_count");
    assert.equal(Number(createdPoint.n), 0, name);
    assert.equal(Number(createdPoint.sum_qty), 10, name);

    const bearer = await post(backend, "/ingest/shortcuts", shortcutSteps("80"));
    assert.equal(bearer.status, 200, name);
    assert.equal(Number((await pointOf(backend, DAY, "step_count")).sum_qty), 80, name);
    const urlOverBearer = await post(backend, `/ingest/shortcuts?token=${URL_SECRET}`, shortcutSteps("1"), urlCtx, { token: "" });
    assert.equal(urlOverBearer.status, 200, name);
    assert.equal(Number((await pointOf(backend, DAY, "step_count")).sum_qty), 80, name);

    const other = openMemory();
    const urlDay = await post(other, `/ingest/hc-webhook?token=${URL_SECRET}`, stepsBody(4), urlCtx, { token: "" });
    assert.equal(urlDay.status, 200);
    const fuller = await post(other, `/ingest/hc-webhook?token=${URL_SECRET}`, stepsBody(9), urlCtx, { token: "" });
    assert.equal(fuller.status, 200);
    assert.equal(Number((await pointOf(other, DAY, "step_count")).n), 0);
    assert.equal(Number((await pointOf(other, DAY, "step_count")).sum_qty), 9);
    const replay = await post(other, `/ingest/hc-webhook?token=${URL_SECRET}`, stepsBody(9), urlCtx, { token: "" });
    assert.equal(replay.status, 200);
    assert.equal(Number((await pointOf(other, DAY, "step_count")).sum_qty), 9);
    const replaced = await post(other, "/ingest/hc-webhook", stepsBody(15));
    assert.equal(Number((await pointOf(other, DAY, "step_count")).sum_qty), 15);
    assert.ok(Number((await pointOf(other, DAY, "step_count")).n) >= 1);

    const workouts = {
      workouts: [{ type: "Walking", start: "2026-10-14T12:00:00Z", duration: "1800", energy: "100" }],
    };
    const firstWorkout = await post(backend, "/ingest/shortcuts", workouts);
    assert.equal(firstWorkout.status, 200, name);
    const urlWorkout = await post(backend, `/ingest/shortcuts?token=${URL_SECRET}`, {
      workouts: [{ type: "Walking", start: "2026-10-14T12:00:00Z", duration: "600", energy: "5" }],
    }, urlCtx, { token: "" });
    assert.equal(urlWorkout.status, 200, name);
    const listed = await backend.storage.listWorkouts(DAY, DAY);
    const walk = listed.find((row) => row.name === "Walking");
    assert.equal(walk.duration_min, 30, name);
    assert.equal(walk.kcal, 100, name);

    const again = await post(backend, "/ingest/shortcuts", shortcutSteps("80"));
    assert.equal(again.status, 200, name);
    assert.equal(Number((await pointOf(backend, DAY, "step_count")).sum_qty), 80, name);

    const controlled = await post(backend, "/ingest/shortcuts", {
      n: 99,
      replace: false,
      insertOnly: true,
      upsert: true,
      tokenClass: "url",
      samples: [{ type: "Steps", value: "3", start: "2026-10-13T09:00:00Z", end: "2026-10-13T10:00:00Z", n: 99, replace: false }],
    });
    assert.equal(controlled.status, 200, name);
    const controlledPoint = await pointOf(backend, "2026-10-13", "step_count");
    assert.equal(Number(controlledPoint.sum_qty), 3, name);
    assert.notEqual(Number(controlledPoint.n), 99, name);

    const hcControlled = await post(backend, "/ingest/hc-webhook", hc({
      n: 50,
      tokenClass: "url",
      replace: true,
      steps: [{ count: 6, start_time: "2026-10-12T09:00:00Z", end_time: "2026-10-12T10:00:00Z", n: 50 }],
    }));
    assert.equal(hcControlled.status, 200, name);
    assert.notEqual(Number((await pointOf(backend, "2026-10-12", "step_count")).n), 50, name);

    const pair = hc({
      exercise: [
        { type: "79", start_time: "2026-10-01T00:00:00-07:00", end_time: "2026-10-01T00:30:00-07:00", duration_seconds: 1800 },
      ],
    });
    assert.equal((await post(backend, "/ingest/hc-webhook", pair)).status, 200, name);
    assert.equal((await post(backend, "/ingest/shortcuts", {
      workouts: [{ type: "Walking", start: "2026-10-01T07:00:00Z", duration: "1800" }],
    })).status, 200, name);
    const merged = (await backend.storage.listWorkouts("2026-10-01", "2026-10-01")).filter((row) => row.duration_min === 30);
    assert.equal(merged.length, 1, name);
    assert.equal(merged[0].start, "2026-10-01T07:00:00.000Z", name);

    const sameInstant = hc({
      exercise: [
        { type: "56", start_time: "2026-10-11T15:00:00Z", duration_seconds: 600 },
        { type: "56", start_time: "2026-10-11T08:00:00-07:00", duration_seconds: 600 },
      ],
    });
    assert.equal((await post(backend, "/ingest/hc-webhook", sameInstant)).status, 200, name);
    const runs = await backend.storage.listWorkouts("2026-10-11", "2026-10-11");
    assert.equal(runs.filter((row) => row.name === "Running").length, 1, name);
    assert.equal(runs.find((row) => row.name === "Running").start, "2026-10-11T15:00:00.000Z", name);
  });
});

test("5 empty batch does not insert", async () => {
  await eachBackend(async (backend) => {
    let calls = 0;
    const original = backend.storage.insertIngest.bind(backend.storage);
    backend.storage.insertIngest = async (...args) => {
      calls += 1;
      return original(...args);
    };
    const response = await post(backend, "/ingest/hc-webhook", hc());
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(body.dates, []);
    assert.equal(body.points, 0);
    assert.equal(body.workouts, 0);
    assert.equal(calls, 0);
    const shortcuts = await post(backend, "/ingest/shortcuts", { samples: [] });
    const shortcutBody = await shortcuts.json();
    assert.equal(shortcuts.status, 200);
    assert.equal(shortcutBody.points, 0);
    assert.equal(shortcutBody.workouts, 0);
    assert.equal(calls, 0);
  });
});

test("6 filtered records are an empty success and out-of-window stays 400", async () => {
  await eachBackend(async (backend) => {
    let calls = 0;
    const original = backend.storage.insertIngest.bind(backend.storage);
    backend.storage.insertIngest = async (...args) => {
      calls += 1;
      return original(...args);
    };
    const filtered = await post(backend, "/ingest/hc-webhook", hc({
      heart_rate: [{ time: "2026-10-14T08:00:00Z", bpm: 70 }],
    }));
    assert.equal(filtered.status, 200);
    assert.equal((await filtered.json()).points, 0);
    assert.equal(calls, 0);
    const outside = await post(backend, "/ingest/shortcuts", {
      samples: [{ type: "Steps", value: "1", start: "2026-10-20T09:00:00Z" }],
    });
    assert.equal(outside.status, 400);
  });
});

test("11 and 26 caps, including node URL and bearer limits", async () => {
  await eachBackend(async (backend, name) => {
    const workouts = (count, route) => {
      if (route === "hc") {
        return hc({
          exercise: Array.from({ length: count }, (_, index) => ({
            type: "79",
            start_time: new Date(Date.UTC(2026, 9, 14, 0, 0, index)).toISOString(),
            duration_seconds: 600,
          })),
        });
      }
      return {
        workouts: Array.from({ length: count }, (_, index) => ({
          type: "Walking",
          start: new Date(Date.UTC(2026, 9, 14, 0, 0, index)).toISOString(),
          duration: "600",
        })),
      };
    };
    const points = (count) => ({
      points: Array.from({ length: count }, (_, index) => {
        const date = new Date(Date.UTC(2026, 7, 1 + index)).toISOString().slice(0, 10);
        return {
          metric: "step_count",
          date,
          sum_qty: 1,
          last_qty: 1,
          last_ts: `${date}T00:00:00Z`,
          units: "count",
          n: 1,
        };
      }),
      workouts: [],
    });
    const chunkWorkouts = (count) => ({
      points: [],
      workouts: Array.from({ length: count }, (_, index) => ({
        name: "Walking",
        start: new Date(Date.UTC(2026, 9, 14, 0, 0, index)).toISOString(),
        date: "2026-10-14",
        duration_min: 10,
      })),
    });
    const free = { limitsProfile: "free", adapter: "cloudflare" };
    const node = { limitsProfile: "node", adapter: "node" };
    const before = backend.storage.insertIngest.bind(backend.storage);
    let writes = 0;
    backend.storage.insertIngest = async (...args) => {
      writes += 1;
      return before(...args);
    };
    const ok40 = await post(backend, "/ingest/shortcuts", workouts(40, "shortcuts"), free);
    assert.equal(ok40.status, 200, name);
    const tooMany = await post(backend, "/ingest/shortcuts", workouts(41, "shortcuts"), free);
    assert.equal(tooMany.status, 413, name);
    assert.deepEqual(await tooMany.json(), { error: "too_many_workouts", max: 40, retry: "split" });
    const rowsOk = await post(backend, "/import/apple-health/chunk", points(40), free);
    assert.equal(rowsOk.status, 200, name);
    const writesBefore = writes;
    const rowsOver = await post(backend, "/import/apple-health/chunk", points(41), free);
    assert.equal(rowsOver.status, 413, name);
    assert.deepEqual(await rowsOver.json(), { error: "too_many_rows", max: 40, retry: "split" });
    assert.equal(writes, writesBefore, name);

    const urlRoutes = ["/ingest/shortcuts", "/ingest/hc-webhook"];
    for (const pathname of urlRoutes) {
      const kind = pathname.includes("hc-webhook") ? "hc" : "shortcuts";
      const accepted = await post(backend, `${pathname}?token=${URL_SECRET}`, workouts(500, kind), { ...node, urlToken: URL_SECRET }, { token: "" });
      assert.equal(accepted.status, 200, `${name} ${pathname}`);
      const rejected = await post(backend, `${pathname}?token=${URL_SECRET}`, workouts(501, kind), { ...node, urlToken: URL_SECRET }, { token: "" });
      assert.equal(rejected.status, 413, `${name} ${pathname}`);
      const rejectedBody = await rejected.json();
      assert.equal(rejectedBody.error, "too_many_workouts");
      assert.equal(rejectedBody.max, 500);
    }
    for (const pathname of ["/ingest/shortcuts", "/ingest/hc-webhook", "/import/apple-health/chunk"]) {
      const kind = pathname.includes("hc-webhook") ? "hc" : "shortcuts";
      const payload = pathname.endsWith("chunk") ? chunkWorkouts(5000) : workouts(5000, kind);
      const accepted = await post(backend, pathname, payload, node);
      assert.equal(accepted.status, 200, `${name} bearer ${pathname}`);
      const over = pathname.endsWith("chunk") ? chunkWorkouts(5001) : workouts(5001, kind);
      const rejected = await post(backend, pathname, over, node);
      assert.equal(rejected.status, 413, `${name} bearer over ${pathname}`);
      assert.equal((await rejected.json()).max, 5000);
    }
  });
});

test("12 Content-Length over 10MB does not read the body", async () => {
  let pulled = false;
  const stream = new ReadableStream({
    pull() {
      pulled = true;
      throw new Error("body was read");
    },
  });
  const response = await handleRequest(new Request("http://localhost/ingest/shortcuts", {
    method: "POST",
    headers: {
      authorization: "Bearer tok",
      "content-type": "application/json",
      "content-length": "10000001",
    },
    body: stream,
    duplex: "half",
  }), ctx(openMemory().storage, { limitsProfile: "node", adapter: "node" }));
  assert.equal(response.status, 413);
  assert.equal(pulled, false);
  assert.deepEqual(await response.json(), { error: "payload_too_large", max_bytes: NODE_MAX_BYTES, retry: "split" });

  const backend = openMemory();
  const server = await startServer({ storage: backend.storage, token: TOKEN, limitsProfile: "node", port: 0, host: "127.0.0.1" });
  const { port } = server.address();
  try {
    const status = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: "127.0.0.1",
        port,
        path: "/ingest/shortcuts",
        method: "POST",
        headers: {
          authorization: "Bearer tok",
          "content-type": "application/json",
          "content-length": "10000001",
        },
      }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(status, 413);
  } finally {
    await closeServer(server);
  }
});

test("13 a chunked body past 10MB is 413", async () => {
  const server = await startServer({ storage: openMemory().storage, token: TOKEN, limitsProfile: "node", port: 0, host: "127.0.0.1" });
  const { port } = server.address();
  try {
    const status = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: "127.0.0.1",
        port,
        path: "/ingest/shortcuts",
        method: "POST",
        headers: { authorization: "Bearer tok", "content-type": "application/json", connection: "close" },
      }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      });
      req.on("error", reject);
      const chunk = Buffer.alloc(1024 * 1024, 0x61);
      for (let index = 0; index < 11; index += 1) req.write(chunk);
      req.end();
    });
    assert.equal(status, 413);
  } finally {
    await closeServer(server);
  }
});

test("14 content type", async () => {
  const storage = openMemory().storage;
  const wrong = await handleRequest(request("/ingest/shortcuts", {
    body: "{}",
    headers: { "content-type": "text/plain" },
  }), ctx(storage));
  assert.equal(wrong.status, 415);
  assert.deepEqual(await wrong.json(), { error: "unsupported_media_type" });
  const missing = await handleRequest(new Request("http://localhost/ingest/shortcuts", {
    method: "POST",
    headers: { authorization: "Bearer tok" },
    body: new TextEncoder().encode(JSON.stringify(shortcutSteps())),
  }), ctx(storage));
  assert.equal(missing.status, 200);
});

test("15 HC validation failures are 400 and do not echo values", async () => {
  const storage = openMemory().storage;
  const cases = [
    "{",
    JSON.stringify({ app_version: "1" }),
    JSON.stringify(hc({ steps: { count: 1 } })),
    JSON.stringify(hc({ steps: [{ count: Number.NaN, start_time: "2026-10-14T00:00:00Z", end_time: "2026-10-14T01:00:00Z" }] })),
    JSON.stringify(hc({ steps: [{ count: 2_000_000, start_time: "2026-10-14T00:00:00Z", end_time: "2026-10-14T01:00:00Z" }] })),
  ];
  for (const body of cases) {
    const response = await handleRequest(request("/ingest/hc-webhook", { body }), ctx(storage));
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.equal(payload.error === "invalid_json" || payload.error === "invalid_payload", true);
    assert.equal(JSON.stringify(payload).includes("2000000"), false);
    assert.equal(JSON.stringify(payload).includes("NaN"), false);
  }
});

test("16 an array over 50000 is 413 on the node profile", async () => {
  const steps = Array.from({ length: 50001 }, () => ({ count: 1, start_time: "2026-10-14T00:00:00Z", end_time: "2026-10-14T01:00:00Z" }));
  const response = await handleRequest(request("/ingest/hc-webhook", { body: JSON.stringify(hc({ steps })) }), ctx(openMemory().storage, { limitsProfile: "node", adapter: "node" }));
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: "too_many_records", max: 50000, retry: "split" });
});

test("17 4xx bodies do not echo payload values", async () => {
  const storage = openMemory().storage;
  const environment = ctx(storage, { limitsProfile: "node", adapter: "node" });
  const workouts = await handleRequest(request("/ingest/shortcuts", {
    body: JSON.stringify({ workouts: Array.from({ length: 5001 }, () => ({ type: "Walking", start: "2026-10-14T00:00:00Z", duration: "1", note: "CanaryNoteValue" })) }),
  }), environment);
  const workoutBody = await workouts.json();
  assert.deepEqual(workoutBody, { error: "too_many_workouts", max: 5000, retry: "split" });
  const records = await handleRequest(request("/ingest/shortcuts", {
    body: JSON.stringify({ samples: Array.from({ length: 50001 }, () => ({ type: "Steps", value: "1", start: "2026-10-14T00:00:00Z" })) }),
  }), environment);
  assert.equal((await records.json()).error, "too_many_records");
  const big = await handleRequest(request("/ingest/shortcuts", {
    headers: { "content-length": String(NODE_MAX_BYTES + 1), "content-type": "application/json" },
    body: "{}",
  }), environment);
  assert.deepEqual(await big.json(), { error: "payload_too_large", max_bytes: NODE_MAX_BYTES, retry: "split" });
  const type = await handleRequest(request("/ingest/shortcuts", { body: "{\"secret\":\"CanaryNoteValue\"}", headers: { "content-type": "text/plain" } }), environment);
  assert.deepEqual(await type.json(), { error: "unsupported_media_type" });
  const bad = await handleRequest(request("/ingest/hc-webhook", { body: "{" }), environment);
  assert.equal((await bad.json()).error, "invalid_json");
  const schema = await handleRequest(request("/ingest/hc-webhook", { body: JSON.stringify({ app_version: "1" }) }), environment);
  const schemaBody = await schema.json();
  assert.equal(schemaBody.error, "invalid_payload");
  assert.equal(JSON.stringify(workoutBody).includes("CanaryNoteValue"), false);
  assert.equal(JSON.stringify(schemaBody).includes("CanaryNoteValue"), false);
});

test("18 and 19 empty Authorization is absent and Basic is always 401", async () => {
  const envOn = { HEALTH_INGEST_TOKEN: TOKEN, HEALTH_INGEST_URL_TOKEN: URL_SECRET };
  const envOff = { HEALTH_INGEST_TOKEN: TOKEN, HEALTH_INGEST_URL_TOKEN: "" };
  const empty = {
    method: "POST",
    url: `http://localhost/ingest/shortcuts?token=${URL_SECRET}`,
    headers: { get: (name) => (name === "authorization" ? "" : null) },
  };
  assert.equal(tokenClass(empty, envOn), "url");
  assert.equal(tokenClass(empty, envOff), null);
  const basic = new Request(`http://localhost/ingest/shortcuts?token=${URL_SECRET}`, {
    method: "POST",
    headers: { authorization: "Basic dG9r" },
  });
  assert.equal(tokenClass(basic, envOn), null);
  assert.equal(tokenClass(basic, envOff), null);
  assert.equal(authed(basic, envOn), false);
  for (const urlToken of [URL_SECRET, ""]) {
    const response = await handleRequest(basic, ctx(openMemory().storage, { urlToken }));
    assert.equal(response.status, 401);
  }
});

test("22 default config stores steps and drops every sensitive type", async () => {
  const memory = openMemory();
  const stored = await handleRequest(request("/ingest/hc-webhook", { body: JSON.stringify(sensitiveBody()) }), ctx(memory.storage));
  const payload = await stored.json();
  assert.equal(stored.status, 200, JSON.stringify(payload));
  const metrics = await memory.storage.listMetrics();
  assert.deepEqual(metrics, ["step_count"]);
  for (const metric of SENSITIVE_METRICS) assert.equal(metrics.includes(metric), false);
});

test("23 raw rows are the post-filter document on every json ingest route", async () => {
  const canary = "CanaryDeviceName";
  const routes = [
    ["/ingest/hc-webhook", hc({ device: canary, note: "CanaryNoteValue", steps: [{ count: 4, start_time: "2026-10-14T09:00:00Z", end_time: "2026-10-14T10:00:00Z" }], blood_glucose: [{ mmol_per_liter: 5, time: "2026-10-14T09:00:00Z" }] })],
    ["/ingest/shortcuts", { device: canary, samples: [{ type: "Steps", value: "4", start: "2026-10-14T09:00:00Z", source: canary }] }],
    ["/import/apple-health/chunk", { device: canary, points: [{ metric: "step_count", date: DAY, sum_qty: 4, last_qty: 4, last_ts: "2026-10-14T09:00:00Z", units: "count", n: 1 }], workouts: [] }],
  ];
  for (const [pathname, payload] of routes) {
    const memory = openMemory();
    const response = await handleRequest(request(pathname, { body: JSON.stringify(payload) }), ctx(memory.storage, { storeRaw: "true" }));
    assert.equal(response.status, 200, pathname);
    assert.equal(memory.storage.payloads.length, 1, pathname);
    const raw = memory.storage.payloads[0].payload;
    assert.equal(raw.includes(canary), false, pathname);
    assert.equal(raw.includes("blood_glucose"), false, pathname);
    assert.equal(raw.includes("CanaryNoteValue"), false, pathname);
    const parsed = JSON.parse(raw);
    assert.equal(parsed.route.length > 0, true);
    assert.ok(Array.isArray(parsed.points));
    assert.ok(Array.isArray(parsed.workouts));
  }
});

test("24 allowlist values are exact", async () => {
  const rejected = ["*", " * ", "all", "ALL", "true", "1", "sensitive", "reproductive", "sexual", "fertility", "sleep", "sleep*", "sleep_*", "*temperature*", "blood*", "%", ".*", ",,", "BLOOD_GLUCOSE", "blood-glucose", "bloodglucose", "blood_glucos"];
  for (const allow of rejected) {
    const memory = openMemory();
    const response = await handleRequest(request("/ingest/hc-webhook", { body: JSON.stringify(sensitiveBody()) }), ctx(memory.storage, { metricAllowlist: allow, storeRaw: true }));
    assert.equal(response.status, 200, allow);
    const metrics = await memory.storage.listMetrics();
    for (const metric of SENSITIVE_METRICS) assert.equal(metrics.includes(metric), false, allow);
    const raw = memory.storage.payloads[0]?.payload || "";
    assert.equal(raw.includes("blood_glucose"), false, allow);
    assert.equal(raw.includes("CanaryDeviceName"), false, allow);
  }
  for (const allow of ["blood_glucose", " blood_glucose ", "basal_body_temperature"]) {
    const memory = openMemory();
    const response = await handleRequest(request("/ingest/hc-webhook", { body: JSON.stringify(sensitiveBody()) }), ctx(memory.storage, { metricAllowlist: allow, storeRaw: true }));
    assert.equal(response.status, 200, allow);
    const metrics = await memory.storage.listMetrics();
    const expected = allow.trim();
    assert.equal(metrics.includes(expected), true, allow);
    for (const metric of SENSITIVE_METRICS) {
      if (metric !== expected) assert.equal(metrics.includes(metric), false, `${allow} ${metric}`);
    }
  }
});

test("25 real HTTP body limits", async () => {
  const server = await startServer({ storage: openMemory().storage, token: TOKEN, limitsProfile: "node", port: 0, host: "127.0.0.1" });
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    const declared = await new Promise((resolve, reject) => {
      let sent = 0;
      const req = http.request({
        hostname: "127.0.0.1",
        port,
        path: "/ingest/shortcuts",
        method: "POST",
        headers: { authorization: "Bearer tok", "content-type": "application/json", "content-length": "10000001" },
      }, (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode, sent }));
      });
      req.on("error", reject);
      req.on("socket", (socket) => {
        const write = socket.write.bind(socket);
        socket.write = (chunk, ...rest) => {
          sent += Buffer.byteLength(chunk);
          return write(chunk, ...rest);
        };
      });
      req.end();
    });
    assert.equal(declared.status, 413);
    const under = await fetch(`${base}/ingest/shortcuts`, {
      method: "POST",
      headers: { authorization: "Bearer tok", "content-type": "application/json" },
      body: "x".repeat(9_999_999),
    });
    assert.equal(under.status === 200 || under.status === 400, true);
    const euros = "€".repeat(Math.ceil(10_200_000 / 3));
    const wide = await fetch(`${base}/ingest/shortcuts`, {
      method: "POST",
      headers: { authorization: "Bearer tok", "content-type": "application/json" },
      body: euros,
    });
    assert.equal(wide.status, 413);
    const summary = await fetch(`${base}/summary?date=${DAY}`, {
      method: "POST",
      headers: { authorization: "Bearer tok", "content-type": "application/json" },
      body: "x".repeat(70_000),
    });
    assert.equal(summary.status, 413);
  } finally {
    await closeServer(server);
  }
});

test("27 route table", async () => {
  const posts = ROUTES.filter((route) => route.method === "POST" && (route.samplePaths[0].startsWith("/ingest") || route.samplePaths[0].startsWith("/import")));
  for (const route of posts) {
    if (route.samplePaths[0] === "/import/apple-health") assert.equal(route.guard, "apple-stream");
    else assert.equal(route.guard, "json-ingest");
  }
  assert.deepEqual(
    ROUTES.filter((route) => route.urlToken).map((route) => route.id).sort(),
    ["hc-webhook", "shortcuts"],
  );
  const ids = ROUTES.map((route) => route.samplePaths.join(" ")).join(" ");
  for (const path of ["/ingest ", "life-dashboard", "health-export-pro", "syncfit"]) {
    assert.equal(ROUTES.some((route) => route.samplePaths.some((sample) => sample === path || sample.includes("life-dashboard") || sample.includes("health-export-pro") || sample.includes("syncfit"))), false);
  }
  void ids;
  for (const route of ROUTES.filter((entry) => entry.guard === "json-ingest")) {
    assert.equal(typeof route.handler, "function");
    const sample = route.samplePaths[0];
    const over = await handleRequest(request(sample, {
      headers: { "content-length": String(FREE_MAX_BYTES + 1) },
      body: "{}",
    }), ctx(openMemory().storage));
    assert.equal(over.status, 413, sample);
    const basic = await handleRequest(new Request(`http://localhost${sample}`, {
      method: "POST",
      headers: { authorization: "Basic abc", "content-type": "application/json" },
      body: "{}",
    }), ctx(openMemory().storage, { urlToken: URL_SECRET }));
    assert.equal(basic.status, 401, sample);
  }
  for (const urlToken of [URL_SECRET, ""]) {
    for (const pathname of [`/import/apple-health?token=${URL_SECRET}`, `/import/apple-health/chunk?token=${URL_SECRET}`, `/import/apple-health/${URL_SECRET}`, `/import/apple-health/chunk/${URL_SECRET}`]) {
      const response = await handleRequest(request(pathname, { token: "", body: "{}" }), ctx(openMemory().storage, { urlToken }));
      assert.equal(response.status, 401, pathname);
    }
  }
});

test("28 URL tokens rejected when disabled", async () => {
  const paths = ["/ingest/shortcuts", "/ingest/hc-webhook", "/import/apple-health/chunk", "/import/apple-health"];
  for (const pathname of paths) {
    for (const headers of [{}, { authorization: "" }, { authorization: "Basic abc" }]) {
      const response = await handleRequest(new Request(`http://localhost${pathname}?token=${URL_SECRET}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: "{}",
      }), ctx(openMemory().storage));
      assert.equal(response.status, 401, pathname);
    }
  }
});

test("29 spring gap and 30 fall back and 31 midnight", () => {
  const zone = "America/Los_Angeles";
  assert.equal(canonicalStart("2026-03-08T02:30:00-08:00", zone), "2026-03-08T10:30:00.000Z");
  assert.equal(canonicalStart("2026-03-08T02:30:00-07:00", zone), "2026-03-08T09:30:00.000Z");
  assert.equal(canonicalStart("2026-03-08T02:30:00", zone), "2026-03-08T10:30:00.000Z");
  assert.equal(canonicalStart("2026-11-01T01:30:00-07:00", zone), "2026-11-01T08:30:00.000Z");
  assert.equal(canonicalStart("2026-11-01T01:30:00-08:00", zone), "2026-11-01T09:30:00.000Z");
  assert.equal(canonicalStart("2026-11-01T01:30:00", zone), "2026-11-01T08:30:00.000Z");
});

test("31 midnight local date for HC, Shortcuts, and Apple", async () => {
  const start = "2026-10-01T23:30:00-07:00";
  const memory = openMemory();
  const hcResponse = await post(memory, "/ingest/hc-webhook", hc({
    exercise: [{ type: "79", start_time: start, duration_seconds: 600 }],
  }), { timeZone: "America/Los_Angeles" });
  assert.equal(hcResponse.status, 200);
  const hcRows = await memory.storage.listWorkouts("2026-10-01", "2026-10-01");
  assert.equal(hcRows[0].start, "2026-10-02T06:30:00.000Z");
  assert.equal(hcRows.length, 1);
  const shortcuts = openMemory();
  const shortcutResponse = await post(shortcuts, "/ingest/shortcuts", {
    workouts: [{ type: "Walking", start, duration: "600" }],
  }, { timeZone: "America/Los_Angeles" });
  assert.equal(shortcutResponse.status, 200);
  const shortcutRows = await shortcuts.storage.listWorkouts("2026-10-01", "2026-10-01");
  assert.equal(shortcutRows[0].start, "2026-10-02T06:30:00.000Z");
  const apple = `<HealthData><Workout workoutActivityType="HKWorkoutActivityTypeWalking" duration="10" durationUnit="min" startDate="${start}" endDate="2026-10-02 00:00:00 -0700"/></HealthData>`;
  const appleStorage = openMemory();
  const imported = await handleRequest(request("/import/apple-health", { body: apple, headers: { "content-type": "application/xml" } }), ctx(appleStorage.storage, { timeZone: "America/Los_Angeles" }));
  assert.equal(imported.status, 200);
  const appleRows = await appleStorage.storage.listWorkouts("2026-10-01", "2026-10-01");
  assert.equal(appleRows[0].start, "2026-10-02T06:30:00.000Z");
});

test("32 unparseable workout starts are dropped", async () => {
  const bad = ["", "not-a-date", "2026-13-01T00:00:00Z", "2026-02-30T00:00:00Z", null, 1e20];
  const exercise = [
    ...bad.map((start) => ({ type: "79", start_time: start, duration_seconds: 600 })),
    { type: "79", start_time: "2026-10-14T12:00:00Z", duration_seconds: 600 },
  ];
  const memory = openMemory();
  const response = await post(memory, "/ingest/hc-webhook", hc({
    steps: [{ count: 4, start_time: "2026-10-14T09:00:00Z", end_time: "2026-10-14T10:00:00Z" }],
    exercise,
  }));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.workouts, 1);
  assert.equal(body.dropped_workouts, 6);
  assert.equal((await memory.storage.listWorkouts(DAY, DAY)).length, 1);
  assert.equal(Number((await pointOf(memory, DAY, "step_count")).sum_qty), 4);
});

test("34 URL-token days stay at n 0 so a later partial batch can overwrite", async () => {
  await eachBackend(async (backend) => {
    const extra = { urlToken: URL_SECRET };
    await post(backend, `/ingest/hc-webhook?token=${URL_SECRET}`, stepsBody(20), extra, { token: "" });
    await post(backend, `/ingest/hc-webhook?token=${URL_SECRET}`, stepsBody(3), extra, { token: "" });
    const row = await pointOf(backend, DAY, "step_count");
    assert.equal(Number(row.n), 0);
    assert.equal(Number(row.sum_qty), 3);
  });
});

test("35 source-less Shortcuts samples are summed", () => {
  const parsed = parseShortcuts({
    samples: [
      { type: "Steps", value: "100", start: "2026-10-14T09:00:00Z", end: "2026-10-14T09:10:00Z" },
      { type: "Steps", value: "120", start: "2026-10-14T10:00:00Z", end: "2026-10-14T10:10:00Z" },
    ],
  }, { timeZone: "UTC", now: NOW });
  assert.equal(parsed.points.every((point) => point.source === ""), true);
  const rows = shortcutDays(parsed.points);
  assert.equal(rows[0].sum_qty, 220);
});

test("36 removed ingest paths are redacted in the Node log", async () => {
  const token = `${"c".repeat(40)}`;
  const server = await startServer({ storage: openMemory().storage, token: TOKEN, urlToken: token, port: 0, host: "127.0.0.1" });
  const { port } = server.address();
  const errors = [];
  const original = console.error;
  console.error = (message) => errors.push(String(message));
  try {
    const paths = [
      `/ingest/life-dashboard/${token}`,
      `/ingest/syncfit/${token}`,
      `/ingest/health-export-pro/${token}?token=${token}`,
      `/ingest/health-export-pro/${"%63".repeat(token.length)}?token=${"%63".repeat(token.length)}`,
    ];
    for (const pathname of paths) {
      const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
        body: "{}",
      });
      assert.equal(response.status, 410, pathname);
    }
  } finally {
    console.error = original;
    await closeServer(server);
  }
  const text = errors.join("\n");
  assert.match(text, /\[redacted\]/);
  assert.equal(text.includes(token), false);
});

test("37 daily write limit uses UTC midnight", async () => {
  const expected = String(secondsUntilUtcMidnight(NOW));
  assert.equal(expected, "43200");
  assert.equal(d1DailyLimitKind(new Error(`D1_ERROR: ${D1_DAILY_ROW_WRITE_LIMIT}`)), "d1_rows_written");
  assert.equal(d1DailyLimitKind(new Error(`${D1_DAILY_ROW_READ_LIMIT} See https://developers.cloudflare.com/d1/platform/limits/ for more details.`)), "d1_rows_read");
  assert.equal(d1DailyLimitKind(new Error("daily_limit_exceeded")), null);
  assert.equal(d1DailyLimitKind(new Error("D1 daily quota exceeded")), null);
  assert.equal(d1DailyLimitKind(new Error("Exceeded maximum DB size.")), null);
  await eachBackend(async (backend) => {
    const original = backend.storage.insertIngest.bind(backend.storage);
    backend.storage.insertIngest = async () => {
      const error = new Error("D1_ERROR");
      error.cause = new Error(`${D1_DAILY_ROW_WRITE_LIMIT} See https://developers.cloudflare.com/d1/platform/limits/ for more details.`);
      throw error;
    };
    const response = await post(backend, "/ingest/shortcuts", shortcutSteps());
    assert.equal(response.status, 429);
    assert.deepEqual(await response.json(), { error: "daily_limit", limit_hit: "d1_rows_written" });
    assert.equal(response.headers.get("retry-after"), expected);
    backend.storage.insertIngest = original;
  });
  const readBackend = openMemory();
  readBackend.storage.insertIngest = async () => {
    throw new Error(D1_DAILY_ROW_READ_LIMIT);
  };
  const readResponse = await post(readBackend, "/ingest/shortcuts", shortcutSteps());
  assert.equal(readResponse.status, 429);
  assert.deepEqual(await readResponse.json(), { error: "daily_limit", limit_hit: "d1_rows_read" });
  const unmapped = openMemory();
  unmapped.storage.insertIngest = async () => {
    throw new Error("daily_limit_exceeded");
  };
  await assert.rejects(() => post(unmapped, "/ingest/shortcuts", shortcutSteps()));
});

test("38 free profile rejects a 300000 byte body", async () => {
  const response = await handleRequest(request("/ingest/shortcuts", { body: JSON.stringify({ pad: "x".repeat(300_000) }) }), ctx(openMemory().storage));
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: "payload_too_large", max_bytes: FREE_MAX_BYTES, retry: "split" });
});

test("39 near-limit and limit-hit logs omit payload values", async () => {
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    const points = Array.from({ length: 32 }, (_, index) => ({
      metric: "step_count",
      date: new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10),
      sum_qty: 1,
      last_qty: 1,
      last_ts: "2026-01-01T00:00:00Z",
      units: "count",
      n: 1,
    }));
    const near = await handleRequest(request("/import/apple-health/chunk", {
      body: JSON.stringify({ points, workouts: [], device: "CanaryDeviceName" }),
    }), ctx(openMemory().storage, { limitsProfile: "free" }));
    assert.equal(near.status, 200);
    const nearLine = lines.map((line) => JSON.parse(line)).find((line) => line.limit_near);
    assert.deepEqual(nearLine.limit_near, ["rows"]);
    assert.equal(JSON.stringify(nearLine).includes("CanaryDeviceName"), false);
    lines.length = 0;
    const overPoints = Array.from({ length: 41 }, (_, index) => ({
      metric: "step_count",
      date: new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10),
      sum_qty: 1,
      last_qty: 1,
      last_ts: "2026-01-01T00:00:00Z",
      units: "count",
      n: 1,
    }));
    const over = await handleRequest(request("/import/apple-health/chunk", {
      body: JSON.stringify({ points: overPoints, workouts: [], device: "CanaryDeviceName" }),
    }), ctx(openMemory().storage, { limitsProfile: "free" }));
    assert.equal(over.status, 413);
    const hit = lines.map((line) => JSON.parse(line)).find((line) => line.limit_hit);
    assert.equal(hit.limit_hit, "rows");
    assert.equal(JSON.stringify(hit).includes("CanaryDeviceName"), false);
  } finally {
    console.log = original;
  }
});

test("40 pre-0003 schema returns schema_outdated and still reads", async () => {
  const memory = openMemory({ writerColumn: false });
  memory.storage.workouts.set(`Walk\0legacy`, { name: "Walk", start: "legacy", date: DAY, duration_min: 10, kcal: 1, writer: null });
  memory.storage.points.set(`${DAY}\0step_count`, { date: DAY, metric: "step_count", sum_qty: 3, last_qty: 3, last_ts: "t", units: "count", n: 1 });
  const memoryResponse = await post(memory, "/ingest/shortcuts", shortcutSteps());
  assert.equal(memoryResponse.status, 500);
  assert.deepEqual(await memoryResponse.json(), { error: "schema_outdated" });
  assert.equal(memory.storage.workouts.size, 1);
  assert.equal((await memory.storage.queryDaySummary(DAY)).steps, 3);

  for (const open of [openSqlitePre0003, openD1Pre0003]) {
    const backend = open();
    backend.raw.prepare("INSERT INTO workouts (name, start, date, duration_min, kcal) VALUES (?, ?, ?, ?, ?)").run("Walk", "legacy", DAY, 10, 1);
    backend.raw.prepare("INSERT INTO points_daily (date, metric, sum_qty, last_qty, last_ts, units, n) VALUES (?, ?, ?, ?, ?, ?, ?)").run(DAY, "step_count", 3, 3, "t", "count", 1);
    const response = await post(backend, "/ingest/shortcuts", shortcutSteps());
    const text = await response.text();
    assert.equal(response.status, 500);
    assert.equal(text, "{\"error\":\"schema_outdated\"}");
    assert.equal(text.includes("writer"), false);
    assert.equal(text.includes("column"), false);
    assert.equal(backend.raw.prepare("SELECT COUNT(*) AS n FROM workouts").get().n, 1);
    assert.equal(backend.raw.prepare("SELECT COUNT(*) AS n FROM points_daily").get().n, 1);
    assert.equal((await backend.storage.listWorkouts(DAY, DAY)).length, 1);
    assert.equal((await backend.storage.queryDaySummary(DAY)).steps, 3);
    applySqliteMigrations(backend.raw);
    const next = backend.kind === "sqlite"
      ? (await import("../src/adapters/sqlite.js")).createSqliteStorage(":memory:", { database: backend.raw })
      : new (await import("../src/adapters/d1.js")).D1Storage(d1FromSqlite(backend.raw));
    const retry = await handleRequest(request("/ingest/shortcuts", { body: JSON.stringify(shortcutSteps("4")) }), ctx(next));
    assert.equal(retry.status, 200);
    await backend.close();
  }

  const postgres = await openPostgres({ migrate: false });
  if (postgres) {
    try {
      await postgres.raw.query("INSERT INTO workouts (name, start, date, duration_min, kcal) VALUES ($1,$2,$3,$4,$5)", ["Walk", "legacy", DAY, 10, 1]);
      await postgres.raw.query("INSERT INTO points_daily (date, metric, sum_qty, last_qty, last_ts, units, n) VALUES ($1,$2,$3,$4,$5,$6,$7)", [DAY, "step_count", 3, 3, "t", "count", 1]);
      const response = await post(postgres, "/ingest/shortcuts", shortcutSteps());
      const text = await response.text();
      assert.equal(response.status, 500);
      assert.equal(text, "{\"error\":\"schema_outdated\"}");
      assert.equal((await postgres.storage.queryDaySummary(DAY)).steps, 3);
      const upgraded = (await import("../src/adapters/postgres.js")).createPostgresStorageFromPool(postgres.raw);
      await upgraded.migrate();
      const retry = await handleRequest(request("/ingest/shortcuts", { body: JSON.stringify(shortcutSteps("4")) }), ctx(upgraded));
      assert.equal(retry.status, 200);
    } finally {
      await postgres.close();
    }
  }
});

test("41 formatter cache", () => {
  resetDateTimeFormatCache();
  const Original = Intl.DateTimeFormat;
  let built = 0;
  function Spy(...args) {
    built += 1;
    return new Original(...args);
  }
  Spy.prototype = Original.prototype;
  Spy.supportedLocalesOf = Original.supportedLocalesOf.bind(Original);
  Intl.DateTimeFormat = Spy;
  const started = Date.now();
  try {
    for (let index = 0; index < 1000; index += 1) localDate("2026-10-14T12:00:00Z", "America/Los_Angeles");
    for (let index = 0; index < 1000; index += 1) canonicalStart("2026-10-14T12:00:00", "America/Los_Angeles");
  } finally {
    Intl.DateTimeFormat = Original;
  }
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 250, `elapsed ${elapsed}`);
  assert.ok(built <= 4, `formatters ${built}`);
  resetDateTimeFormatCache();
});

test("42 and 43 free input record cap", async () => {
  const records = (count, day = 14) => hc({
    steps: Array.from({ length: count }, (_, index) => ({
      count: 1,
      start_time: `2026-10-${String(day).padStart(2, "0")}T00:00:${String(index % 60).padStart(2, "0")}Z`,
      end_time: `2026-10-${String(day).padStart(2, "0")}T00:01:${String(index % 60).padStart(2, "0")}Z`,
    })),
  });
  const memory = openMemory();
  const accepted = await post(memory, "/ingest/hc-webhook", records(750));
  assert.equal(accepted.status, 200);
  const rejected = await post(memory, "/ingest/hc-webhook", records(751));
  assert.equal(rejected.status, 413);
  assert.deepEqual(await rejected.json(), { error: "too_many_records", max: 750, retry: "split" });
  assert.equal(memory.storage.points.size, 1);
  const padded = records(2500);
  for (const step of padded.steps) step.pad = "x".repeat(12);
  const text = JSON.stringify(padded);
  assert.ok(Buffer.byteLength(text) < FREE_MAX_BYTES);
  assert.ok(Buffer.byteLength(text) > 200_000);
  const wide = await handleRequest(request("/ingest/hc-webhook", { body: text }), ctx(openMemory().storage));
  assert.equal(wide.status, 413);
  assert.equal((await wide.json()).error, "too_many_records");

  const oneDay = await post(openMemory(), "/ingest/hc-webhook", records(300));
  assert.equal(oneDay.status, 200);
  const two = hc({
    steps: [
      ...records(300, 14).steps,
      ...records(300, 13).steps,
    ],
  });
  const cpuBefore = process.cpuUsage();
  const twoDay = await post(openMemory(), "/ingest/hc-webhook", two);
  const cpu = process.cpuUsage(cpuBefore);
  assert.equal(twoDay.status, 200);
  assert.ok((cpu.user + cpu.system) / 1000 < 250);
  const over = await post(openMemory(), "/ingest/hc-webhook", records(751));
  assert.equal(over.status, 413);
});

test("44 one Shortcuts day fits and seven days ask for a split", async () => {
  const types = ["Steps", "Active Energy", "Resting Energy", "Dietary Energy", "Protein", "Carbohydrates", "Total Fat", "Weight", "Body Fat", "Heart Rate"];
  const dayBody = (day) => ({
    samples: types.map((type) => ({ kind: "daily", type, value: type === "Weight" ? "70" : type === "Body Fat" ? "18" : "10", date: day, unit: type === "Weight" ? "kg" : type === "Body Fat" ? "%" : undefined })),
    workouts: [0, 1, 2].map((index) => ({ type: "Walking", start: `${day}T0${index}:00:00Z`, duration: "600" })),
  });
  const one = await post(openMemory(), "/ingest/shortcuts", dayBody(DAY), { metricAllowlist: "heart_rate" });
  assert.equal(one.status, 200);
  const days = Array.from({ length: 7 }, (_, index) => `2026-10-${String(8 + index).padStart(2, "0")}`);
  const week = { samples: [], workouts: [] };
  for (const day of days) {
    const body = dayBody(day);
    week.samples.push(...body.samples);
    week.workouts.push(...body.workouts);
  }
  const blocked = await post(openMemory(), "/ingest/shortcuts", week, { metricAllowlist: "heart_rate" });
  assert.equal(blocked.status, 413);
  assert.equal((await blocked.json()).retry, "split");
  const split = openMemory();
  for (const day of days) {
    const response = await post(split, "/ingest/shortcuts", dayBody(day), { metricAllowlist: "heart_rate" });
    assert.equal(response.status, 200, day);
  }
  let steps = 0;
  for (const day of days) steps += (await split.storage.queryDaySummary(day)).steps || 0;
  assert.equal(steps, 70);
});

test("45 profile defaults fail closed", async () => {
  resetCloudflareProfileLog();
  const db = (await import("better-sqlite3")).default(":memory:");
  applySqliteMigrations(db);
  const binding = d1FromSqlite(db);
  const cases = [undefined, "", "free", "node", "Free", "paid", " free"];
  for (const value of cases) {
    const env = { DB: binding, HEALTH_INGEST_TOKEN: TOKEN, HEALTH_TIMEZONE: "UTC" };
    if (value !== undefined) env.HEALTH_LIMITS_PROFILE = value;
    const lines = [];
    const original = console.log;
    const errors = [];
    const originalError = console.error;
    console.log = (line) => lines.push(String(line));
    console.error = (line) => errors.push(String(line));
    const rowsBeforeInvalid = db.prepare("SELECT COUNT(*) AS n FROM points_daily").get().n;
    const response = await worker.fetch(new Request("http://example.test/ingest/shortcuts", {
      method: "POST",
      headers: { authorization: "Bearer tok", "content-type": "application/json" },
      body: JSON.stringify(shortcutSteps()),
    }), env);
    const mcp = await worker.fetch(new Request("http://example.test/mcp", {
      method: "POST",
      headers: { authorization: "Bearer tok", "content-type": "application/json" },
      body: "{}",
    }), env);
    console.log = original;
    console.error = originalError;
    const invalid = value === "Free" || value === "paid" || value === " free";
    if (invalid) {
      assert.equal(response.status, 503, String(value));
      assert.deepEqual(await response.json(), { error: "misconfigured" });
      assert.equal(mcp.status, 503, String(value));
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM points_daily").get().n, rowsBeforeInvalid);
      assert.ok(errors.some((line) => line.includes("limit_profile_invalid")));
    } else if (value === "node") {
      assert.equal(response.status, 200, "node");
      assert.ok(lines.some((line) => line.includes("\"limit_profile\":\"node\"")));
    } else {
      assert.equal(response.status, 200, String(value));
    }
  }
  const nodeCases = [
    [undefined, "node"],
    ["", "node"],
    ["free", "free"],
    ["node", "node"],
  ];
  for (const [value, profile] of nodeCases) {
    assert.equal(resolveLimitsProfile(value, "node").profile, profile);
  }
  for (const value of ["Free", "paid", " free"]) {
    assert.equal(resolveLimitsProfile(value, "node").invalid, true);
  }
  const spawned = spawnSync(process.execPath, ["src/adapters/node.js"], {
    env: { ...process.env, HEALTH_LIMITS_PROFILE: "paid", HEALTH_INGEST_TOKEN: TOKEN },
    encoding: "utf8",
  });
  assert.equal(spawned.status, 1);
  assert.match(spawned.stderr, /HEALTH_LIMITS_PROFILE/);
  assert.equal(spawned.stderr.includes("paid"), false);
});

test("deploy runbook applies 0003, checks writer, then deploys", () => {
  const runbook = fs.readFileSync(new URL("../docs/deploy-runbook.md", import.meta.url), "utf8");
  const notes = fs.readFileSync(new URL("../docs/release-notes.md", import.meta.url), "utf8");
  for (const text of [runbook, notes]) {
    const apply = text.indexOf("wrangler d1 migrations apply");
    const pragma = text.indexOf("PRAGMA table_info(workouts)");
    const deploy = text.indexOf("wrangler deploy");
    assert.ok(apply >= 0 && pragma > apply && deploy > pragma);
  }
  assert.equal(migrationFiles().some((file) => file.id.includes("0004")), false);
});

test("json helper stays available", () => {
  assert.equal(json({ ok: true }).status, 200);
});

function sensitiveBody() {
  const time = "2026-10-14T08:00:00Z";
  return hc({
    device: "CanaryDeviceName",
    note: "CanaryNoteValue",
    steps: [{ count: 10, start_time: time, end_time: "2026-10-14T09:00:00Z" }],
    blood_glucose: [{ mmol_per_liter: 5.5, time }],
    basal_body_temperature: [{ celsius: 36.5, time }],
    body_temperature: [{ celsius: 37, time }],
    skin_temperature: [{ time, measurement_location: 1, delta_celsius: 0.2 }],
    menstruation_flow: [{ flow: 1, time }],
    menstruation_period: [{ flow: 1, time }],
    intermenstrual_bleeding: [{ time }],
    ovulation_test: [{ result: 1, time }],
    cervical_mucus: [{ appearance: 1, time }],
    sexual_activity: [{ protection_used: 1, time }],
    sleep: [{
      session_end_time: "2026-10-14T06:30:00Z",
      duration_seconds: 1000,
      stages: [{ stage: "STAGE_TYPE_DEEP", start_time: "2026-10-14T02:00:00Z", end_time: "2026-10-14T03:00:00Z", duration_seconds: 3600 }],
    }],
  });
}

