import assert from "node:assert/strict";
import { test } from "node:test";
import { handleRequest } from "../src/core/http.js";
import {
  DEFAULT_INGEST_BACKFILL_HOURS,
  DEFAULT_INGEST_BACKFILL_MAX_BYTES,
  DEFAULT_INGEST_BACKFILL_MAX_PER_HOUR,
  DEFAULT_INGEST_BACKFILL_MAX_TOTAL_BYTES,
  INITIAL_IMPORT_CLOSED,
  MAX_INGEST_BACKFILL_HOURS,
  MAX_INGEST_BACKFILL_MAX_BYTES,
  MAX_INGEST_BACKFILL_MAX_PER_HOUR,
  MAX_INGEST_BACKFILL_MAX_TOTAL_BYTES,
  shorterDateRange,
  backfillClosesAt,
  resolveBackfillHours,
  resolveBackfillMaxBytes,
  resolveBackfillPerHour,
  resolveBackfillTotalBytes,
} from "../src/core/ingest-guard.js";
import { MemoryStorage } from "../src/core/memory.js";

const NOW = new Date("2026-10-16T12:30:00Z");

function request(pathname, { method = "POST", token = "tok", body, headers = {} } = {}) {
  const initHeaders = new Headers(headers);
  if (token) initHeaders.set("authorization", `Bearer ${token}`);
  if (body != null && !initHeaders.has("content-type")) initHeaders.set("content-type", "application/json");
  return new Request(`http://localhost${pathname}`, { method, headers: initHeaders, body });
}

function ctx(storage, extra = {}) {
  return { token: "tok", timeZone: "UTC", storage, now: NOW, ...extra };
}

function steps(date, qty = 10) {
  return {
    data: {
      metrics: [{ name: "step_count", units: "count", data: [{ date: `${date} 09:00:00 -0700`, qty }] }],
    },
  };
}

function post(storage, body, extra = {}, headers = {}) {
  const payload = JSON.stringify(body);
  return {
    payload,
    response: handleRequest(request("/ingest", { body: payload, headers }), ctx(storage, extra)),
  };
}

function exactSize(date, qty, size) {
  const base = steps(date, qty);
  const empty = JSON.stringify({ ...base, pad: "" });
  const need = size - empty.length;
  assert.ok(need >= 0, `size ${size} is smaller than ${empty.length}`);
  const body = { ...base, pad: "x".repeat(need) };
  assert.equal(JSON.stringify(body).length, size);
  return body;
}

test("the first import accepts old history and a large chunk", async () => {
  const storage = new MemoryStorage();
  const body = { ...steps("2020-03-01", 4), pad: "x".repeat(800) };
  const sent = post(storage, body, { ingestMaxBodyBytes: 500, ingestBackfillMaxBytes: 5_000, ingestRatePerHour: 1 });
  assert.ok(sent.payload.length > 500);
  const response = await sent.response;
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.dropped_stale, 0);
  assert.equal(payload.dropped_future, 0);
  assert.equal(payload.backfill.open, true);
  assert.equal(payload.backfill.closes_at, backfillClosesAt(NOW.toISOString(), DEFAULT_INGEST_BACKFILL_HOURS));
  assert.equal(payload.backfill.bytes_remaining, DEFAULT_INGEST_BACKFILL_MAX_TOTAL_BYTES - sent.payload.length);
  assert.equal((await storage.queryDaySummary("2020-03-01")).steps, 4);
  assert.equal(storage.backfill.days, 1);
  assert.equal(storage.backfill.closed_at, null);

  const tooBig = exactSize("2020-03-02", 1, 5_001);
  const rejected = await post(storage, tooBig, { ingestMaxBodyBytes: 500, ingestBackfillMaxBytes: 5_000 }).response;
  assert.equal(rejected.status, 413);
  const error = await rejected.json();
  assert.equal(error.error, "payload_too_large");
  assert.ok(error.message.includes(shorterDateRange(5_000)));
  assert.equal(error.message.includes(INITIAL_IMPORT_CLOSED), false);
  assert.equal(error.backfill.open, true);
  assert.equal((await storage.queryDaySummary("2020-03-02")).steps, null);
});

test("chunked imports replay the same days and skip unchanged days", async () => {
  const storage = new MemoryStorage();
  const extra = { ingestRatePerHour: 1 };
  const first = await post(storage, {
    data: {
      metrics: [{
        name: "step_count",
        units: "count",
        data: [
          { date: "2020-01-02 09:00:00 -0700", qty: 2 },
          { date: "2020-01-03 09:00:00 -0700", qty: 3 },
        ],
      }],
    },
  }, extra).response;
  const firstBody = await first.json();
  assert.equal(first.status, 200);
  assert.equal(firstBody.written, 2);
  assert.equal(firstBody.unchanged, 0);
  assert.equal(storage.backfill.days, 2);

  const repeat = await post(storage, {
    data: {
      metrics: [{
        name: "step_count",
        units: "count",
        data: [
          { date: "2020-01-02 09:00:00 -0700", qty: 2 },
          { date: "2020-01-03 09:00:00 -0700", qty: 3 },
        ],
      }],
    },
  }, extra).response;
  const repeatBody = await repeat.json();
  assert.equal(repeatBody.written, 0);
  assert.equal(repeatBody.unchanged, 2);
  assert.equal(storage.backfill.days, 2);

  const next = await post(storage, steps("2020-01-04", 8), extra).response;
  assert.equal((await next.json()).written, 1);
  assert.equal(storage.backfill.days, 3);
  assert.equal((await storage.queryDaySummary("2020-01-04")).steps, 8);
});

test("the window closes on time, on the total, and on an explicit done", async () => {
  const expired = new MemoryStorage();
  const opened = new Date(NOW.getTime() - 73 * 3_600_000).toISOString();
  expired.backfill = { opened_at: opened, closed_at: null, bytes: 20, days: 1 };
  const aged = await post(expired, steps("2020-04-01", 1)).response;
  assert.equal(aged.status, 422);
  assert.equal(expired.backfill.closed_at, backfillClosesAt(opened, DEFAULT_INGEST_BACKFILL_HOURS));
  assert.equal(expired.backfill.bytes, 20);

  const budget = new MemoryStorage();
  const limits = { ingestBackfillTotalBytes: 2_000, ingestBackfillMaxBytes: 1_500, ingestMaxBodyBytes: 100 };
  const first = exactSize("2020-05-01", 1, 700);
  const accepted = await post(budget, first, limits).response;
  assert.equal(accepted.status, 200);
  const acceptedBody = await accepted.json();
  assert.equal(acceptedBody.backfill.open, true);
  assert.equal(acceptedBody.backfill.bytes_remaining, 1_300);
  const overflow = exactSize("2020-05-02", 1, 1_301);
  const blocked = await post(budget, overflow, limits).response;
  assert.equal(blocked.status, 413);
  const blockedBody = await blocked.json();
  assert.match(blockedBody.message, /initial import total/);
  assert.ok(blockedBody.message.includes(shorterDateRange(1_500)));
  assert.equal(blockedBody.backfill.open, true);
  assert.equal(budget.backfill.bytes, 700);
  const finish = exactSize("2020-05-03", 1, 1_300);
  const filled = await post(budget, finish, limits).response;
  assert.equal(filled.status, 200);
  const filledBody = await filled.json();
  assert.equal(filledBody.backfill.open, false);
  assert.equal(filledBody.backfill.bytes_remaining, 0);
  assert.equal(budget.backfill.closed_at, NOW.toISOString());

  const header = new MemoryStorage();
  const viaHeader = await post(header, steps("2019-06-01", 5), {}, { "x-backfill": "done" }).response;
  assert.equal(viaHeader.status, 200);
  assert.equal((await viaHeader.json()).backfill.open, false);
  assert.equal((await header.queryDaySummary("2019-06-01")).steps, 5);

  const field = new MemoryStorage();
  const viaField = await post(field, { ...steps("2019-07-01", 6), backfill: "done" }).response;
  assert.equal(viaField.status, 200);
  assert.equal((await viaField.json()).backfill.open, false);
  assert.equal((await field.queryDaySummary("2019-07-01")).steps, 6);

  const only = new MemoryStorage();
  const viaOnly = await post(only, { backfill: "done" }).response;
  assert.equal(viaOnly.status, 200);
  assert.equal((await viaOnly.json()).backfill.open, false);
  assert.equal(only.backfill.days, 0);
  assert.equal(only.points.size, 0);
});

test("after the window closes, old dates and oversize requests are rejected with the hint", async () => {
  const storage = new MemoryStorage();
  await post(storage, { backfill: "done" }).response;
  const old = await post(storage, steps("2018-01-01", 3), { ingestMaxBodyBytes: 1_000 }).response;
  assert.equal(old.status, 422);
  const oldBody = await old.json();
  assert.equal(oldBody.error, "outside_window");
  assert.match(oldBody.message, new RegExp(INITIAL_IMPORT_CLOSED));
  assert.equal(oldBody.backfill.open, false);
  assert.equal((await storage.queryDaySummary("2018-01-01")).steps, null);

  const recent = steps("2026-10-16", 9);
  const text = JSON.stringify(recent);
  const sized = { ...recent, pad: "x".repeat(text.length + 50) };
  const over = await post(storage, sized, { ingestMaxBodyBytes: text.length }).response;
  assert.equal(over.status, 413);
  const overBody = await over.json();
  assert.equal(overBody.error, "payload_too_large");
  assert.match(overBody.message, new RegExp(INITIAL_IMPORT_CLOSED));
  assert.equal(overBody.backfill.open, false);

  const rated = new MemoryStorage();
  rated.backfill = {
    opened_at: "2026-10-01T00:00:00.000Z",
    closed_at: "2026-10-01T00:00:00.000Z",
    bytes: 10,
    days: 1,
  };
  const allowed = await post(rated, steps("2026-10-16", 9), { ingestRatePerHour: 1 }).response;
  assert.equal(allowed.status, 200);
  const limited = await post(rated, steps("2026-10-16", 9), { ingestRatePerHour: 1 }).response;
  assert.equal(limited.status, 429);
  const limitedBody = await limited.json();
  assert.match(limitedBody.message, /1 per hour/);
  assert.match(limitedBody.message, new RegExp(INITIAL_IMPORT_CLOSED));
  assert.equal(limitedBody.backfill.open, false);
});

test("a closed window never reopens", async () => {
  const storage = new MemoryStorage();
  const done = await post(storage, steps("2020-08-01", 2), {}, { "X-Backfill": "Done" }).response;
  assert.equal((await done.json()).backfill.open, false);
  const closedAt = storage.backfill.closed_at;
  const bytes = storage.backfill.bytes;
  const openedAt = storage.backfill.opened_at;
  const reserved = await storage.reserveIngestBackfill({
    openedAt: NOW.toISOString(),
    closeAt: null,
    addBytes: 50,
    totalBytes: 500,
    deadline: "2026-10-19T12:30:00.000Z",
    nowIso: NOW.toISOString(),
    points: [],
    workouts: [],
  });
  assert.equal(reserved, null);
  assert.equal(storage.backfill.opened_at, openedAt);
  assert.equal(storage.backfill.closed_at, closedAt);
  assert.equal(storage.backfill.bytes, bytes);

  const again = await post(storage, steps("2020-08-02", 3)).response;
  assert.equal(again.status, 422);
  assert.equal(storage.backfill.closed_at, closedAt);
  assert.equal(storage.backfill.bytes, bytes);
  const recent = await post(storage, steps("2026-10-16", 1), { ingestRatePerHour: 0 }).response;
  assert.equal(recent.status, 200);
  assert.equal((await recent.json()).backfill.open, false);
  assert.equal(storage.backfill.bytes, bytes);
  assert.equal(storage.backfill.closed_at, closedAt);
});

test("future dates are rejected during the window", async () => {
  const storage = new MemoryStorage();
  const response = await post(storage, {
    data: {
      metrics: [{
        name: "step_count",
        units: "count",
        data: [
          { date: "2020-09-01 09:00:00 -0700", qty: 4 },
          { date: "2026-10-17 09:00:00 -0700", qty: 5 },
          { date: "2026-10-18 09:00:00 -0700", qty: 6 },
        ],
      }],
    },
  }).response;
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.dropped_future, 1);
  assert.equal(body.dropped_stale, 0);
  assert.equal(body.backfill.open, true);
  assert.equal((await storage.queryDaySummary("2020-09-01")).steps, 4);
  assert.equal((await storage.queryDaySummary("2026-10-17")).steps, 5);
  assert.equal((await storage.queryDaySummary("2026-10-18")).steps, null);
});

test("import window limits clamp when the env vars are malformed", () => {
  assert.equal(resolveBackfillHours("nope"), DEFAULT_INGEST_BACKFILL_HOURS);
  assert.equal(resolveBackfillHours(0), DEFAULT_INGEST_BACKFILL_HOURS);
  assert.equal(resolveBackfillHours(-4), DEFAULT_INGEST_BACKFILL_HOURS);
  assert.equal(resolveBackfillHours(""), DEFAULT_INGEST_BACKFILL_HOURS);
  assert.equal(resolveBackfillHours("72"), 72);
  assert.equal(resolveBackfillHours(100_000), MAX_INGEST_BACKFILL_HOURS);
  assert.equal(resolveBackfillMaxBytes("banana"), DEFAULT_INGEST_BACKFILL_MAX_BYTES);
  assert.equal(resolveBackfillMaxBytes(10 ** 20), MAX_INGEST_BACKFILL_MAX_BYTES);
  assert.equal(resolveBackfillPerHour(null), DEFAULT_INGEST_BACKFILL_MAX_PER_HOUR);
  assert.equal(resolveBackfillPerHour(10_001), MAX_INGEST_BACKFILL_MAX_PER_HOUR);
  assert.equal(resolveBackfillTotalBytes(0), DEFAULT_INGEST_BACKFILL_MAX_TOTAL_BYTES);
  assert.equal(resolveBackfillTotalBytes(9_000_000_000), MAX_INGEST_BACKFILL_MAX_TOTAL_BYTES);
  assert.equal(resolveBackfillTotalBytes(1), 1);
});
