import assert from "node:assert/strict";
import pg from "pg";
import { test } from "node:test";
import { createPostgresStorageFromPool } from "../src/adapters/postgres.js";
import { handleRequest } from "../src/core/http.js";
import { hourWindowStart } from "../src/core/ingest-guard.js";

const url = process.env.HEALTH_POSTGRES_URL;
const NOW = new Date("2026-10-16T12:30:00Z");

function request(body) {
  return new Request("http://localhost/ingest", {
    method: "POST",
    headers: { authorization: "Bearer tok", "content-type": "application/json" },
    body,
  });
}

test("postgres stores the quota hour past a 32-bit integer", { skip: url ? false : "HEALTH_POSTGRES_URL is unset" }, async () => {
  const pool = new pg.Pool({ connectionString: url });
  const storage = createPostgresStorageFromPool(pool);
  try {
    await storage.migrate();
    await pool.query("DELETE FROM ingest_quota");
    await pool.query("DELETE FROM export_hint");
    await pool.query("DELETE FROM points_daily");
    await pool.query("DELETE FROM workouts");
    await pool.query("DELETE FROM raw_payloads");
    await pool.query("DELETE FROM ingest_backfill");

    const column = await pool.query(
      "SELECT data_type FROM information_schema.columns WHERE table_name = 'ingest_quota' AND column_name = 'window_start'",
    );
    assert.equal(column.rows[0].data_type, "bigint");

    const ctx = {
      storage,
      token: "tok",
      timeZone: "UTC",
      now: NOW,
      ingestRatePerHour: 2,
      ingestBackfillPerHour: 2,
    };
    const body = JSON.stringify({
      data: {
        metrics: [{ name: "step_count", units: "count", data: [{ date: "2026-10-16 09:00:00 +0000", qty: 3 }] }],
      },
    });
    const first = await handleRequest(request(body), ctx);
    assert.equal(first.status, 200, JSON.stringify(await first.clone().json()));
    const second = await handleRequest(request(body), ctx);
    assert.equal(second.status, 200);
    const third = await handleRequest(request(body), ctx);
    assert.equal(third.status, 429);

    const quota = await pool.query("SELECT window_start, hits FROM ingest_quota");
    assert.equal(quota.rows.length, 1);
    const windowStart = Number(quota.rows[0].window_start);
    assert.equal(windowStart, hourWindowStart(NOW));
    assert.ok(windowStart > 2_147_483_647);
    assert.equal(Number(quota.rows[0].hits), 2);
    assert.equal((await storage.queryDaySummary("2026-10-16")).steps, 3);
  } finally {
    await pool.end();
  }
});

test("postgres keeps concurrent ingest under the stored total", { skip: url ? false : "HEALTH_POSTGRES_URL is unset" }, async () => {
  const pool = new pg.Pool({ connectionString: url });
  const storage = createPostgresStorageFromPool(pool);
  try {
    await storage.migrate();
    await pool.query("DELETE FROM ingest_quota");
    await pool.query("DELETE FROM export_hint");
    await pool.query("DELETE FROM points_daily");
    await pool.query("DELETE FROM workouts");
    await pool.query("DELETE FROM raw_payloads");
    await pool.query("DELETE FROM ingest_backfill");
    const dates = ["2020-07-01", "2020-07-02", "2020-07-03", "2020-07-04", "2020-07-05"];
    const responses = await Promise.all(dates.map((date) => {
      const body = JSON.stringify({
        data: {
          metrics: [{ name: "step_count", units: "count", data: [{ date: `${date} 09:00:00 +0000`, qty: 1 }] }],
        },
        pad: "y".repeat(640),
      });
      assert.ok(Buffer.byteLength(body) > 500 && Buffer.byteLength(body) <= 1000);
      return handleRequest(request(body), {
        storage,
        token: "tok",
        timeZone: "UTC",
        now: NOW,
        ingestBackfillTotalBytes: 1000,
      });
    }));
    const statuses = [];
    for (const response of responses) statuses.push(response.status);
    assert.equal(statuses.filter((status) => status === 200).length, 1);
    const row = await pool.query("SELECT bytes, closed_at FROM ingest_backfill");
    assert.equal(row.rows.length, 1);
    assert.ok(Number(row.rows[0].bytes) <= 1000);
    const stored = await pool.query("SELECT COUNT(*)::int AS n FROM points_daily");
    assert.equal(stored.rows[0].n, 1);
  } finally {
    await pool.end();
  }
});

test("postgres rolls back a reservation when the write fails", { skip: url ? false : "HEALTH_POSTGRES_URL is unset" }, async () => {
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  const storage = createPostgresStorageFromPool(pool);
  try {
    await storage.migrate();
    await pool.query("DELETE FROM ingest_backfill");
    await pool.query("DELETE FROM points_daily");
    storage.insertIngest = async () => {
      throw new Error("write failed");
    };
    await assert.rejects(() => storage.reserveIngestBackfill({
      openedAt: NOW.toISOString(),
      closeAt: NOW.toISOString(),
      addBytes: 80,
      totalBytes: 80,
      deadline: "2026-10-19T12:30:00.000Z",
      nowIso: NOW.toISOString(),
      points: [],
      workouts: [],
      write: () => storage.insertIngest({}),
    }), /write failed/);
    const row = await pool.query("SELECT COUNT(*)::int AS n FROM ingest_backfill");
    assert.equal(row.rows[0].n, 0);
  } finally {
    await pool.end();
  }
});
