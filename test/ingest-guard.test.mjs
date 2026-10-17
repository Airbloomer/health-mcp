import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs";
import { test } from "node:test";
import { D1Storage } from "../src/adapters/d1.js";
import { applySqliteMigrations } from "../src/adapters/sqlite.js";
import { UPSERT_QUOTA } from "../src/adapters/statements.js";
import { handleRequest } from "../src/core/http.js";
import { EXPORT_HINT, STALE_HINT_AT, partitionIngest } from "../src/core/ingest-guard.js";
import { MemoryStorage } from "../src/core/memory.js";

const NOW = new Date("2026-10-16T12:30:00Z");

function request(pathname, { method = "GET", token = "tok", body, headers = {} } = {}) {
  const initHeaders = new Headers(headers);
  if (token) initHeaders.set("authorization", /^bearer\s/i.test(token) ? token : `Bearer ${token}`);
  if (body != null && !initHeaders.has("content-type")) initHeaders.set("content-type", "application/json");
  return new Request(`http://localhost${pathname}`, {
    method,
    headers: initHeaders,
    body: body == null ? undefined : body,
  });
}

function ctx(storage = new MemoryStorage(), extra = {}) {
  return { token: "tok", timeZone: "UTC", storage, now: NOW, ...extra };
}

function steps(date, qty = 10) {
  return {
    data: {
      metrics: [{ name: "step_count", units: "count", data: [{ date: `${date} 09:00:00 -0700`, qty }] }],
    },
  };
}

function postIngest(storage, body, extra = {}, token = "tok") {
  return handleRequest(
    request("/ingest", { method: "POST", body: JSON.stringify(body), token }),
    ctx(storage, { ...extra, token }),
  );
}

test("recency keeps today and yesterday and counts older points as dropped_stale", async () => {
  const storage = new MemoryStorage();
  const body = {
    data: {
      metrics: [{
        name: "step_count",
        units: "count",
        data: [
          { date: "2026-10-16 09:00:00 -0700", qty: 3 },
          { date: "2026-10-15 09:00:00 -0700", qty: 4 },
          { date: "2026-10-14 09:00:00 -0700", qty: 5 },
          { date: "2026-10-14 18:00:00 -0700", qty: 6 },
        ],
      }],
      workouts: [
        { name: "Old", start: "2026-10-14 08:00:00 -0700", duration: 600 },
        { name: "Recent", start: "2026-10-15 08:00:00 -0700", duration: 600 },
      ],
    },
  };
  const response = await postIngest(storage, body);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.dropped_stale, 3);
  assert.equal(payload.dropped_future, 0);
  assert.equal(payload.points, 2);
  assert.equal(payload.workouts, 1);
  assert.deepEqual(payload.dates, ["2026-10-15", "2026-10-16"]);
  assert.equal((await storage.queryDaySummary("2026-10-16")).steps, 3);
  assert.equal((await storage.queryDaySummary("2026-10-15")).steps, 4);
  assert.equal((await storage.queryDaySummary("2026-10-14")).steps, null);
  assert.equal(storage.workouts.size, 1);
});

test("recency uses the configured timezone and INGEST_MAX_AGE_DAYS", async () => {
  const zoned = new MemoryStorage();
  const response = await handleRequest(request("/ingest", {
    method: "POST",
    body: JSON.stringify({
      data: {
        metrics: [{
          name: "step_count",
          units: "count",
          data: [
            { date: "2026-10-14 09:00:00 -0700", qty: 2 },
            { date: "2026-10-13 09:00:00 -0700", qty: 3 },
            { date: "2026-10-12 09:00:00 -0700", qty: 4 },
          ],
        }],
      },
    }),
  }), ctx(zoned, { timeZone: "America/Los_Angeles", now: new Date("2026-10-15T06:00:00Z") }));
  assert.equal((await response.json()).dropped_stale, 1);
  assert.equal((await zoned.queryDaySummary("2026-10-14")).steps, 2);
  assert.equal((await zoned.queryDaySummary("2026-10-13")).steps, 3);
  assert.equal((await zoned.queryDaySummary("2026-10-12")).steps, null);

  const todayOnly = new MemoryStorage();
  const narrow = await postIngest(todayOnly, {
    data: {
      metrics: [{
        name: "step_count",
        units: "count",
        data: [
          { date: "2026-10-16 09:00:00 -0700", qty: 8 },
          { date: "2026-10-15 09:00:00 -0700", qty: 9 },
        ],
      }],
    },
  }, { ingestMaxAgeDays: 0 });
  assert.equal((await narrow.json()).dropped_stale, 1);
  assert.equal((await todayOnly.queryDaySummary("2026-10-16")).steps, 8);
  assert.equal((await todayOnly.queryDaySummary("2026-10-15")).steps, null);

  const week = new MemoryStorage();
  const wide = await postIngest(week, steps("2026-10-10", 7), { ingestMaxAgeDays: "7" });
  assert.equal(wide.status, 200);
  assert.equal((await wide.json()).dropped_stale, 0);
  assert.equal((await week.queryDaySummary("2026-10-10")).steps, 7);
});

test("apple health import keeps history that ingest drops", async () => {
  const storage = new MemoryStorage();
  const environment = ctx(storage);
  const dropped = await postIngest(storage, steps("2020-01-02", 11));
  assert.equal((await dropped.json()).dropped_stale, 1);
  assert.equal((await storage.queryDaySummary("2020-01-02")).steps, null);

  const chunk = await handleRequest(request("/import/apple-health/chunk", {
    method: "POST",
    body: JSON.stringify({
      points: [{
        metric: "step_count",
        date: "2020-01-02",
        sum_qty: 11,
        last_qty: 11,
        last_ts: "2020-01-02 09:00:00 -0700",
        units: "count",
        n: 1,
      }],
      workouts: [],
    }),
  }), environment);
  assert.equal(chunk.status, 200);
  const chunkBody = await chunk.json();
  assert.equal(chunkBody.dropped_stale, undefined);
  assert.equal((await storage.queryDaySummary("2020-01-02")).steps, 11);

  const xml = `<HealthData><Record type="HKQuantityTypeIdentifierStepCount" unit="count" value="6" startDate="2019-05-01 09:00:00 -0700" endDate="2019-05-01 10:00:00 -0700"/></HealthData>`;
  const imported = await handleRequest(request("/import/apple-health", {
    method: "POST",
    body: xml,
    headers: { "content-type": "application/xml" },
  }), environment);
  assert.equal(imported.status, 200);
  assert.equal((await imported.json()).dropped_stale, undefined);
  assert.equal((await storage.queryDaySummary("2019-05-01")).steps, 6);
});

test("a repeat post reports unchanged and writes nothing when values match", async () => {
  const storage = new MemoryStorage();
  const environment = ctx(storage, { ingestRatePerHour: 0 });
  const first = await handleRequest(request("/ingest", { method: "POST", body: JSON.stringify(steps("2026-10-16", 42)) }), environment);
  const firstBody = await first.json();
  assert.equal(firstBody.written, 1);
  assert.equal(firstBody.unchanged, 0);

  const second = await handleRequest(request("/ingest", { method: "POST", body: JSON.stringify(steps("2026-10-16", 42)) }), environment);
  const secondBody = await second.json();
  assert.equal(secondBody.written, 0);
  assert.equal(secondBody.unchanged, 1);
  assert.equal((await storage.queryDaySummary("2026-10-16")).steps, 42);

  const changed = await handleRequest(request("/ingest", { method: "POST", body: JSON.stringify(steps("2026-10-16", 50)) }), environment);
  assert.equal((await changed.json()).written, 1);
  assert.equal((await storage.queryDaySummary("2026-10-16")).steps, 50);
});

test("a shorter re-send is not a write and does not count as unchanged", () => {
  const stored = { date: "2026-10-16", metric: "step_count", sum_qty: 9, last_qty: 4, last_ts: "2026-10-16 12:00:00 -0700", units: "count", n: 3 };
  const incoming = { ...stored, sum_qty: 1, last_qty: 1, n: 1 };
  const diff = partitionIngest([incoming], [], { points: [stored], workouts: [] });
  assert.equal(diff.written, 0);
  assert.equal(diff.unchanged, 0);
  assert.equal(diff.points.length, 0);
});

test("a body over the configured limit returns 413", async () => {
  const storage = new MemoryStorage();
  const body = JSON.stringify(steps("2026-10-16", 1));
  const rejected = await postIngest(storage, JSON.parse(body), { ingestMaxBodyBytes: body.length - 1 });
  assert.equal(rejected.status, 413);
  const payload = await rejected.json();
  assert.equal(payload.error, "payload_too_large");
  assert.match(payload.message, new RegExp(`${body.length - 1} bytes`));
  assert.equal(storage.points.size, 0);

  const accepted = await postIngest(storage, JSON.parse(body), { ingestMaxBodyBytes: body.length });
  assert.equal(accepted.status, 200);
  assert.equal((await storage.queryDaySummary("2026-10-16")).steps, 1);
});

test("per-token rate limit returns 429 with Retry-After and one quota write", async () => {
  const storage = new MemoryStorage();
  const extra = { ingestRatePerHour: 2 };
  const first = await postIngest(storage, steps("2026-10-16", 1), extra);
  assert.equal(first.status, 200);
  const second = await postIngest(storage, steps("2026-10-16", 1), extra);
  assert.equal(second.status, 200);
  assert.equal((await second.json()).unchanged, 1);

  const limited = await postIngest(storage, steps("2026-10-16", 9), extra);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "1800");
  const payload = await limited.json();
  assert.equal(payload.error, "rate_limited");
  assert.match(payload.message, /2 per hour/);
  assert.equal((await storage.queryDaySummary("2026-10-16")).steps, 1);

  const urlToken = "url-token-for-rate-limit-bucket1";
  const viaUrl = await handleRequest(request(`/ingest/shortcuts/${urlToken}`, {
    method: "POST",
    token: "",
    body: JSON.stringify({ samples: [{ type: "Steps", value: "4", start: "2026-10-16T09:00:00Z" }] }),
  }), ctx(storage, { ...extra, urlToken }));
  assert.equal(viaUrl.status, 200);
  assert.equal((await storage.queryDaySummary("2026-10-16")).steps, 1);

  const again = await postIngest(storage, steps("2026-10-16", 8), extra);
  assert.equal(again.status, 429);
  const labels = [...storage.quota.keys()].map((key) => key.split("\0")[0]).sort();
  assert.deepEqual(labels, ["bearer", "url"]);
});

test("dates more than one day ahead are dropped as dropped_future", async () => {
  const storage = new MemoryStorage();
  const response = await postIngest(storage, {
    data: {
      metrics: [{
        name: "step_count",
        units: "count",
        data: [
          { date: "2026-10-16 09:00:00 -0700", qty: 1 },
          { date: "2026-10-17 09:00:00 -0700", qty: 2 },
          { date: "2026-10-18 09:00:00 -0700", qty: 3 },
          { date: "2026-10-18 12:00:00 -0700", qty: 4 },
        ],
      }],
      workouts: [
        { name: "Soon", start: "2026-10-17 08:00:00 -0700", duration: 600 },
        { name: "Later", start: "2026-10-18 08:00:00 -0700", duration: 600 },
      ],
    },
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.dropped_future, 3);
  assert.equal(payload.dropped_stale, 0);
  assert.equal(payload.points, 2);
  assert.equal(payload.workouts, 1);
  assert.equal((await storage.queryDaySummary("2026-10-16")).steps, 1);
  assert.equal((await storage.queryDaySummary("2026-10-17")).steps, 2);
  assert.equal((await storage.queryDaySummary("2026-10-18")).steps, null);
  assert.equal(storage.workouts.size, 1);
  const hinted = await (await handleRequest(request("/summary?date=2026-10-16"), ctx(storage))).json();
  assert.equal(hinted.export_hint, undefined);

  const zoned = new MemoryStorage();
  const la = await handleRequest(request("/ingest", {
    method: "POST",
    body: JSON.stringify({
      data: {
        metrics: [{
          name: "step_count",
          units: "count",
          data: [
            { date: "2026-10-15 09:00:00 -0700", qty: 5 },
            { date: "2026-10-16 09:00:00 -0700", qty: 6 },
          ],
        }],
      },
    }),
  }), ctx(zoned, { timeZone: "America/Los_Angeles", now: new Date("2026-10-15T06:00:00Z") }));
  const laBody = await la.json();
  assert.equal(laBody.dropped_future, 1);
  assert.equal(laBody.dropped_stale, 0);
  assert.equal((await zoned.queryDaySummary("2026-10-15")).steps, 5);
  assert.equal((await zoned.queryDaySummary("2026-10-16")).steps, null);
});

function chunkedRequest(pathname, { chunkSize, contentLength, bytes, limit }) {
  let pulls = 0;
  let cancelled = false;
  const chunk = bytes ?? new Uint8Array(chunkSize);
  if (!bytes && chunk.length > 0) chunk[0] = 0x7b;
  const body = new ReadableStream({
    pull(controller) {
      pulls += 1;
      if (pulls > 30) controller.error(new Error("reader did not stop"));
      else controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  });
  const headers = { authorization: "Bearer tok", "content-type": "application/json" };
  if (contentLength != null) headers["content-length"] = String(contentLength);
  const req = new Request(`http://localhost${pathname}`, {
    method: "POST",
    headers,
    body,
    duplex: "half",
  });
  return {
    req,
    stats() {
      return { pulls, cancelled, limit };
    },
  };
}

test("json ingest routes cancel a chunked body past the cap", async () => {
  const routes = [
    "/ingest",
    "/ingest/health-export-pro",
    "/ingest/syncfit",
    "/ingest/hc-webhook",
    "/ingest/life-dashboard",
    "/ingest/shortcuts",
  ];
  const limit = 1000;
  const chunkSize = 400;
  for (const pathname of routes) {
    const storage = new MemoryStorage();
    const streamed = chunkedRequest(pathname, { chunkSize });
    const response = await handleRequest(streamed.req, ctx(storage, { ingestMaxBodyBytes: limit }));
    assert.equal(response.status, 413, pathname);
    const payload = await response.json();
    assert.equal(payload.error, "payload_too_large");
    assert.match(payload.message, new RegExp(`${limit} bytes`));
    const stats = streamed.stats();
    assert.equal(stats.cancelled, true, pathname);
    assert.equal(stats.pulls, 3, pathname);
    assert.equal(storage.points.size, 0);
  }

  const understated = chunkedRequest("/ingest", { chunkSize, contentLength: 8 });
  const underResponse = await handleRequest(understated.req, ctx(new MemoryStorage(), { ingestMaxBodyBytes: limit }));
  assert.equal(underResponse.status, 413);
  assert.equal(understated.stats().cancelled, true);
  assert.equal(understated.stats().pulls, 3);

  const declared = chunkedRequest("/ingest/shortcuts", { chunkSize, contentLength: limit + 1 });
  const declaredResponse = await handleRequest(declared.req, ctx(new MemoryStorage(), { ingestMaxBodyBytes: limit }));
  assert.equal(declaredResponse.status, 413);
  assert.equal(declared.stats().cancelled, true);
  assert.equal(declared.stats().pulls, 0);

  const xml = `<HealthData><Record type="HKQuantityTypeIdentifierStepCount" unit="count" value="6" startDate="2026-10-16 09:00:00 -0700" endDate="2026-10-16 10:00:00 -0700"/></HealthData>`;
  const xmlBytes = new TextEncoder().encode(xml);
  let sent = 0;
  let applePulls = 0;
  let appleCancelled = false;
  const appleReq = new Request("http://localhost/ingest", {
    method: "POST",
    headers: { authorization: "Bearer tok", "content-type": "application/xml" },
    body: new ReadableStream({
      pull(controller) {
        applePulls += 1;
        if (sent >= xmlBytes.length) {
          controller.close();
          return;
        }
        const next = xmlBytes.subarray(sent, sent + 20);
        sent += next.length;
        controller.enqueue(next);
      },
      cancel() {
        appleCancelled = true;
      },
    }),
    duplex: "half",
  });
  const appleStorage = new MemoryStorage();
  const appleResponse = await handleRequest(appleReq, ctx(appleStorage, { ingestMaxBodyBytes: 30, ingestRatePerHour: 0 }));
  assert.equal(appleResponse.status, 200);
  assert.equal(appleCancelled, false);
  assert.ok(applePulls > 1);
  assert.equal((await appleStorage.queryDaySummary("2026-10-16")).steps, 6);
  assert.ok(xmlBytes.length > 30);
});

test("full history and rate limits surface export_hint on summary and the MCP tool", async () => {
  const storage = new MemoryStorage();
  const old = Array.from({ length: STALE_HINT_AT }, (_, index) => ({
    date: `2020-01-01 ${String(index % 24).padStart(2, "0")}:00:00 -0700`,
    qty: 1,
  }));
  old.push({ date: "2026-10-16 09:00:00 -0700", qty: 15 });
  const ingested = await postIngest(storage, {
    data: { metrics: [{ name: "step_count", units: "count", data: old }] },
  }, { ingestRatePerHour: 0 });
  assert.equal((await ingested.json()).dropped_stale, STALE_HINT_AT);
  const summary = await (await handleRequest(request("/summary?date=2026-10-16"), ctx(storage, { ingestRatePerHour: 0 }))).json();
  assert.equal(summary.steps, 15);
  assert.equal(summary.export_hint, EXPORT_HINT);
  assert.match(summary.export_hint, /Recommended export settings/);
  assert.match(summary.export_hint, /README/);

  const mcp = await handleRequest(request("/mcp", {
    method: "POST",
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_daily_summary", arguments: { date: "2026-10-16" } },
    }),
  }), ctx(storage, { ingestRatePerHour: 0 }));
  const tool = await mcp.json();
  assert.equal(tool.result.structuredContent.export_hint, EXPORT_HINT);
  assert.match(tool.result.content[0].text, /Recommended export settings/);

  const healed = await postIngest(storage, steps("2026-10-16", 15), { ingestRatePerHour: 0 });
  assert.equal((await healed.json()).dropped_stale, 0);
  const cleared = await (await handleRequest(request("/summary?date=2026-10-16"), ctx(storage))).json();
  assert.equal(cleared.export_hint, undefined);

  const limited = new MemoryStorage();
  await postIngest(limited, steps("2026-10-16", 1), { ingestRatePerHour: 1 });
  const blocked = await postIngest(limited, steps("2026-10-15", 2), { ingestRatePerHour: 1 });
  assert.equal(blocked.status, 429);
  const hinted = await (await handleRequest(request("/summary?date=2026-10-16"), ctx(limited))).json();
  assert.equal(hinted.export_hint, EXPORT_HINT);
  const quiet = await postIngest(limited, steps("2026-10-15", 3), { ingestRatePerHour: 1 });
  assert.equal(quiet.status, 429);
  assert.equal(limited.exportHint, EXPORT_HINT);
});

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
      async run() {
        if (writes && /^\s*(INSERT|DELETE)/i.test(sql)) writes.n += 1;
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
          if (writes && /^\s*(INSERT|DELETE)/i.test(stmt.sql)) writes.n += 1;
          db.prepare(stmt.sql).run(...stmt.params);
        }
      })(statements);
      return [];
    },
  };
}

test("D1 repeat of the same day does not write, and an accepted post adds one quota write", async () => {
  const source = fs.readFileSync(new URL("../src/adapters/d1.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\bBEGIN\b|\bCOMMIT\b/);
  assert.match(source, /db\.batch\(/);

  const db = new Database(":memory:");
  applySqliteMigrations(db);
  const writes = { n: 0 };
  const envStorage = new D1Storage(d1FromSqlite(db, writes));
  const quiet = ctx(envStorage, { ingestRatePerHour: 0 });
  const first = await handleRequest(request("/ingest", { method: "POST", body: JSON.stringify(steps("2026-10-16", 20)) }), quiet);
  assert.equal((await first.json()).written, 1);
  assert.equal(writes.n, 1);
  const before = writes.n;
  const repeat = await handleRequest(request("/ingest", { method: "POST", body: JSON.stringify(steps("2026-10-16", 20)) }), quiet);
  const repeatBody = await repeat.json();
  assert.equal(repeatBody.written, 0);
  assert.equal(repeatBody.unchanged, 1);
  assert.equal(writes.n, before);

  const counted = { n: 0 };
  const rated = new D1Storage(d1FromSqlite(db, counted));
  const limited = ctx(rated, { ingestRatePerHour: 5 });
  const accepted = await handleRequest(request("/ingest", { method: "POST", body: JSON.stringify(steps("2026-10-16", 20)) }), limited);
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).unchanged, 1);
  assert.equal(counted.n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ingest_quota").get().n, 1);
  const quotaSql = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'ingest_quota'").get().sql;
  assert.match(quotaSql, /token_key/);
  assert.equal(UPSERT_QUOTA.includes("BEGIN"), false);
  db.close();
});

test("apple health chunk posts are not rate limited", async () => {
  const storage = new MemoryStorage();
  const environment = ctx(storage, { ingestRatePerHour: 1 });
  const body = JSON.stringify({
    points: [{
      metric: "step_count",
      date: "2020-03-01",
      sum_qty: 2,
      last_qty: 2,
      last_ts: "2020-03-01",
      units: "count",
      n: 1,
    }],
  });
  const first = await handleRequest(request("/import/apple-health/chunk", { method: "POST", body }), environment);
  const second = await handleRequest(request("/import/apple-health/chunk", { method: "POST", body }), environment);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(storage.quota.size, 0);
});
