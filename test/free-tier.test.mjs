import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import worker from "../src/adapters/cloudflare.js";
import { D1Storage } from "../src/adapters/d1.js";
import { D1_BATCH_LIMIT } from "../src/adapters/statements.js";
import {
  FREE_TIER_PLAN,
  d1DailyLimitKind,
  limitHitRecord,
  limitNearRecord,
  secondsUntilNextUtcMidnight,
} from "../src/core/free-tier.js";

const WRITE_LIMIT = "Your account has exceeded D1's free tier daily row write limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.";
const READ_LIMIT = "Your account has exceeded D1's free tier daily row read limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.";

test("retry-after is seconds until the next 00:00 UTC in any host zone", () => {
  const utc = new Date("2026-10-16T23:30:00.000Z");
  const losAngeles = new Date("2026-10-16T16:30:00.000-07:00");
  assert.equal(utc.toISOString(), losAngeles.toISOString());
  assert.equal(secondsUntilNextUtcMidnight(utc), 1800);
  assert.equal(secondsUntilNextUtcMidnight(losAngeles), 1800);
  assert.equal(secondsUntilNextUtcMidnight(new Date("2026-10-17T00:00:00.000Z")), 86400);
});

test("documented D1 daily-limit errors are recognized and other errors are not", () => {
  assert.equal(d1DailyLimitKind(new Error(`D1_ERROR: ${WRITE_LIMIT}`)), "d1_rows_written");
  assert.equal(d1DailyLimitKind({ cause: { message: READ_LIMIT } }), "d1_rows_read");
  assert.equal(d1DailyLimitKind(new Error("D1_ERROR: UNIQUE constraint failed")), null);
});

test("limit log names are limit_near and limit_hit", () => {
  assert.deepEqual(limitNearRecord(["rows"]), { limit_near: ["rows"], plan: FREE_TIER_PLAN });
  assert.deepEqual(limitHitRecord("d1_rows_written"), { limit_hit: "d1_rows_written", plan: FREE_TIER_PLAN });
  assert.equal(JSON.stringify(limitHitRecord("rows")).includes("limit_reached"), false);
  assert.equal(JSON.stringify(limitNearRecord(["rows"])).includes("limit_approaching"), false);
  const source = [
    "src/core/free-tier.js",
    "src/adapters/d1.js",
    "src/adapters/cloudflare.js",
  ];
  for (const file of source) {
    const text = fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.equal(text.includes("limit_approaching"), false, file);
    assert.equal(text.includes("limit_reached"), false, file);
    assert.equal(text.includes("performance.now"), false, file);
    assert.equal(text.includes("allowD1Writes"), false, file);
  }
  const api = fs.readFileSync(new URL("../docs/api.md", import.meta.url), "utf8");
  assert.ok(api.includes(FREE_TIER_PLAN));
  assert.match(api, /429/);
  assert.match(api, /limit_hit/);
  assert.match(api, /limit_near/);
  assert.doesNotMatch(api, /Workers Paid/);
});

test("D1 adapter sends every statement and surfaces the daily write limit", async () => {
  const batches = [];
  const db = {
    prepare() {
      return {
        bind() {
          return {
            sql: "x",
            async all() {
              return { results: [] };
            },
          };
        },
      };
    },
    async batch(statements) {
      batches.push(statements.length);
      throw new Error(WRITE_LIMIT);
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
  await assert.rejects(
    () => new D1Storage(db).insertIngest({
      id: "id",
      date: "2026-10-16",
      receivedAt: "2026-10-16T00:00:00Z",
      bytes: 1,
      payload: "{}",
      storeRaw: true,
      points,
      workouts: [],
    }),
    (error) => error?.code === "D1_DAILY_LIMIT" && error.limit === "d1_rows_written",
  );
  assert.deepEqual(batches, [2]);
});

test("a D1 daily write limit becomes 429 with Retry-After and limit_hit", async () => {
  const lines = [];
  const realLog = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    const sample = fs.readFileSync(new URL("./sample.json", import.meta.url), "utf8");
    const response = await worker.fetch(new Request("http://example.test/ingest", {
      method: "POST",
      headers: { authorization: "Bearer tok", "content-type": "application/json" },
      body: sample,
    }), {
      HEALTH_INGEST_TOKEN: "tok",
      DB: {
        prepare() {
          return {
            bind() {
              return {
                sql: "x",
                async all() {
                  return { results: [] };
                },
              };
            },
          };
        },
        async batch() {
          throw new Error(WRITE_LIMIT);
        },
        async all() {
          return { results: [] };
        },
      },
    });
    assert.equal(response.status, 429);
    const retry = Number(response.headers.get("retry-after"));
    assert.equal(Number.isInteger(retry), true);
    assert.ok(retry >= 1 && retry <= 86400);
    const body = await response.json();
    assert.equal(body.error, "daily_limit");
    assert.equal(body.limit_hit, "d1_rows_written");
    assert.equal(JSON.stringify(body).includes(WRITE_LIMIT), false);
    assert.equal(JSON.parse(lines.at(-1)).limit_hit, "d1_rows_written");
    assert.equal(JSON.parse(lines.at(-1)).plan, FREE_TIER_PLAN);
  } finally {
    console.log = realLog;
  }
});
