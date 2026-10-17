import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import Database from "better-sqlite3";
import { test } from "node:test";
import { applyD1Migrations, D1Storage } from "../src/adapters/d1.js";
import { migrationFiles } from "../src/adapters/migrate.js";
import { startServer } from "../src/adapters/node.js";
import { applySqliteMigrations, createSqliteStorage } from "../src/adapters/sqlite.js";
import { RESERVE_BACKFILL, splitStatements } from "../src/adapters/statements.js";
import { handleRequest } from "../src/core/http.js";
import { parseAppleExport } from "../src/core/apple-export.js";
import { HK_QUANTITY_METRICS } from "../src/core/hk.js";
import { D1_STATEMENT_BUDGET, EXPORT_HINT, MAX_INGEST_DATES, byteShares, dateGroups, projectedIngestStatements, resolveMaxStatements, resolveMinDate } from "../src/core/ingest-guard.js";
import { MemoryStorage } from "../src/core/memory.js";

const NOW = new Date("2026-10-16T12:30:00Z");
const DEADLINE = "2026-10-19T12:30:00.000Z";

function request(body, headers = {}) {
  const initHeaders = new Headers(headers);
  if (!initHeaders.has("authorization")) initHeaders.set("authorization", "Bearer tok");
  if (body != null && !initHeaders.has("content-type")) initHeaders.set("content-type", "application/json");
  return new Request("http://localhost/ingest", { method: "POST", headers: initHeaders, body });
}

function ctx(storage, extra = {}) {
  return { token: "tok", timeZone: "UTC", storage, now: NOW, ...extra };
}

function steps(date, qty = 1) {
  return {
    data: {
      metrics: [{ name: "step_count", units: "count", data: [{ date: `${date} 09:00:00 +0000`, qty }] }],
    },
  };
}

function exactSize(date, size) {
  const empty = JSON.stringify({ ...steps(date, 1), pad: "" });
  const body = { ...steps(date, 1), pad: "x".repeat(size - empty.length) };
  assert.equal(Buffer.byteLength(JSON.stringify(body)), size);
  return body;
}

function shiftDate(iso, days) {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

function history(count, start = "2020-01-01") {
  const data = [];
  for (let i = 0; i < count; i++) data.push({ date: `${shiftDate(start, i)} 09:00:00 +0000`, qty: 1 });
  return {
    data: {
      metrics: [{ name: "step_count", units: "count", data }],
      workouts: [{ name: "Walk", start: `${start} 08:00:00 +0000`, end: `${start} 08:30:00 +0000`, duration: 1800 }],
    },
  };
}

function seal(storage) {
  storage.backfill = {
    opened_at: "2026-10-01T00:00:00.000Z",
    closed_at: "2026-10-01T00:00:00.000Z",
    bytes: 0,
    days: 0,
    deadline: "2026-10-04T00:00:00.000Z",
    total_bytes: 1000,
  };
  return storage;
}

function d1FromSqlite(db, counter = null) {
  function note(sql) {
    if (!counter) return;
    counter.n += 1;
    if (counter.sql) counter.sql.push(sql);
  }
  function run(sql, params) {
    note(sql);
    try {
      return db.prepare(sql).all(...params);
    } catch (error) {
      if (!/does not return/i.test(String(error?.message))) throw error;
      db.prepare(sql).run(...params);
      return [];
    }
  }
  function statement(sql, params = []) {
    return {
      sql,
      params,
      bind(...next) {
        return statement(sql, next);
      },
      async all() {
        return { results: run(sql, params) };
      },
    };
  }
  return {
    prepare(sql) {
      return statement(sql);
    },
    async batch(statements) {
      const out = [];
      db.transaction((list) => {
        for (const stmt of list) out.push({ results: run(stmt.sql, stmt.params) });
      })(statements);
      return out;
    },
  };
}

test("an empty or future-only body does not open the window", async () => {
  for (const body of [
    { data: { metrics: [] } },
    steps("2026-10-18", 4),
  ]) {
    const storage = new MemoryStorage();
    const response = await handleRequest(request(JSON.stringify(body)), ctx(storage));
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.written, 0);
    assert.equal(payload.backfill.open, false);
    assert.equal(payload.backfill.bytes_remaining, 0);
    assert.equal(storage.backfill, null);
  }
});

test("a pure done closes a window that was never opened", async () => {
  const storage = new MemoryStorage();
  const response = await handleRequest(request(JSON.stringify({ backfill: "done" })), ctx(storage));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.backfill.open, false);
  assert.equal(payload.backfill.bytes_remaining, 0);
  assert.ok(storage.backfill.closed_at);
});

test("dates before the minimum are rejected and a later minimum is configurable", async () => {
  const early = new MemoryStorage();
  const rejected = await handleRequest(request(JSON.stringify(steps("1900-01-01", 3))), ctx(early));
  assert.equal(rejected.status, 422);
  const rejectedBody = await rejected.json();
  assert.match(rejectedBody.message, /2000-01-01/);
  assert.equal(rejectedBody.backfill.bytes_remaining, 0);
  assert.equal(early.backfill, null);
  assert.equal(early.exportHint, EXPORT_HINT);
  assert.equal((await early.queryDaySummary("1900-01-01")).steps, null);

  const accepted = new MemoryStorage();
  const ok = await handleRequest(request(JSON.stringify(steps("2000-01-01", 3))), ctx(accepted));
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).backfill.open, true);
  assert.equal((await accepted.queryDaySummary("2000-01-01")).steps, 3);

  const custom = new MemoryStorage();
  const customRejected = await handleRequest(
    request(JSON.stringify(steps("2014-12-31", 2))),
    ctx(custom, { ingestMinDate: "2015-01-01" }),
  );
  assert.equal(customRejected.status, 422);
  assert.match((await customRejected.json()).message, /2015-01-01/);
  assert.equal(custom.backfill, null);
});

test("a closed window reports no bytes remaining and hints when every point is too old", async () => {
  const storage = seal(new MemoryStorage());
  const response = await handleRequest(request(JSON.stringify(steps("2020-01-02", 8))), ctx(storage));
  assert.equal(response.status, 422);
  const payload = await response.json();
  assert.equal(payload.backfill.open, false);
  assert.equal(payload.backfill.bytes_remaining, 0);
  assert.equal(storage.exportHint, EXPORT_HINT);
  assert.equal((await storage.queryDaySummary("2020-01-02")).steps, null);

  const mixed = seal(new MemoryStorage());
  const recent = await handleRequest(request(JSON.stringify({
    data: {
      metrics: [{
        name: "step_count",
        units: "count",
        data: [
          { date: "2020-01-02 09:00:00 +0000", qty: 1 },
          { date: "2026-10-16 09:00:00 +0000", qty: 6 },
        ],
      }],
    },
  })), ctx(mixed));
  assert.equal(recent.status, 200);
  assert.equal((await recent.json()).dropped_stale, 1);
  assert.equal(mixed.exportHint, null);
});

test("the stored deadline and total stay in force when the settings are raised", async () => {
  const expired = new MemoryStorage();
  expired.backfill = {
    opened_at: "2026-10-01T00:00:00.000Z",
    closed_at: null,
    bytes: 20,
    days: 1,
    deadline: "2026-10-02T00:00:00.000Z",
    total_bytes: 500_000_000,
  };
  const late = await handleRequest(
    request(JSON.stringify(steps("2020-02-02", 1))),
    ctx(expired, { ingestBackfillHours: 24 * 300 }),
  );
  assert.equal(late.status, 422);
  assert.ok(expired.backfill.closed_at);
  assert.equal((await expired.queryDaySummary("2020-02-02")).steps, null);

  const capped = new MemoryStorage();
  const first = exactSize("2020-02-03", 400);
  const opened = await handleRequest(
    request(JSON.stringify(first)),
    ctx(capped, { ingestBackfillTotalBytes: 1000 }),
  );
  assert.equal(opened.status, 200);
  assert.equal(capped.backfill.total_bytes, 1000);
  const second = exactSize("2020-02-04", 700);
  const over = await handleRequest(
    request(JSON.stringify(second)),
    ctx(capped, { ingestBackfillTotalBytes: 500_000 }),
  );
  assert.equal(over.status, 413);
  assert.equal(capped.backfill.bytes, 400);
  assert.equal((await capped.queryDaySummary("2020-02-04")).steps, null);
});

test("byte length counts UTF-8 bytes and a gzip body is not decoded", async () => {
  const storage = new MemoryStorage();
  const body = { ...steps("2020-03-03", 4), note: "€" };
  const text = JSON.stringify(body);
  assert.notEqual(text.length, Buffer.byteLength(text));
  const response = await handleRequest(request(text), ctx(storage));
  assert.equal(response.status, 200);
  assert.equal(storage.backfill.bytes, Buffer.byteLength(text));

  const sealed = seal(new MemoryStorage());
  const gzip = zlib.gzipSync(Buffer.from(JSON.stringify(steps("2026-10-16", 9))));
  const encoded = await handleRequest(request(gzip, {
    "content-type": "application/json",
    "content-encoding": "gzip",
  }), ctx(sealed, { ingestRatePerHour: 1 }));
  assert.equal(encoded.status, 400);
  assert.equal((await encoded.json()).error, "invalid_json");
  assert.equal((await sealed.queryDaySummary("2026-10-16")).steps, null);
  const follow = await handleRequest(
    request(JSON.stringify(steps("2026-10-16", 2))),
    ctx(sealed, { ingestRatePerHour: 1 }),
  );
  assert.equal(follow.status, 429);
});

test("invalid JSON consumes a rate slot and a size reject does not", async () => {
  const limited = seal(new MemoryStorage());
  const bad = await handleRequest(request("{"), ctx(limited, { ingestRatePerHour: 1 }));
  assert.equal(bad.status, 400);
  const afterBad = await handleRequest(
    request(JSON.stringify(steps("2026-10-16", 2))),
    ctx(limited, { ingestRatePerHour: 1 }),
  );
  assert.equal(afterBad.status, 429);

  const sized = seal(new MemoryStorage());
  const tooBig = "x".repeat(1001);
  const over = await handleRequest(
    request(tooBig),
    ctx(sized, { ingestRatePerHour: 1, ingestMaxBodyBytes: 1000, ingestBackfillMaxBytes: 1000 }),
  );
  assert.equal(over.status, 413);
  const afterOver = await handleRequest(
    request(JSON.stringify(steps("2026-10-16", 2))),
    ctx(sized, { ingestRatePerHour: 1, ingestMaxBodyBytes: 1000, ingestBackfillMaxBytes: 1000 }),
  );
  assert.equal(afterOver.status, 200);
});

test("a declared length above the bytes remaining is cancelled before it is read", async () => {
  const storage = new MemoryStorage();
  const opened = await handleRequest(
    request(JSON.stringify(steps("2020-04-01", 1))),
    ctx(storage, { ingestBackfillTotalBytes: 2000 }),
  );
  assert.equal(opened.status, 200);
  const remaining = storage.backfill.total_bytes - storage.backfill.bytes;
  let pulls = 0;
  let cancelled = false;
  const response = await handleRequest(new Request("http://localhost/ingest", {
    method: "POST",
    headers: {
      authorization: "Bearer tok",
      "content-type": "application/json",
      "content-length": String(remaining + 1),
    },
    body: new ReadableStream({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(200));
      },
      cancel() {
        cancelled = true;
      },
    }),
    duplex: "half",
  }), ctx(storage, { ingestBackfillTotalBytes: 2000 }));
  assert.equal(response.status, 413);
  assert.match((await response.json()).message, /initial import total/);
  assert.equal(cancelled, true);
  assert.equal(pulls, 0);
  assert.equal(storage.backfill.bytes, 2000 - remaining);
});

test("more than 366 dates is rejected before a window row is created", async () => {
  const storage = new MemoryStorage();
  const response = await handleRequest(
    request(JSON.stringify(history(MAX_INGEST_DATES + 1))),
    ctx(storage),
  );
  assert.equal(response.status, 413);
  const payload = await response.json();
  assert.match(payload.message, new RegExp(String(MAX_INGEST_DATES)));
  assert.match(payload.message, /5 MB/);
  assert.equal(storage.backfill, null);
});

test("one request reads a date range and stays under the query bound", async () => {
  const db = new Database(":memory:");
  applySqliteMigrations(db);
  const counter = { n: 0, sql: [] };
  const storage = new D1Storage(d1FromSqlite(db, counter));
  const response = await handleRequest(
    request(JSON.stringify(history(300))),
    ctx(storage),
  );
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  assert.ok(counter.n < 20, `queries ${counter.n}`);
  assert.ok(counter.sql.some((sql) => sql.includes("json_each")));
  assert.equal(counter.sql.some((sql) => sql.includes("FROM points_daily") && sql.includes("date >= ?")), false);
  assert.equal(counter.sql.some((sql) => /WHERE date = \?/.test(sql)), false);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM points_daily").get().n, 300);
  db.close();
});

test("concurrent posts cannot pass the stored total", async () => {
  const storage = new MemoryStorage();
  const dates = ["2020-05-01", "2020-05-02", "2020-05-03", "2020-05-04", "2020-05-05"];
  const responses = await Promise.all(dates.map((date) => handleRequest(
    request(JSON.stringify(exactSize(date, 723))),
    ctx(storage, { ingestBackfillTotalBytes: 1000 }),
  )));
  const statuses = [];
  for (const response of responses) statuses.push(response.status);
  assert.equal(statuses.filter((status) => status === 200).length, 1);
  assert.equal(storage.backfill.bytes, 723);
  const stored = [];
  for (const date of dates) {
    if ((await storage.queryDaySummary(date)).steps != null) stored.push(date);
  }
  assert.equal(stored.length, 1);

  const db = new Database(":memory:");
  applySqliteMigrations(db);
  const reserve = db.prepare(RESERVE_BACKFILL);
  const now = NOW.toISOString();
  const first = reserve.get(now, null, 1100, 1, DEADLINE, 2000, now, now);
  assert.equal(first.bytes, 1100);
  assert.equal(first.closed_at, null);
  assert.equal(reserve.get(now, null, 1100, 1, DEADLINE, 2000, now, now), undefined);
  const filled = reserve.get(now, null, 900, 1, DEADLINE, 2000, now, now);
  assert.equal(filled.bytes, 2000);
  assert.equal(filled.closed_at, now);
  assert.equal(reserve.get(now, null, 1, 0, DEADLINE, 2000, now, now), undefined);
  db.close();

  const raced = new Database(":memory:");
  applySqliteMigrations(raced);
  const adapter = new D1Storage(d1FromSqlite(raced));
  const writes = [];
  const reserved = await Promise.all(dates.map((date, index) => adapter.reserveIngestBackfill({
    openedAt: now,
    closeAt: null,
    addBytes: 723,
    totalBytes: 1000,
    deadline: DEADLINE,
    nowIso: now,
    points: [{ date, metric: "step_count", sum_qty: 1, last_qty: 1, last_ts: date, units: "count", n: 1 }],
    workouts: [],
    write: async () => {
      writes.push(index);
    },
  })));
  assert.equal(reserved.filter(Boolean).length, 1);
  assert.equal(writes.length, 1);
  assert.equal(raced.prepare("SELECT bytes, closed_at FROM ingest_backfill").get().bytes, 723);
  raced.close();
});

test("a post that loses the close is not stored", async () => {
  const storage = new MemoryStorage();
  const [data, done] = await Promise.all([
    handleRequest(request(JSON.stringify(steps("2020-06-01", 9))), ctx(storage)),
    handleRequest(request(JSON.stringify({ backfill: "done" })), ctx(storage)),
  ]);
  assert.equal(done.status, 200);
  const doneBody = await done.json();
  assert.equal(doneBody.backfill.open, false);
  assert.equal(doneBody.backfill.bytes_remaining, 0);
  assert.ok(storage.backfill.closed_at);
  const stepsStored = (await storage.queryDaySummary("2020-06-01")).steps;
  if (data.status === 200) assert.equal(stepsStored, 9);
  else {
    assert.equal(stepsStored, null);
    assert.equal((await data.json()).backfill.bytes_remaining, 0);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "health-window-"));
  const file = path.join(dir, "health.sqlite");
  const left = createSqliteStorage(file);
  const right = createSqliteStorage(file);
  const [sqlData, sqlDone] = await Promise.all([
    handleRequest(request(JSON.stringify(steps("2020-06-02", 7))), ctx(left, { ingestBackfillTotalBytes: 100_000 })),
    handleRequest(request(JSON.stringify({ backfill: "done" })), ctx(right, { ingestBackfillTotalBytes: 100_000 })),
  ]);
  const row = await left.readIngestBackfill();
  assert.ok(row.closed_at);
  const sqlSteps = (await left.queryDaySummary("2020-06-02")).steps;
  if (sqlData.status === 200) assert.equal(sqlSteps, 7);
  else assert.equal(sqlSteps, null);
  assert.equal(sqlDone.status, 200);
  await left.close();
  await right.close();

  const reopened = createSqliteStorage(file);
  assert.ok((await reopened.readIngestBackfill()).closed_at);
  const again = await handleRequest(request(JSON.stringify(steps("2020-06-03", 1))), ctx(reopened));
  assert.equal(again.status, 422);
  assert.equal((await again.json()).backfill.bytes_remaining, 0);
  assert.equal(await reopened.reserveIngestBackfill({
    openedAt: NOW.toISOString(),
    closeAt: null,
    addBytes: 10,
    totalBytes: 1000,
    deadline: DEADLINE,
    nowIso: NOW.toISOString(),
    points: [],
    workouts: [],
  }), null);
  await reopened.close();
});

test("an existing database is seeded closed and an empty one is not", () => {
  const empty = new Database(":memory:");
  applySqliteMigrations(empty);
  assert.equal(empty.prepare("SELECT COUNT(*) AS n FROM ingest_backfill").get().n, 0);
  empty.close();

  const upgrade = new Database(":memory:");
  upgrade.exec(migrationFiles()[0].sql);
  upgrade.prepare("INSERT INTO points (metric, ts, date, units, qty) VALUES (?, ?, ?, ?, ?)").run(
    "step_count",
    "2024-01-02 09:00:00",
    "2024-01-02",
    "count",
    4,
  );
  applySqliteMigrations(upgrade);
  const seeded = upgrade.prepare("SELECT opened_at, closed_at, bytes, total_bytes FROM ingest_backfill").get();
  assert.equal(seeded.opened_at, seeded.closed_at);
  assert.equal(seeded.bytes, 0);
  assert.equal(seeded.total_bytes, 0);
  upgrade.close();
});

test("an unauthenticated request is rejected before the window or the body is read", async () => {
  let reads = 0;
  const storage = new MemoryStorage();
  const readRow = storage.readIngestBackfill.bind(storage);
  storage.readIngestBackfill = () => {
    reads += 1;
    return readRow();
  };
  const readData = storage.hasStoredData.bind(storage);
  storage.hasStoredData = () => {
    reads += 1;
    return readData();
  };
  const server = await startServer({
    storage,
    token: "tok",
    timeZone: "UTC",
    port: 0,
    host: "127.0.0.1",
    now: NOW,
  });
  const { port } = server.address();
  try {
    const denied = await fetch(`http://127.0.0.1:${port}/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(denied.status, 401);
    const deniedBody = await denied.json();
    assert.deepEqual(deniedBody, { error: "unauthorized" });
    assert.equal(JSON.stringify(deniedBody).includes("window"), false);

    const hung = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: "127.0.0.1",
        port,
        path: "/ingest",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(30_000_000),
        },
      }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      });
      req.setTimeout(2000, () => {
        req.destroy();
        reject(new Error("timed out"));
      });
      req.end();
    });
    assert.equal(hung.status, 401);
    assert.equal(hung.body.includes("window"), false);
    assert.equal(hung.body.includes("payload_too_large"), false);
    assert.equal(reads, 0);

    const chunked = await new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const finish = (value, failed = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (failed) reject(value);
        else resolve(value);
      };
      const req = http.request({
        hostname: "127.0.0.1",
        port,
        path: "/ingest",
        method: "POST",
        headers: { "content-type": "application/json", "transfer-encoding": "chunked" },
      }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => finish({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      });
      timer = setTimeout(() => {
        req.destroy();
        finish(new Error("timed out"), true);
      }, 2000);
      req.on("error", (error) => finish(error, true));
      req.write("{\"data\":");
    });
    assert.equal(chunked.status, 401);
    assert.deepEqual(JSON.parse(chunked.body), { error: "unauthorized" });
    assert.equal(reads, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

function appleSteps(days, start = "2010-01-01") {
  return appleMetrics(days, start, ["StepCount"]);
}

function appleMetrics(days, start = "2010-01-01", names = Object.keys(HK_QUANTITY_METRICS)) {
  const records = [];
  for (let index = 0; index < days; index += 1) {
    const date = shiftDate(start, index);
    for (const name of names) {
      const unit = name === "BodyMass" ? "kg" : name === "BodyFatPercentage" ? "%" : name.includes("Energy") || name.includes("Dietary") ? "kcal" : "count";
      records.push(`<Record type="HKQuantityTypeIdentifier${name}" unit="${unit}" value="1" startDate="${date} 09:00:00 +0000" endDate="${date} 09:00:00 +0000"/>`);
    }
  }
  return `<HealthData>${records.join("")}</HealthData>`;
}

function metricPoints(days, metrics, start = "2010-01-01") {
  const points = [];
  for (let index = 0; index < days; index += 1) {
    const date = shiftDate(start, index);
    for (const metric of metrics) {
      points.push({
        metric,
        date,
        sum_qty: 1,
        last_qty: 1,
        last_ts: `${date} 09:00:00 +0000`,
        units: "count",
        n: 1,
      });
    }
  }
  return points;
}

async function countedD1Statements(points, { hint, markOrigin, charge = false, prefix = 0 } = {}) {
  const db = new Database(":memory:");
  applySqliteMigrations(db);
  const counter = { n: 0 };
  const storage = new D1Storage(d1FromSqlite(db, counter));
  if (prefix) {
    await storage.readIngestBackfill();
  }
  const groups = dateGroups([...new Set(points.map((point) => point.date))]);
  for (let index = 0; index < groups.length; index += 1) {
    const set = new Set(groups[index]);
    const groupPoints = points.filter((point) => set.has(point.date));
    const batch = {
      id: `g${index}`,
      date: groups[index][groups[index].length - 1],
      receivedAt: NOW.toISOString(),
      bytes: index === 0 ? 10 : 0,
      payload: null,
      points: groupPoints,
      workouts: [],
    };
    const options = {
      hint: index === 0 ? hint : undefined,
      markOrigin: index === 0 ? markOrigin : undefined,
    };
    if (charge) {
      await storage.reserveIngestBackfill({
        openedAt: NOW.toISOString(),
        closeAt: null,
        addBytes: 1,
        totalBytes: 1_000_000_000,
        deadline: DEADLINE,
        nowIso: NOW.toISOString(),
        points: groupPoints,
        workouts: [],
        write: () => storage.insertIngest(batch, options),
      });
    } else {
      await storage.insertIngest(batch, options);
    }
  }
  db.close();
  return counter.n;
}

test("an Apple import longer than 366 days is stored in bounded batches", async () => {
  for (const days of [400, 1000]) {
    const db = new Database(":memory:");
    applySqliteMigrations(db);
    const counter = { n: 0, sql: [] };
    const storage = new D1Storage(d1FromSqlite(db, counter));
    const batches = [];
    const original = storage.insertIngest.bind(storage);
    storage.insertIngest = async (batch, options) => {
      const before = counter.n;
      const result = await original(batch, options);
      const groupDates = new Set([...(batch.points || []).map((point) => point.date), ...(batch.workouts || []).map((workout) => workout.date)]);
      batches.push({ dates: groupDates.size, queries: counter.n - before });
      return result;
    };
    const response = await handleRequest(new Request("http://localhost/import/apple-health", {
      method: "POST",
      headers: { authorization: "Bearer tok", "content-type": "application/xml" },
      body: appleSteps(days),
    }), ctx(storage));
    assert.equal(response.status, 200, `${days} ${JSON.stringify(await response.clone().json())}`);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM points_daily").get().n, days);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ingest_backfill").get().n, 0);
    assert.ok(batches.length > 1, `${days} batches ${batches.length}`);
    for (const batch of batches) {
      assert.ok(batch.dates <= MAX_INGEST_DATES, `${days} dates ${batch.dates}`);
      assert.ok(batch.queries < 20, `${days} queries ${batch.queries}`);
    }
    const follow = await handleRequest(
      request(JSON.stringify(steps("2005-01-01"))),
      ctx(storage),
    );
    assert.equal(follow.status, 200, JSON.stringify(await follow.clone().json()));
    assert.equal((await follow.json()).backfill.open, true);
    db.close();
  }
});

test("an Apple export on ingest and a chunk over 366 dates are not date-capped", async () => {
  const storage = new MemoryStorage();
  const xml = await handleRequest(
    request(appleSteps(400), { "content-type": "text/xml" }),
    ctx(storage),
  );
  assert.equal(xml.status, 200, JSON.stringify(await xml.clone().json()));
  assert.equal((await xml.json()).backfill.open, false);
  assert.equal(storage.backfill, null);
  const opened = await handleRequest(request(JSON.stringify(steps("2005-01-01"))), ctx(storage));
  assert.equal(opened.status, 200, JSON.stringify(await opened.clone().json()));
  assert.equal((await opened.json()).backfill.open, true);
  assert.equal(storage.backfill.closed_at, null);
  const points = [];
  for (let index = 0; index < 400; index += 1) {
    const date = shiftDate("2012-01-01", index);
    points.push({
      metric: "step_count",
      date,
      sum_qty: 1,
      last_qty: 1,
      last_ts: `${date} 09:00:00 +0000`,
      units: "count",
      n: 1,
    });
  }
  const chunk = await handleRequest(new Request("http://localhost/import/apple-health/chunk", {
    method: "POST",
    headers: { authorization: "Bearer tok", "content-type": "application/json" },
    body: JSON.stringify({ points, workouts: [] }),
  }), ctx(new MemoryStorage()));
  assert.equal(chunk.status, 200, JSON.stringify(await chunk.clone().json()));
  const chunkBody = await chunk.json();
  assert.equal(chunkBody.points, 400);
  assert.equal(chunkBody.backfill.open, false);
});

test("an empty body with raw storage on does not write a row or close the window", async () => {
  const storage = new MemoryStorage();
  const body = JSON.stringify({ data: { metrics: [], workouts: [] } });
  const response = await handleRequest(request(body), ctx(storage, { storeRaw: true }));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.backfill.open, false);
  assert.equal(payload.backfill.closes_at, null);
  assert.equal(payload.backfill.bytes_remaining, 0);
  assert.equal(storage.payloads.length, 0);
  assert.equal(storage.backfill, null);
  const next = await handleRequest(request(JSON.stringify(steps("2020-01-01"))), ctx(storage, { storeRaw: true }));
  assert.equal(next.status, 200);
  assert.equal((await next.json()).backfill.open, true);
  assert.equal(storage.backfill.closed_at, null);
  assert.equal(storage.payloads.length, 1);
});

test("the hint uses the configured cap", async () => {
  const storage = new MemoryStorage();
  const response = await handleRequest(
    request(JSON.stringify(history(MAX_INGEST_DATES + 1))),
    ctx(storage, { ingestBackfillMaxBytes: 2_000_000 }),
  );
  assert.equal(response.status, 413);
  const payload = await response.json();
  assert.match(payload.message, /2 MB/);
  assert.equal(payload.message.includes("5 MB"), false);
  assert.equal(payload.backfill.open, false);
});

test("the minimum date is clamped and invalid values use the default", async () => {
  assert.equal(resolveMinDate("0000-01-01", { now: NOW, timeZone: "UTC" }), "1970-01-01");
  assert.equal(resolveMinDate("9999-12-31", { now: NOW, timeZone: "UTC" }), "2026-10-16");
  assert.equal(resolveMinDate("2026-02-31", { now: NOW, timeZone: "UTC" }), "2000-01-01");
  assert.equal(resolveMinDate("2026-13-45", { now: NOW, timeZone: "UTC" }), "2000-01-01");
  assert.equal(resolveMinDate("2015-06-01", { now: NOW, timeZone: "UTC" }), "2015-06-01");
  const losAngeles = new Date("2026-10-17T02:00:00Z");
  assert.equal(resolveMinDate("2026-10-17", { now: losAngeles, timeZone: "America/Los_Angeles" }), "2026-10-17");

  const early = new MemoryStorage();
  const admitted = await handleRequest(
    request(JSON.stringify(steps("1970-01-01"))),
    ctx(early, { ingestMinDate: "0000-01-01" }),
  );
  assert.equal(admitted.status, 200, JSON.stringify(await admitted.clone().json()));
  assert.equal(early.points.size, 1);
  const blocked = await handleRequest(
    request(JSON.stringify(steps("1900-01-01"))),
    ctx(new MemoryStorage(), { ingestMinDate: "0000-01-01" }),
  );
  assert.equal(blocked.status, 422);
  assert.match((await blocked.json()).message, /1970-01-01/);

  const late = new MemoryStorage();
  const rejected = await handleRequest(
    request(JSON.stringify(steps("2020-01-01"))),
    ctx(late, { ingestMinDate: "9999-12-31" }),
  );
  assert.equal(rejected.status, 422);
  assert.equal(late.backfill, null);
});

test("a sparse date list uses the date index", () => {
  const db = new Database(":memory:");
  applySqliteMigrations(db);
  const plan = db.prepare(
    "EXPLAIN QUERY PLAN SELECT date, metric FROM points_daily WHERE date IN (SELECT value FROM json_each(?))",
  ).all(JSON.stringify(["2000-01-01", "2026-10-16"]));
  const text = plan.map((row) => row.detail).join(" ");
  assert.match(text, /SEARCH/);
  assert.equal(text.includes("SCAN points_daily"), false);
  db.close();
});

test("a failed filling write does not reopen the window", async () => {
  const storage = createSqliteStorage(":memory:");
  const point = {
    date: "2020-01-02",
    metric: "step_count",
    sum_qty: 1,
    last_qty: 1,
    last_ts: "2020-01-02 09:00:00",
    units: "count",
    n: 1,
  };
  await storage.reserveIngestBackfill({
    openedAt: NOW.toISOString(),
    closeAt: null,
    addBytes: 10,
    totalBytes: 100,
    deadline: DEADLINE,
    nowIso: NOW.toISOString(),
    points: [point],
    workouts: [],
    write: async () => {},
  });
  storage.insertIngest = async () => {
    throw new Error("write failed");
  };
  await assert.rejects(() => storage.reserveIngestBackfill({
    openedAt: NOW.toISOString(),
    closeAt: NOW.toISOString(),
    addBytes: 90,
    totalBytes: 100,
    deadline: DEADLINE,
    nowIso: NOW.toISOString(),
    points: [{ ...point, date: "2020-01-03" }],
    workouts: [],
    write: () => storage.insertIngest({}),
  }), /write failed/);
  const row = await storage.readIngestBackfill();
  assert.equal(row.bytes, 10);
  // The filling reservation closed the window. Releasing its bytes must not clear that close.
  assert.equal(row.closed_at, NOW.toISOString());
  assert.equal(await storage.hasStoredData(), false);
  await storage.close();
});

test("a seeded window does not report the placeholder close time", async () => {
  const upgrade = new Database(":memory:");
  upgrade.exec(migrationFiles()[0].sql);
  upgrade.prepare("INSERT INTO points (metric, ts, date, units, qty) VALUES (?, ?, ?, ?, ?)").run(
    "step_count",
    "2024-01-02 09:00:00",
    "2024-01-02",
    "count",
    4,
  );
  applySqliteMigrations(upgrade);
  const stored = upgrade.prepare("SELECT closed_at FROM ingest_backfill").get();
  assert.equal(stored.closed_at, "1970-01-01T00:00:00.000Z");
  const storage = new D1Storage(d1FromSqlite(upgrade));
  const response = await handleRequest(request(JSON.stringify(steps("2026-10-16"))), ctx(storage));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.backfill.open, false);
  assert.equal(payload.backfill.closes_at, null);
  assert.equal(payload.backfill.bytes_remaining, 0);
  upgrade.close();
});

test("the projected statement count matches the statements D1 runs", async () => {
  assert.equal(resolveMaxStatements(undefined), D1_STATEMENT_BUDGET);
  assert.equal(resolveMaxStatements("10"), 10);
  assert.equal(resolveMaxStatements("10000"), D1_STATEMENT_BUDGET);
  const metrics = Object.values(HK_QUANTITY_METRICS);
  for (const days of [MAX_INGEST_DATES, 2000, 3650]) {
    const points = metricPoints(days, metrics);
    const projected = projectedIngestStatements({
      points,
      charge: false,
      hint: null,
      markOrigin: true,
      prefix: 0,
    });
    assert.equal(await countedD1Statements(points, { hint: null, markOrigin: "apple" }), projected, `${days} days`);
  }
  const charged = metricPoints(30, metrics);
  const withWindow = projectedIngestStatements({
    points: charged,
    charge: true,
    hint: null,
    markOrigin: true,
    prefix: 1,
  });
  assert.equal(await countedD1Statements(charged, { hint: null, markOrigin: "ingest", charge: true, prefix: 1 }), withWindow);
});

test("sqlite and memory accept a multi-year apple import", async () => {
  for (const days of [3650, 5000]) {
    const memory = new MemoryStorage();
    const sqlite = createSqliteStorage(":memory:");
    try {
      for (const storage of [memory, sqlite]) {
        const response = await handleRequest(
          request(appleSteps(days), { "content-type": "text/xml" }),
          ctx(storage),
        );
        assert.equal(response.status, 200, `${days} ${JSON.stringify(await response.clone().json())}`);
        assert.equal(storage.backfill ?? await storage.readIngestBackfill(), null);
        const follow = await handleRequest(request(JSON.stringify(steps("2005-01-01"))), ctx(storage));
        assert.equal(follow.status, 200, JSON.stringify(await follow.clone().json()));
        assert.equal((await follow.json()).backfill.open, true);
      }
    } finally {
      await sqlite.close();
    }
  }
});

test("d1 rejects an over-budget apple import before any write", async () => {
  const db = new Database(":memory:");
  applySqliteMigrations(db);
  const counter = { n: 0 };
  const storage = new D1Storage(d1FromSqlite(db, counter));
  const response = await handleRequest(new Request("http://localhost/import/apple-health", {
    method: "POST",
    headers: { authorization: "Bearer tok", "content-type": "application/xml" },
    body: appleMetrics(2500),
  }), ctx(storage, { ingestRatePerHour: 1, ingestMaxStatements: 10000 }));
  assert.equal(response.status, 413);
  const payload = await response.json();
  assert.equal(payload.error, "payload_too_large");
  assert.match(payload.message, /shorter date range/);
  assert.equal(payload.message.includes("/chunk"), false);
  assert.equal(payload.message.toLowerCase().includes("initial import"), false);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM points_daily").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ingest_backfill").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ingest_quota").get().n, 0);
  assert.equal(counter.n, 2);
  db.close();
});

test("d1 counts nine metrics with the window open", async () => {
  const db = new Database(":memory:");
  applySqliteMigrations(db);
  const counter = { n: 0 };
  const storage = new D1Storage(d1FromSqlite(db, counter));
  const opened = await handleRequest(request(JSON.stringify(steps("2026-10-16"))), ctx(storage, { ingestRatePerHour: 0 }));
  assert.equal(opened.status, 200, JSON.stringify(await opened.clone().json()));
  counter.n = 0;
  const xml = appleMetrics(MAX_INGEST_DATES);
  const parsed = await parseAppleExport(xml, { timeZone: "UTC" });
  const response = await handleRequest(new Request("http://localhost/import/apple-health", {
    method: "POST",
    headers: { authorization: "Bearer tok", "content-type": "application/xml" },
    body: xml,
  }), ctx(storage, { ingestRatePerHour: 0 }));
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  const projected = projectedIngestStatements({
    points: parsed.points,
    workouts: parsed.workouts,
    charge: false,
    hint: null,
    markOrigin: true,
    prefix: 1,
  });
  assert.equal(counter.n, projected);
  assert.ok(projected <= D1_STATEMENT_BUDGET);
  const row = db.prepare("SELECT bytes FROM ingest_backfill").get();
  const opener = Buffer.byteLength(JSON.stringify(steps("2026-10-16")));
  assert.equal(Number(row.bytes), opener);
  db.close();
});

test("an apple import applies the minimum date without opening the window", async () => {
  const storage = new MemoryStorage();
  const mixed = `<HealthData><Record type="HKQuantityTypeIdentifierStepCount" unit="count" value="1" startDate="1969-12-31 09:00:00 +0000" endDate="1969-12-31 09:00:00 +0000"/><Record type="HKQuantityTypeIdentifierStepCount" unit="count" value="1" startDate="2010-01-01 09:00:00 +0000" endDate="2010-01-01 09:00:00 +0000"/></HealthData>`;
  const kept = await handleRequest(
    request(mixed, { "content-type": "text/xml" }),
    ctx(storage, { ingestMinDate: "1970-01-01" }),
  );
  assert.equal(kept.status, 200, JSON.stringify(await kept.clone().json()));
  assert.equal(storage.points.size, 1);
  assert.equal(storage.backfill, null);
  const early = new MemoryStorage();
  const only = `<HealthData><Record type="HKQuantityTypeIdentifierStepCount" unit="count" value="1" startDate="1969-12-31 09:00:00 +0000" endDate="1969-12-31 09:00:00 +0000"/></HealthData>`;
  const rejected = await handleRequest(
    request(only, { "content-type": "text/xml" }),
    ctx(early, { ingestMinDate: "1970-01-01" }),
  );
  assert.equal(rejected.status, 422);
  assert.equal(early.points.size, 0);
  assert.equal(early.backfill, null);
});

function datedPoints(count, start = "2010-01-01") {
  const points = [];
  for (let index = 0; index < count; index += 1) {
    const date = shiftDate(start, index);
    points.push({
      metric: "step_count",
      date,
      sum_qty: 1,
      last_qty: 1,
      last_ts: `${date} 09:00:00 +0000`,
      units: "count",
      n: 1,
    });
  }
  return points;
}

function failOnChunkGroup(storage, groupNumber) {
  const original = storage.insertIngest.bind(storage);
  let seen = 0;
  storage.insertIngest = async (batch, options) => {
    if (String(batch.date) < "2020-01-01") {
      seen += 1;
      if (seen === groupNumber) throw new Error("injected");
    }
    return original(batch, options);
  };
}

async function storedSteps(storage) {
  const rows = await storage.queryMetricRange("step_count", "2010-01-01", "2026-10-16");
  return rows.length;
}

test("sqlite and d1 release only the groups that were never stored", async () => {
  const points = datedPoints(MAX_INGEST_DATES * 2 + 1);
  const chunk = JSON.stringify({ points, workouts: [] });
  const shares = byteShares(Buffer.byteLength(chunk), 3);
  assert.equal(shares.reduce((sum, share) => sum + share, 0), Buffer.byteLength(chunk));
  const d1db = new Database(":memory:");
  applySqliteMigrations(d1db);
  const adapters = [
    ["memory", new MemoryStorage()],
    ["sqlite", createSqliteStorage(":memory:")],
    ["d1", new D1Storage(d1FromSqlite(d1db))],
  ];
  try {
    for (const [label, storage] of adapters) {
      const opener = JSON.stringify(steps("2026-10-16"));
      const opened = await handleRequest(request(opener), ctx(storage));
      assert.equal(opened.status, 200, label);
      const before = (await storage.readIngestBackfill()).bytes;
      assert.equal(before, Buffer.byteLength(opener), label);
      failOnChunkGroup(storage, 2);
      await assert.rejects(() => handleRequest(new Request("http://localhost/import/apple-health/chunk", {
        method: "POST",
        headers: { authorization: "Bearer tok", "content-type": "application/json" },
        body: chunk,
      }), ctx(storage)), /injected/);
      const row = await storage.readIngestBackfill();
      assert.equal(row.bytes, before, `${label} bytes`);
      assert.equal(row.closed_at, null, label);
      assert.equal(await storedSteps(storage), 1 + MAX_INGEST_DATES, `${label} rows`);
    }
  } finally {
    await adapters[1][1].close();
    d1db.close();
  }
});

test("a failure on the last group keeps every earlier group", async () => {
  const points = datedPoints(MAX_INGEST_DATES * 2 + 1);
  const chunk = JSON.stringify({ points, workouts: [] });
  const shares = byteShares(Buffer.byteLength(chunk), 3);
  const d1db = new Database(":memory:");
  applySqliteMigrations(d1db);
  const adapters = [
    ["memory", new MemoryStorage()],
    ["sqlite", createSqliteStorage(":memory:")],
    ["d1", new D1Storage(d1FromSqlite(d1db))],
  ];
  try {
    for (const [label, storage] of adapters) {
      const opener = JSON.stringify(steps("2026-10-16"));
      const opened = await handleRequest(request(opener), ctx(storage));
      assert.equal(opened.status, 200, label);
      const before = (await storage.readIngestBackfill()).bytes;
      failOnChunkGroup(storage, 3);
      await assert.rejects(() => handleRequest(new Request("http://localhost/import/apple-health/chunk", {
        method: "POST",
        headers: { authorization: "Bearer tok", "content-type": "application/json" },
        body: chunk,
      }), ctx(storage)), /injected/);
      const row = await storage.readIngestBackfill();
      assert.equal(row.bytes, before, `${label} bytes`);
      assert.equal(row.closed_at, null, label);
      assert.equal(await storedSteps(storage), 1 + MAX_INGEST_DATES * 2, `${label} rows`);
    }
  } finally {
    await adapters[1][1].close();
    d1db.close();
  }
});

test("a completed import releases nothing", async () => {
  const points = datedPoints(MAX_INGEST_DATES * 2 + 1);
  const chunk = JSON.stringify({ points, workouts: [] });
  const storage = new MemoryStorage();
  const opener = JSON.stringify(steps("2026-10-16"));
  assert.equal((await handleRequest(request(opener), ctx(storage))).status, 200);
  const before = storage.backfill.bytes;
  const response = await handleRequest(new Request("http://localhost/import/apple-health/chunk", {
    method: "POST",
    headers: { authorization: "Bearer tok", "content-type": "application/json" },
    body: chunk,
  }), ctx(storage));
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  assert.equal(storage.backfill.bytes, before);
  assert.equal(await storedSteps(storage), 1 + points.length);
});

test("a failed filling write stays closed when done arrives with it", async () => {
  for (const storage of [new MemoryStorage(), createSqliteStorage(":memory:")]) {
    try {
      const opened = await handleRequest(
        request(JSON.stringify(exactSize("2020-01-01", 400))),
        ctx(storage, { ingestBackfillTotalBytes: 1000 }),
      );
      assert.equal(opened.status, 200, JSON.stringify(await opened.clone().json()));
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      let entered;
      const enteredPromise = new Promise((resolve) => {
        entered = resolve;
      });
      storage.insertIngest = async () => {
        entered();
        await gate;
        throw new Error("injected");
      };
      const filling = handleRequest(
        request(JSON.stringify(exactSize("2020-06-01", 600))),
        ctx(storage, { ingestBackfillTotalBytes: 1000 }),
      );
      await enteredPromise;
      const done = handleRequest(
        request(JSON.stringify({ backfill: "done" })),
        ctx(storage, { ingestBackfillTotalBytes: 1000 }),
      );
      release();
      await assert.rejects(filling, /injected/);
      const doneBody = await (await done).json();
      assert.equal(doneBody.backfill.open, false);
      const row = await storage.readIngestBackfill();
      assert.equal(row.bytes, 400);
      assert.ok(row.closed_at);
      const june = await storage.queryMetricRange("step_count", "2020-06-01", "2020-06-01");
      assert.equal(june.length, 0);
    } finally {
      if (storage.close) await storage.close();
    }
  }
});

test("a legacy open row takes its deadline from when it opened", async () => {
  const db = new Database(":memory:");
  applySqliteMigrations(db);
  db.prepare(
    "INSERT INTO ingest_backfill (id, opened_at, closed_at, bytes, days, deadline, total_bytes) VALUES (1, ?, NULL, 0, 0, NULL, 1000000)",
  ).run("2026-10-16T00:00:00.000Z");
  const storage = new D1Storage(d1FromSqlite(db));
  const response = await handleRequest(
    request(JSON.stringify(steps("2026-10-16"))),
    ctx(storage, { ingestBackfillHours: 24 }),
  );
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  assert.equal(db.prepare("SELECT deadline FROM ingest_backfill").get().deadline, "2026-10-17T00:00:00.000Z");
  db.close();
});

test("migration 0006 skips columns that are already present", () => {
  const fresh = new Database(":memory:");
  applySqliteMigrations(fresh);
  const names = fresh.prepare("PRAGMA table_info(ingest_backfill)").all().map((column) => column.name);
  assert.ok(names.includes("deadline"));
  assert.ok(names.includes("total_bytes"));
  fresh.close();

  const legacy = new Database(":memory:");
  legacy.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const mark = legacy.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)");
  for (const file of migrationFiles()) {
    if (file.id.startsWith("0006")) continue;
    for (const statement of splitStatements(file.sql)) legacy.prepare(statement).run();
    mark.run(file.id, "2026-01-01T00:00:00.000Z");
  }
  legacy.exec("ALTER TABLE ingest_backfill ADD COLUMN deadline TEXT");
  legacy.exec("ALTER TABLE ingest_backfill ADD COLUMN total_bytes BIGINT");
  legacy.prepare(
    "INSERT INTO points_daily (date, metric, sum_qty, last_qty, last_ts, units, n) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run("2024-01-02", "step_count", 1, 1, "2024-01-02 09:00:00", "count", 1);
  applySqliteMigrations(legacy);
  const row = legacy.prepare("SELECT closed_at FROM ingest_backfill WHERE id = 1").get();
  assert.equal(row.closed_at, "1970-01-01T00:00:00.000Z");
  legacy.prepare("DELETE FROM schema_migrations WHERE id = ?").run("0006_ingest_backfill_deadline.sql");
  applySqliteMigrations(legacy);
  assert.equal(legacy.prepare("SELECT COUNT(*) AS n FROM ingest_backfill").get().n, 1);
  legacy.close();
});

test("d1 migration 0006 skips columns that are already present", async () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const mark = db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)");
  for (const file of migrationFiles()) {
    if (file.id.startsWith("0006")) continue;
    for (const statement of splitStatements(file.sql)) db.prepare(statement).run();
    mark.run(file.id, "2026-01-01T00:00:00.000Z");
  }
  db.exec("ALTER TABLE ingest_backfill ADD COLUMN deadline TEXT");
  db.exec("ALTER TABLE ingest_backfill ADD COLUMN total_bytes BIGINT");
  db.prepare(
    "INSERT INTO points_daily (date, metric, sum_qty, last_qty, last_ts, units, n) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run("2024-01-02", "step_count", 1, 1, "2024-01-02 09:00:00", "count", 1);
  const binding = d1FromSqlite(db);
  await applyD1Migrations(binding);
  const names = db.prepare("PRAGMA table_info(ingest_backfill)").all().map((column) => column.name);
  assert.equal(names.filter((name) => name === "deadline").length, 1);
  assert.equal(names.filter((name) => name === "total_bytes").length, 1);
  assert.equal(db.prepare("SELECT closed_at FROM ingest_backfill WHERE id = 1").get().closed_at, "1970-01-01T00:00:00.000Z");
  db.prepare("DELETE FROM schema_migrations WHERE id = ?").run("0006_ingest_backfill_deadline.sql");
  await applyD1Migrations(binding);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ingest_backfill").get().n, 1);
  db.close();
});
