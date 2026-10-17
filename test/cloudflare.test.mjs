import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs";
import { test } from "node:test";
import { contextFromEnv } from "../src/adapters/cloudflare.js";
import { D1Storage } from "../src/adapters/d1.js";
import { applySqliteMigrations } from "../src/adapters/sqlite.js";
import { D1_BATCH_LIMIT } from "../src/adapters/statements.js";
import { handleRequest } from "../src/core/http.js";
import { LATEST_METRICS, SUM_METRICS } from "../src/core/metrics.js";
import worker from "../src/index.js";
import { expectedSummary, summaryDate } from "./expected.mjs";

function sealBackfill(db) {
  db.prepare(
    "INSERT INTO ingest_backfill (id, opened_at, closed_at, bytes, days) VALUES (1, ?, ?, 0, 0)",
  ).run("2026-10-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z");
}

function fetchAt(request, env) {
  return handleRequest(request, { ...contextFromEnv(env), now: env.now });
}

const sample = JSON.parse(fs.readFileSync(new URL("./sample.json", import.meta.url), "utf8"));

const fixtureClock = {
  now: new Date("2026-10-16T12:00:00Z"),
  INGEST_MAX_AGE_DAYS: "30",
  INGEST_MAX_BODY_BYTES: "5000000",
  INGEST_RATE_LIMIT_PER_HOUR: "0",
};

function d1FromSqlite(db, writes) {
  function statement(sql, params = []) {
    return {
      sql,
      params,
      bind(...next) {
        return statement(sql, next);
      },
      async all() {
        return { results: db.prepare(sql).all(...params) };
      },
      async first() {
        return db.prepare(sql).get(...params) ?? null;
      },
      async run() {
        if (writes && /^\s*INSERT/i.test(sql)) writes.n += 1;
        db.prepare(sql).run(...params);
        return { success: true };
      },
    };
  }
  return {
    prepare(sql) {
      return statement(sql);
    },
    async batch(statements) {
      db.transaction((list) => {
        for (const stmt of list) {
          if (writes && /^\s*INSERT/i.test(stmt.sql)) writes.n += 1;
          db.prepare(stmt.sql).run(...stmt.params);
        }
      })(statements);
      return [];
    },
  };
}

function sevenDayPayload() {
  const names = [
    ...Object.keys(SUM_METRICS),
    ...Object.keys(LATEST_METRICS),
    ...Array.from({ length: 40 }, (_, index) => `extra_metric_${index}`),
  ];
  const metrics = names.map((name) => {
    const data = [];
    for (let day = 0; day < 7; day++) {
      const date = `2026-10-${String(8 + day).padStart(2, "0")}`;
      for (let slot = 0; slot < 48; slot++) {
        const hour = String(Math.floor(slot / 2)).padStart(2, "0");
        const minute = slot % 2 ? "30" : "00";
        data.push({ date: `${date} ${hour}:${minute}:00 -0700`, qty: 1 });
      }
    }
    return { name, units: name === "weight_body_mass" ? "lb" : "count", data };
  });
  const workouts = [];
  for (let day = 0; day < 7; day++) {
    const date = `2026-10-${String(8 + day).padStart(2, "0")}`;
    workouts.push(
      { name: "Walk", start: `${date} 08:00:00 -0700`, duration: 1800, activeEnergyBurned: { qty: 100, units: "kcal" } },
      { name: "Run", start: `${date} 18:00:00 -0700`, duration: 1800, activeEnergyBurned: { qty: 200, units: "kcal" } },
    );
  }
  return { data: { metrics, workouts } };
}

test("cloudflare adapter ingests and summarizes through D1", async () => {
  const source = fs.readFileSync(new URL("../src/adapters/cloudflare.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\bnow\b/);
  const db = new Database(":memory:");
  applySqliteMigrations(db);
  sealBackfill(db);
  const env = { DB: d1FromSqlite(db), HEALTH_INGEST_TOKEN: "tok", HEALTH_TIMEZONE: "UTC", ...fixtureClock };

  const denied = await worker.fetch(new Request(`http://example.test/summary?date=${summaryDate}`), env);
  assert.equal(denied.status, 401);

  const ingested = await fetchAt(new Request("http://example.test/ingest", {
    method: "POST",
    headers: { authorization: "Bearer tok", "content-type": "application/json" },
    body: JSON.stringify(sample),
  }), env);
  assert.equal(ingested.status, 200);
  assert.equal((await ingested.json()).points, 11);

  const summarized = await fetchAt(
    new Request(`http://example.test/summary?date=${summaryDate}`, { headers: { authorization: "Bearer tok" } }),
    env,
  );
  assert.deepEqual(await summarized.json(), expectedSummary);
  db.close();
});

test("cloudflare adapter splits D1 writes into batches of 500", async () => {
  const batches = [];
  const db = {
    prepare(sql) {
      return {
        bind(...params) {
          return {
            sql,
            params,
            async all() {
              return { results: [] };
            },
          };
        },
      };
    },
    async batch(statements) {
      batches.push(statements.length);
    },
  };
  const points = Array.from({ length: D1_BATCH_LIMIT }, (_, index) => ({
    date: `2026-10-${String((index % 28) + 1).padStart(2, "0")}`,
    metric: `step_count_${index}`,
    sum_qty: 1,
    last_qty: 1,
    last_ts: summaryDate,
    units: "count",
    n: 1,
  }));
  await new D1Storage(db).insertIngest({
    id: "id",
    date: summaryDate,
    receivedAt: "2026-10-14T00:00:00Z",
    bytes: 1,
    payload: "{}",
    storeRaw: true,
    points,
    workouts: [],
  });
  assert.deepEqual(batches, [D1_BATCH_LIMIT, 1]);
});

test("a 7-day all-metrics upload writes fewer than 200 rows", async () => {
  const db = new Database(":memory:");
  applySqliteMigrations(db);
  sealBackfill(db);
  const writes = { n: 0 };
  const env = { DB: d1FromSqlite(db, writes), HEALTH_INGEST_TOKEN: "tok", HEALTH_TIMEZONE: "UTC", ...fixtureClock };
  const payload = sevenDayPayload();
  const sampleCount = payload.data.metrics.reduce((sum, metric) => sum + metric.data.length, 0);

  const ingested = await fetchAt(new Request("http://example.test/ingest", {
    method: "POST",
    headers: { authorization: "Bearer tok", "content-type": "application/json" },
    body: JSON.stringify(payload),
  }), env);
  assert.equal(ingested.status, 200);
  const body = await ingested.json();
  assert.ok(sampleCount > 10_000);
  assert.ok(body.points > 1000);
  assert.ok(writes.n < 200, `wrote ${writes.n} rows`);

  const storedMetrics = db.prepare("SELECT COUNT(*) AS n FROM points_daily").get().n;
  const extras = db.prepare("SELECT COUNT(*) AS n FROM points_daily WHERE metric LIKE 'extra_metric_%'").get().n;
  const workouts = db.prepare("SELECT COUNT(*) AS n FROM workouts").get().n;
  assert.equal(extras, 0);
  assert.equal(storedMetrics, 7 * (Object.keys(SUM_METRICS).length + Object.keys(LATEST_METRICS).length));
  assert.equal(workouts, 14);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM raw_payloads").get().n, 0);
  assert.equal(writes.n, storedMetrics + workouts);

  const day = await (await fetchAt(
    new Request("http://example.test/summary?date=2026-10-08", { headers: { authorization: "Bearer tok" } }),
    env,
  )).json();
  assert.equal(day.steps, 48);
  assert.equal(day.workouts.length, 2);

  const before = writes.n;
  const again = await fetchAt(new Request("http://example.test/ingest", {
    method: "POST",
    headers: { authorization: "Bearer tok", "content-type": "application/json" },
    body: JSON.stringify(payload),
  }), env);
  assert.equal(again.status, 200);
  assert.equal(writes.n - before, 0);
  const retried = await (await fetchAt(
    new Request("http://example.test/summary?date=2026-10-08", { headers: { authorization: "Bearer tok" } }),
    env,
  )).json();
  assert.equal(retried.steps, 48);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM points_daily").get().n, storedMetrics);
  db.close();
});

test("a partial re-send does not overwrite the full-day total", async () => {
  const db = new Database(":memory:");
  applySqliteMigrations(db);
  sealBackfill(db);
  const env = { DB: d1FromSqlite(db), HEALTH_INGEST_TOKEN: "tok", HEALTH_TIMEZONE: "UTC", ...fixtureClock };
  const post = (body) => fetchAt(new Request("http://example.test/ingest", {
    method: "POST",
    headers: { authorization: "Bearer tok", "content-type": "application/json" },
    body: JSON.stringify(body),
  }), env);
  const full = await post({
    data: {
      metrics: [{
        name: "step_count",
        units: "count",
        data: [
          { date: "2026-10-14 08:00:00 -0700", qty: 1000 },
          { date: "2026-10-14 12:00:00 -0700", qty: 2000 },
          { date: "2026-10-14 18:00:00 -0700", qty: 3000 },
        ],
      }],
    },
  });
  assert.equal(full.status, 200);
  const partial = await post({
    data: {
      metrics: [
        { name: "step_count", units: "count", data: [{ date: "2026-10-14 08:00:00 -0700", qty: 5 }] },
      ],
    },
  });
  assert.equal(partial.status, 200);
  const summary = await (await fetchAt(
    new Request("http://example.test/summary?date=2026-10-14", { headers: { authorization: "Bearer tok" } }),
    env,
  )).json();
  assert.equal(summary.steps, 6000);
  const row = db.prepare("SELECT sum_qty, n FROM points_daily WHERE date = ? AND metric = ?").get("2026-10-14", "step_count");
  assert.deepEqual(row, { sum_qty: 6000, n: 3 });
  db.close();
});

test("D1 skips a raw payload larger than 1.5MB", async () => {
  const db = new Database(":memory:");
  applySqliteMigrations(db);
  sealBackfill(db);
  const big = "x".repeat(1_500_001);
  await new D1Storage(d1FromSqlite(db)).insertIngest({
    id: "big",
    date: summaryDate,
    receivedAt: "2026-10-16T00:00:00.000Z",
    bytes: big.length,
    payload: big,
    storeRaw: true,
    points: [{
      date: summaryDate,
      metric: "step_count",
      sum_qty: 7,
      last_qty: 7,
      last_ts: "2026-10-14 09:00:00",
      units: "count",
      n: 1,
    }],
    workouts: [],
  });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM raw_payloads").get().n, 0);
  assert.equal(db.prepare("SELECT sum_qty FROM points_daily").get().sum_qty, 7);
  db.close();
});

test("cloudflare adapter serves the read-only MCP tools", async () => {
  const db = new Database(":memory:");
  applySqliteMigrations(db);
  sealBackfill(db);
  const env = { DB: d1FromSqlite(db), HEALTH_INGEST_TOKEN: "tok", HEALTH_TIMEZONE: "UTC", ...fixtureClock };
  const headers = { authorization: "Bearer tok", "content-type": "application/json", accept: "application/json, text/event-stream" };
  const denied = await fetchAt(new Request("http://example.test/mcp", { method: "POST", body: "{}" }), env);
  assert.equal(denied.status, 401);

  const blocked = await fetchAt(new Request("http://example.test/mcp", {
    method: "POST",
    headers: { authorization: "Bearer tok", origin: "https://example.com", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  }), env);
  assert.equal(blocked.status, 403);
  const allowed = await fetchAt(new Request("http://example.test/mcp", {
    method: "POST",
    headers: { authorization: "Bearer tok", origin: "https://example.com", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  }), { ...env, MCP_ALLOWED_ORIGINS: "https://example.com" });
  assert.equal(allowed.status, 200);

  const ingested = await fetchAt(new Request("http://example.test/ingest", {
    method: "POST",
    headers,
    body: JSON.stringify(sample),
  }), env);
  assert.equal(ingested.status, 200);

  const call = async (name, args) => {
    const response = await fetchAt(new Request("http://example.test/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }), env);
    assert.equal(response.status, 200);
    return (await response.json()).result;
  };

  const summary = await call("get_daily_summary", { date: summaryDate });
  assert.deepEqual(summary.structuredContent, expectedSummary);
  const metric = await call("get_metric", { metric: "step_count", start_date: summaryDate, end_date: summaryDate });
  assert.equal(metric.structuredContent.rows[0].sum_qty, 9321);
  const metrics = await call("list_metrics", {});
  assert.equal(metrics.structuredContent.metrics.find((entry) => entry.name === "step_count").summary_field, "steps");
  const workouts = await call("list_workouts", { start_date: summaryDate, end_date: summaryDate });
  assert.equal(workouts.structuredContent.workouts[0].kcal, 310);
  const bad = await call("get_daily_summary", { date: "nope" });
  assert.equal(bad.isError, true);
  db.close();
});
