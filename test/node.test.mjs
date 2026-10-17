import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { migrationFiles } from "../src/adapters/migrate.js";
import { createNodeStorage, startServer } from "../src/adapters/node.js";
import { createPostgresStorageFromPool } from "../src/adapters/postgres.js";
import { applySqliteMigrations } from "../src/adapters/sqlite.js";
import { INSERT_RAW, LIST_METRICS, METRIC_RANGE, POINTS_FOR_DATE, toPostgres, UPSERT_POINT, WORKOUTS_RANGE } from "../src/adapters/statements.js";
import { expectedSummary, summaryDate } from "./expected.mjs";

const sample = JSON.parse(fs.readFileSync(new URL("./sample.json", import.meta.url), "utf8"));

test("migration SQL stays portable", () => {
  const files = migrationFiles();
  assert.deepEqual(files.map((file) => file.id), ["0001_init.sql", "0002_daily_points.sql", "0003_ingest_guards.sql"]);
  for (const file of files) {
    assert.doesNotMatch(file.sql, /AUTOINCREMENT|WITHOUT ROWID|INSERT OR REPLACE|PRAGMA/i);
  }
  assert.match(files[0].sql, /CREATE TABLE IF NOT EXISTS raw_payloads/i);
  assert.match(files[1].sql, /CREATE TABLE IF NOT EXISTS points_daily/i);
});

test("daily migration rolls per-sample rows into one row per metric and day", () => {
  const db = new Database(":memory:");
  db.exec(migrationFiles()[0].sql);
  const insert = db.prepare("INSERT INTO points (metric, ts, date, units, qty) VALUES (?, ?, ?, ?, ?)");
  insert.run("step_count", "2026-10-14 09:00:00", "2026-10-14", "count", 10);
  insert.run("step_count", "2026-10-14 18:00:00", "2026-10-14", "count", 3);
  insert.run("step_count", "2026-10-15 09:00:00", "2026-10-15", "count", 7);
  applySqliteMigrations(db);
  applySqliteMigrations(db);
  const rows = db.prepare(
    "SELECT date, metric, sum_qty, last_qty, last_ts, n FROM points_daily ORDER BY date",
  ).all();
  assert.deepEqual(rows, [
    { date: "2026-10-14", metric: "step_count", sum_qty: 13, last_qty: 3, last_ts: "2026-10-14 18:00:00", n: 2 },
    { date: "2026-10-15", metric: "step_count", sum_qty: 7, last_qty: 7, last_ts: "2026-10-15 09:00:00", n: 1 },
  ]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM points").get().n, 3);
  db.close();
});

test("node sqlite adapter serves ingest and summary over HTTP", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "health-mcp-"));
  const storage = await createNodeStorage({ SQLITE_PATH: path.join(dir, "nested", "health.sqlite") });
  const server = await startServer({
    storage,
    token: "tok",
    timeZone: "UTC",
    port: 0,
    host: "127.0.0.1",
    now: new Date("2026-10-14T20:00:00Z"),
    ingestRatePerHour: 0,
  });
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    const denied = await fetch(`${base}/summary?date=${summaryDate}`);
    assert.equal(denied.status, 401);

    const ingested = await fetch(`${base}/ingest`, {
      method: "POST",
      headers: { authorization: "Bearer tok", "content-type": "application/json" },
      body: JSON.stringify(sample),
    });
    assert.equal(ingested.status, 200);
    const ingestBody = await ingested.json();
    assert.equal(ingestBody.workouts, 1);
    assert.deepEqual(ingestBody.dates, [summaryDate]);

    const summarized = await fetch(`${base}/summary?date=${summaryDate}`, {
      headers: { authorization: "Bearer tok" },
    });
    assert.deepEqual(await summarized.json(), expectedSummary);

    const replaced = structuredClone(sample);
    replaced.data.metrics.find((metric) => metric.name === "weight_body_mass").data = [
      { date: "2026-10-14 07:00:00 -0700", qty: 170 },
    ];
    const again = await fetch(`${base}/ingest`, {
      method: "POST",
      headers: { authorization: "Bearer tok", "content-type": "application/json" },
      body: JSON.stringify(replaced),
    });
    assert.equal(again.status, 200);
    const after = await (await fetch(`${base}/summary?date=${summaryDate}`, {
      headers: { authorization: "Bearer tok" },
    })).json();
    assert.deepEqual(after.weight, { value: 170, units: "lb" });

    const mcp = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        authorization: "Bearer tok",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_metric", arguments: { metric: "step_count", start_date: summaryDate, end_date: summaryDate } },
      }),
    });
    assert.equal(mcp.status, 200);
    const metric = (await mcp.json()).result.structuredContent;
    assert.equal(metric.rows[0].sum_qty, 9321);
    const names = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer tok", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_metrics" } }),
    });
    const listed = (await names.json()).result.structuredContent.metrics.map((entry) => entry.name);
    assert.ok(listed.includes("step_count"));
    const mcpDenied = await fetch(`${base}/mcp`, { method: "POST", body: "{}" });
    assert.equal(mcpDenied.status, 401);
    const blockedOrigin = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer tok", origin: "https://example.com", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" }),
    });
    assert.equal(blockedOrigin.status, 403);
    const tooBig = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer tok", "content-type": "application/json" },
      body: "x".repeat(64 * 1024 + 1),
    });
    assert.equal(tooBig.status, 413);
    const declared = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        headers: {
          authorization: "Bearer tok",
          "content-type": "application/json",
          "content-length": String(64 * 1024 + 1),
        },
      }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      });
      req.on("error", reject);
      req.end("{}");
    });
    assert.equal(declared, 413);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("node storage rejects an unsupported DATABASE_URL", async () => {
  await assert.rejects(
    () => createNodeStorage({ DATABASE_URL: "mysql://localhost/health" }),
    /postgres URL or a SQLite file path/,
  );
});

test("postgres adapter writes portable upserts and summarizes returned rows", async () => {
  const queries = [];
  let pointReads = 0;
  const rowsFor = (sql) => {
    if (sql.includes("GROUP BY metric")) return [{ metric: "step_count" }];
    if (sql.includes("FROM points_daily") && sql.includes(">=")) {
      return [{
        date: summaryDate,
        metric: "step_count",
        sum_qty: "4",
        last_qty: "4",
        last_ts: "2026-10-14 09:00:00",
        units: "count",
        n: "1",
      }];
    }
    if (sql === toPostgres(POINTS_FOR_DATE)) {
      pointReads += 1;
      if (pointReads === 1) return [];
      return [{
        date: summaryDate,
        metric: "step_count",
        sum_qty: "9321",
        last_qty: "9321",
        last_ts: "2026-10-14 09:00:00",
        units: "count",
        n: "1",
      }];
    }
    if (sql.includes("FROM workouts") && sql.includes(">=")) {
      return [{ name: "Walk", start: "2026-10-14 12:00:00 -0700", date: summaryDate, duration_min: "30", kcal: "120" }];
    }
    if (sql.startsWith("SELECT name")) {
      return [{ name: "Walk", start: "2026-10-14 12:00:00 -0700", duration_min: "30", kcal: "120" }];
    }
    return [];
  };
  const client = {
    async query(sql, params) {
      queries.push({ sql, params });
      return { rows: rowsFor(sql) };
    },
    release() {},
  };
  const pool = {
    async query(sql, params) {
      queries.push({ sql, params });
      return { rows: rowsFor(sql) };
    },
    async connect() {
      return client;
    },
    async end() {},
  };

  const storage = createPostgresStorageFromPool(pool);
  await storage.migrate();
  await storage.insertIngest({
    id: "id",
    date: summaryDate,
    receivedAt: "2026-10-16T00:00:00.000Z",
    bytes: 2,
    payload: "{}",
    storeRaw: true,
    points: [{
      date: summaryDate,
      metric: "step_count",
      sum_qty: 9321,
      last_qty: 9321,
      last_ts: "2026-10-14 09:00:00",
      units: "count",
      n: 1,
    }],
    workouts: [{ name: "Walk", start: "2026-10-14 12:00:00 -0700", date: summaryDate, duration_min: 30, kcal: 120 }],
  });
  const summary = await storage.queryDaySummary(summaryDate);
  assert.deepEqual(await storage.listMetrics(), ["step_count"]);
  const range = await storage.queryMetricRange("step_count", summaryDate, summaryDate);
  assert.equal(range[0].sum_qty, "4");
  const rangedWorkouts = await storage.listWorkouts(summaryDate, summaryDate);
  assert.equal(rangedWorkouts[0].date, summaryDate);
  await storage.close();

  assert.equal(summary.steps, 9321);
  assert.deepEqual(summary.workouts, [{ name: "Walk", start: "2026-10-14 12:00:00 -0700", duration_min: 30, kcal: 120 }]);
  const raw = queries.find((query) => query.sql === toPostgres(INSERT_RAW));
  assert.deepEqual(raw.params, ["id", summaryDate, "2026-10-16T00:00:00.000Z", 2, "{}"]);
  const point = queries.find((query) => query.sql === toPostgres(UPSERT_POINT));
  assert.match(point.sql, /ON CONFLICT\(date, metric\)/);
  assert.match(point.sql, /WHERE excluded\.n >= points_daily\.n/);
  assert.match(point.sql, /points_daily/);
  assert.deepEqual(point.params, [summaryDate, "step_count", 9321, 9321, "2026-10-14 09:00:00", "count", 1]);
  assert.equal(queries.some((query) => query.sql === toPostgres(POINTS_FOR_DATE)), true);
  assert.equal(queries.some((query) => query.sql === toPostgres(LIST_METRICS)), true);
  const metricQuery = queries.find((query) => query.sql === toPostgres(METRIC_RANGE));
  assert.deepEqual(metricQuery.params, ["step_count", summaryDate, summaryDate]);
  assert.equal(queries.some((query) => query.sql === toPostgres(WORKOUTS_RANGE)), true);
  assert.equal(queries.some((query) => /CREATE TABLE IF NOT EXISTS raw_payloads/i.test(query.sql)), true);
  assert.equal(queries.some((query) => /CREATE TABLE IF NOT EXISTS points_daily/i.test(query.sql)), true);
});
