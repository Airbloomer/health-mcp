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
