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
    await assert.rejects(() => storage.withIngestTransaction((client) => storage.reserveIngestBackfill({
      openedAt: NOW.toISOString(),
      closeAt: NOW.toISOString(),
      addBytes: 80,
      totalBytes: 80,
      deadline: "2026-10-19T12:30:00.000Z",
      nowIso: NOW.toISOString(),
      points: [],
      workouts: [],
      client,
      write: async () => {
        throw new Error("write failed");
      },
    })), /write failed/);
    const row = await pool.query("SELECT COUNT(*)::int AS n FROM ingest_backfill");
    assert.equal(row.rows[0].n, 0);
  } finally {
    await pool.end();
  }
});

function shiftDate(iso, days) {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

async function reset(pool) {
  await pool.query("DELETE FROM ingest_quota");
  await pool.query("DELETE FROM export_hint");
  await pool.query("DELETE FROM points_daily");
  await pool.query("DELETE FROM workouts");
  await pool.query("DELETE FROM raw_payloads");
  await pool.query("DELETE FROM ingest_backfill");
}

test("postgres finishes concurrent posts above the pool size", { skip: url ? false : "HEALTH_POSTGRES_URL is unset" }, async () => {
  async function burst(max, count) {
    const pool = new pg.Pool({ connectionString: url, max });
    const storage = createPostgresStorageFromPool(pool);
    try {
      await storage.migrate();
      await reset(pool);
      const requests = Array.from({ length: count }, (_, index) => {
        const date = shiftDate("2015-01-01", index);
        const body = JSON.stringify({
          data: {
            metrics: [{ name: "step_count", units: "count", data: [{ date: `${date} 09:00:00 +0000`, qty: 1 }] }],
          },
        });
        return handleRequest(request(body), {
          storage,
          token: "tok",
          timeZone: "UTC",
          now: NOW,
          ingestRatePerHour: 0,
          ingestBackfillTotalBytes: 500_000_000,
        });
      });
      const timeout = new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`timed out pool ${max}`)), 12_000);
      });
      const responses = await Promise.race([Promise.all(requests), timeout]);
      assert.equal(responses.length, count);
      for (const response of responses) {
        assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
      }
    } finally {
      await pool.end();
    }
  }
  await burst(10, 12);
  await burst(3, 6);
});

test("an apple chunk failure on postgres keeps earlier groups", { skip: url ? false : "HEALTH_POSTGRES_URL is unset" }, async () => {
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  const storage = createPostgresStorageFromPool(pool);
  try {
    await storage.migrate();
    await reset(pool);
    const opener = JSON.stringify({
      data: {
        metrics: [{ name: "step_count", units: "count", data: [{ date: "2026-10-16 09:00:00 +0000", qty: 1 }] }],
      },
    });
    const opened = await handleRequest(request(opener), {
      storage,
      token: "tok",
      timeZone: "UTC",
      now: NOW,
      ingestRatePerHour: 0,
    });
    assert.equal(opened.status, 200, JSON.stringify(await opened.clone().json()));
    const before = await pool.query("SELECT bytes FROM ingest_backfill");
    const original = storage.insertIngest.bind(storage);
    for (const failAt of [2, 3]) {
      await pool.query("DELETE FROM points_daily WHERE date < '2026-01-01'");
      let seen = 0;
      storage.insertIngest = async (batch, options) => {
        if (String(batch.date) < "2020-01-01") {
          seen += 1;
          if (seen === failAt) throw new Error("injected");
        }
        return original(batch, options);
      };
      const points = [];
      for (let index = 0; index < 366 * 2 + 1; index += 1) {
        const date = shiftDate("2010-01-01", index);
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
      await assert.rejects(() => handleRequest(new Request("http://localhost/import/apple-health/chunk", {
        method: "POST",
        headers: { authorization: "Bearer tok", "content-type": "application/json" },
        body: JSON.stringify({ points, workouts: [] }),
      }), {
        storage,
        token: "tok",
        timeZone: "UTC",
        now: NOW,
        ingestRatePerHour: 0,
      }), /injected/);
      const pointsLeft = await pool.query("SELECT COUNT(*)::int AS n FROM points_daily");
      const row = await pool.query("SELECT bytes FROM ingest_backfill");
      const keptGroups = failAt - 1;
      assert.equal(pointsLeft.rows[0].n, 1 + 366 * keptGroups, `group ${failAt}`);
      assert.equal(Number(row.rows[0].bytes), Number(before.rows[0].bytes), `group ${failAt}`);
      seen = 0;
    }
  } finally {
    await pool.end();
  }
});

test("migration 0006 can be applied again on postgres", { skip: url ? false : "HEALTH_POSTGRES_URL is unset" }, async () => {
  const pool = new pg.Pool({ connectionString: url });
  const storage = createPostgresStorageFromPool(pool);
  try {
    await storage.migrate();
    await pool.query("DELETE FROM schema_migrations WHERE id = $1", ["0006_ingest_backfill_deadline.sql"]);
    await storage.migrate();
    const columns = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'ingest_backfill' AND column_name IN ('deadline', 'total_bytes')",
    );
    assert.equal(columns.rows.length, 2);
  } finally {
    await pool.end();
  }
});
