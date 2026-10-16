import assert from "node:assert/strict";
import { test } from "node:test";
import { D1Storage } from "../src/adapters/d1.js";
import { D1_BATCH_LIMIT } from "../src/adapters/statements.js";
import {
  FREE_TIER_CPU_MS,
  FREE_TIER_D1_WRITES_PER_DAY,
  FREE_TIER_PLAN,
  createFreeTierBudget,
  onWorkersRuntime,
} from "../src/core/free-tier.js";

function logsOf(options = {}) {
  const lines = [];
  const budget = createFreeTierBudget({ ...options, log: (line) => lines.push(line) });
  return { lines, budget };
}

test("free tier allows a 501-row write and stays under the daily cap", () => {
  const { lines, budget } = logsOf();
  assert.equal(FREE_TIER_D1_WRITES_PER_DAY, 100_000);
  assert.equal(FREE_TIER_CPU_MS, 10);
  assert.equal(budget.allowD1Writes(D1_BATCH_LIMIT + 1), D1_BATCH_LIMIT + 1);
  assert.deepEqual(lines, []);
});

test("free tier logs when a D1 write limit is approached and stops at the cap", () => {
  const { lines, budget } = logsOf({ d1WritesPerDay: 1000 });
  assert.equal(budget.allowD1Writes(800), 800);
  const approaching = JSON.parse(lines[0]);
  assert.equal(approaching.signal, "limit_approaching");
  assert.equal(approaching.limit, "d1_rows_written");
  assert.equal(approaching.used, 800);
  assert.equal(approaching.cap, 1000);
  assert.equal(approaching.plan, FREE_TIER_PLAN);
  assert.equal(budget.allowD1Writes(1), 1);
  assert.equal(lines.length, 1);
  assert.equal(budget.allowD1Writes(200), 0);
  const reached = JSON.parse(lines[1]);
  assert.equal(reached.signal, "limit_reached");
  assert.equal(reached.limit, "d1_rows_written");
  assert.equal(reached.used, 801);
  assert.equal(reached.cap, 1000);
  assert.equal(reached.plan, "free tier; upgrade when a real limit is hit");
  assert.equal(budget.allowD1Writes(199), 199);
  assert.equal(lines.length, 2);
  assert.equal(budget.allowD1Writes(1), 0);
});

test("free tier D1 budget resets on the next UTC day", () => {
  let now = new Date("2026-10-16T23:30:00Z");
  const { lines, budget } = logsOf({ d1WritesPerDay: 10, now: () => now });
  assert.equal(budget.allowD1Writes(8), 8);
  assert.equal(JSON.parse(lines[0]).signal, "limit_approaching");
  now = new Date("2026-10-17T00:30:00Z");
  assert.equal(budget.allowD1Writes(8), 8);
  assert.equal(lines.length, 2);
});

test("free tier logs when worker CPU approaches 10 ms", () => {
  const { lines, budget } = logsOf();
  budget.noteWorkerCpu(7.9);
  assert.deepEqual(lines, []);
  budget.noteWorkerCpu(8);
  const approaching = JSON.parse(lines[0]);
  assert.equal(approaching.signal, "limit_approaching");
  assert.equal(approaching.limit, "worker_cpu_ms");
  assert.equal(approaching.used, 8);
  assert.equal(approaching.cap, 10);
  assert.equal(approaching.plan, FREE_TIER_PLAN);
  budget.noteWorkerCpu(9);
  assert.equal(lines.length, 1);
  budget.noteWorkerCpu(10);
  assert.equal(JSON.parse(lines[1]).signal, "limit_reached");
  assert.equal(JSON.parse(lines[1]).limit, "worker_cpu_ms");
});

test("D1 adapter writes a fitting batch and drops one that would pass the cap", async () => {
  const batches = [];
  const db = {
    prepare() {
      return { bind() { return { sql: "x" }; } };
    },
    async batch(statements) {
      batches.push(statements.length);
    },
  };
  const points = Array.from({ length: D1_BATCH_LIMIT }, (_, index) => ({
    date: "2026-10-16",
    metric: `step_count_${index}`,
    sum_qty: 1,
    last_qty: 1,
    last_ts: "2026-10-16",
    units: "count",
    n: 1,
  }));
  const batch = {
    id: "id",
    date: "2026-10-16",
    receivedAt: "2026-10-16T00:00:00Z",
    bytes: 1,
    payload: "{}",
    storeRaw: true,
    points,
    workouts: [],
  };
  const room = logsOf({ d1WritesPerDay: 100_000 });
  await new D1Storage(db, { allowWrites: (count) => room.budget.allowD1Writes(count) }).insertIngest(batch);
  assert.deepEqual(batches, [D1_BATCH_LIMIT, 1]);
  const tight = logsOf({ d1WritesPerDay: 10 });
  await new D1Storage(db, { allowWrites: (count) => tight.budget.allowD1Writes(count) }).insertIngest(batch);
  assert.deepEqual(batches, [D1_BATCH_LIMIT, 1]);
  assert.equal(JSON.parse(tight.lines[0]).signal, "limit_reached");
});

test("CPU sampling stays off outside the Workers runtime", () => {
  assert.equal(onWorkersRuntime(), false);
});
