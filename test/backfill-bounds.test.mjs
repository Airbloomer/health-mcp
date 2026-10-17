import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import Database from "better-sqlite3";
import { test } from "node:test";
import { D1Storage } from "../src/adapters/d1.js";
import { migrationFiles } from "../src/adapters/migrate.js";
import { startServer } from "../src/adapters/node.js";
import { applySqliteMigrations, createSqliteStorage } from "../src/adapters/sqlite.js";
import { RESERVE_BACKFILL } from "../src/adapters/statements.js";
import { handleRequest } from "../src/core/http.js";
import { EXPORT_HINT, MAX_INGEST_DATES } from "../src/core/ingest-guard.js";
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
    counter.sql.push(sql);
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
  assert.ok(counter.sql.some((sql) => sql.includes("date >= ?") && sql.includes("date <= ?")));
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
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
