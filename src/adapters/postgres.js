import pg from "pg";
import { shouldStoreRaw } from "../core/aggregate.js";
import { countNewDays, dateGroups, hintAction, MAX_INGEST_DATES, normalizeBackfill, partitionIngest, withExportHint } from "../core/ingest-guard.js";
import { summarizeDay } from "../core/summary.js";
import { ingestWriteChunks } from "./bulk.js";
import { migrationFiles, statementsForPostgres } from "./migrate.js";
import {
  DELETE_HINT,
  FINISH_BACKFILL,
  HAS_STORED_DATA,
  INSERT_RAW,
  LIST_METRICS,
  METRIC_RANGE,
  POINTS_FOR_DATE,
  CLAIM_QUOTA,
  CLOSE_BACKFILL,
  READ_BACKFILL,
  READ_HINT,
  RESERVE_BACKFILL,
  APPLE_MARKER_ID,
  INGEST_MARKER_ID,
  MARK_ORIGIN,
  READ_MARKER,
  SEAL_BACKFILL_IF_MISSING,
  toPostgres,
  UPSERT_HINT,
  WORKOUTS_FOR_DATE,
  WORKOUTS_RANGE,
} from "./statements.js";

const UPSERT_POINTS_JSON =
  "INSERT INTO points_daily (date, metric, sum_qty, last_qty, last_ts, units, n) " +
  "SELECT r.d, r.m, r.s, r.q, r.t, r.u, r.n FROM jsonb_to_recordset(?::jsonb) " +
  "AS r(d text, m text, s float8, q float8, t text, u text, n int) " +
  "ON CONFLICT(date, metric) DO UPDATE SET sum_qty = excluded.sum_qty, last_qty = excluded.last_qty, " +
  "last_ts = excluded.last_ts, units = excluded.units, n = excluded.n " +
  "WHERE excluded.n >= points_daily.n";

const REPLACE_POINTS_JSON =
  "INSERT INTO points_daily (date, metric, sum_qty, last_qty, last_ts, units, n) " +
  "SELECT r.d, r.m, r.s, r.q, r.t, r.u, r.n FROM jsonb_to_recordset(?::jsonb) " +
  "AS r(d text, m text, s float8, q float8, t text, u text, n int) " +
  "ON CONFLICT(date, metric) DO UPDATE SET sum_qty = excluded.sum_qty, last_qty = excluded.last_qty, " +
  "last_ts = excluded.last_ts, units = excluded.units, n = excluded.n";

const UPSERT_WORKOUTS_JSON =
  "INSERT INTO workouts (name, start, date, duration_min, kcal) " +
  "SELECT r.n, r.s, r.d, r.m, r.k FROM jsonb_to_recordset(?::jsonb) " +
  "AS r(n text, s text, d text, m float8, k float8) " +
  "ON CONFLICT(name, start) DO UPDATE SET date = excluded.date, duration_min = excluded.duration_min, kcal = excluded.kcal";

const POINTS_ON_DATES =
  "SELECT date, metric, sum_qty, last_qty, last_ts, units, n FROM points_daily " +
  "WHERE date IN (SELECT value FROM jsonb_array_elements_text(?::jsonb))";

const WORKOUTS_ON_DATES =
  "SELECT name, start, date, duration_min, kcal FROM workouts " +
  "WHERE date IN (SELECT value FROM jsonb_array_elements_text(?::jsonb))";

const INSERT_WORKOUTS_JSON =
  "INSERT INTO workouts (name, start, date, duration_min, kcal) " +
  "SELECT r.n, r.s, r.d, r.m, r.k FROM jsonb_to_recordset(?::jsonb) " +
  "AS r(n text, s text, d text, m float8, k float8) " +
  "ON CONFLICT(name, start) DO NOTHING";

const { Pool } = pg;

const LOCK_TIMEOUT = "4s";
const STATEMENT_TIMEOUT = "8s";

async function setLocalTimeouts(client) {
  await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
  await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);
}

/** Roll back, and return the error when the connection should be discarded. */
async function rollback(client) {
  try {
    await client.query("ROLLBACK");
    return null;
  } catch (error) {
    return error;
  }
}

async function finishClient(client, fn) {
  let discard;
  try {
    return await fn();
  } catch (error) {
    discard = await rollback(client);
    throw error;
  } finally {
    client.release(discard || undefined);
  }
}

/**
 * Storage over a node-postgres pool. Pass a pool in tests; `openPostgres` opens one from a URL.
 */
export function createPostgresStorageFromPool(pool) {
  return {
    async migrate() {
      await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
      for (const file of migrationFiles()) {
        const existing = await pool.query("SELECT id FROM schema_migrations WHERE id = $1", [file.id]);
        if (existing.rows.length) continue;
        const client = await pool.connect();
        await finishClient(client, async () => {
          await client.query("BEGIN");
          for (const statement of statementsForPostgres(file.sql)) await client.query(statement);
          await client.query("INSERT INTO schema_migrations (id, applied_at) VALUES ($1, $2)", [
            file.id,
            new Date().toISOString(),
          ]);
          await client.query("COMMIT");
        });
      }
    },
    query(client, sql, params) {
      return (client || pool).query(sql, params);
    },
    async readIngestBackfill() {
      const result = await pool.query(toPostgres(READ_BACKFILL));
      return normalizeBackfill(result.rows[0]);
    },
    async hasStoredData() {
      const result = await pool.query(toPostgres(HAS_STORED_DATA));
      return result.rows.length > 0;
    },
    /**
     * One connection for the whole request. The reservation and every group
     * commit together. A failure rolls all of them back, which is the only
     * full release on Postgres. lock_timeout and statement_timeout are SET
     * LOCAL on this connection so a waiter cannot hang forever.
     */
    async withIngestTransaction(fn) {
      const client = await pool.connect();
      return finishClient(client, async () => {
        await client.query("BEGIN");
        await setLocalTimeouts(client);
        const value = await fn(client);
        await client.query("COMMIT");
        return value;
      });
    },
    async loadStored(dates, client = null) {
      const points = [];
      const workouts = [];
      for (const group of dateGroups(dates, MAX_INGEST_DATES)) {
        const json = JSON.stringify(group);
        const pointRows = await this.query(client, toPostgres(POINTS_ON_DATES), [json]);
        const workoutRows = await this.query(client, toPostgres(WORKOUTS_ON_DATES), [json]);
        points.push(...pointRows.rows);
        workouts.push(...workoutRows.rows);
      }
      return { points, workouts };
    },
    async countNewIngestDays(points, workouts, client = null) {
      const dates = [...new Set([...(points || []).map((point) => point.date), ...(workouts || []).map((workout) => workout.date)])];
      return countNewDays(points, workouts, await this.loadStored(dates, client));
    },
    async reserveIngestBackfill(args) {
      const client = args.client || null;
      const addDays = await this.countNewIngestDays(args.points, args.workouts, client);
      const reserve = async (runner) => {
        const result = await runner.query(toPostgres(RESERVE_BACKFILL), [
          args.openedAt,
          args.closeAt,
          args.addBytes,
          addDays,
          args.deadline,
          args.totalBytes,
          args.nowIso,
          args.nowIso,
        ]);
        return normalizeBackfill(result.rows[0]);
      };
      // The caller holds the one ingest transaction. A missing client would
      // check out a second connection for the write.
      if (!client) throw new Error("reserve requires the ingest transaction");
      const reserved = await reserve(client);
      if (!reserved) return null;
      if (args.write) await args.write();
      return reserved;
    },
    async sealIngestBackfillIfMissing({ openedAt, closedAt, deadline, totalBytes = 0 }) {
      await pool.query(toPostgres(SEAL_BACKFILL_IF_MISSING), [openedAt, closedAt, 0, 0, deadline || closedAt, totalBytes]);
      return this.readIngestBackfill();
    },
    async finishIngestBackfill({ openedAt, closedAt, addBytes = 0, addDays = 0, deadline, totalBytes = 0 }) {
      const result = await pool.query(toPostgres(FINISH_BACKFILL), [
        openedAt,
        closedAt,
        addBytes,
        addDays,
        deadline || closedAt,
        totalBytes,
      ]);
      return normalizeBackfill(result.rows[0]) || this.readIngestBackfill();
    },
    async closeIngestBackfill(closedAt) {
      const result = await pool.query(toPostgres(CLOSE_BACKFILL), [closedAt]);
      return normalizeBackfill(result.rows[0]) || this.readIngestBackfill();
    },
    async claimIngestQuota(tokenKey, windowStart, limit) {
      const result = await pool.query(toPostgres(CLAIM_QUOTA), [tokenKey, windowStart, limit]);
      const hits = result.rows[0]?.hits;
      return hits == null ? null : Number(hits);
    },
    async readExportHint(client = null) {
      const result = await this.query(client, toPostgres(READ_HINT));
      return result.rows[0]?.hint ?? null;
    },
    async setExportHint(hint) {
      const action = hintAction(await this.readExportHint(), hint);
      if (action === "skip") return false;
      if (action === "clear") await pool.query(toPostgres(DELETE_HINT));
      else await pool.query(toPostgres(UPSERT_HINT), [hint]);
      return true;
    },
    async insertIngest(batch, options = {}) {
      const client = options.client || null;
      const dates = [...new Set([...(batch.points || []).map((point) => point.date), ...(batch.workouts || []).map((workout) => workout.date)])];
      const stored = await this.loadStored(dates, client);
      const diff = partitionIngest(batch.points, batch.workouts, stored);
      const newDays = countNewDays(batch.points, batch.workouts, stored);
      const action = hintAction(options.hint === undefined ? null : await this.readExportHint(client), options.hint);
      const hasRaw = shouldStoreRaw(batch);
      const chunks = ingestWriteChunks(diff.points, diff.workouts);
      let markerId = null;
      if (options.markOrigin) {
        markerId = options.markOrigin === "apple" ? APPLE_MARKER_ID : INGEST_MARKER_ID;
        const existing = await this.query(client, toPostgres(READ_MARKER), [markerId]);
        if (existing.rows.length) markerId = null;
      }
      if (!hasRaw && diff.points.length === 0 && diff.workouts.length === 0 && action === "skip" && markerId == null) {
        return { written: diff.written, unchanged: diff.unchanged, newDays };
      }
      const write = async (runner) => {
        if (markerId != null) await runner.query(toPostgres(MARK_ORIGIN), [markerId]);
        if (hasRaw) {
          await runner.query(toPostgres(INSERT_RAW), [batch.id, batch.date, batch.receivedAt, batch.bytes, batch.payload]);
        }
        for (const chunk of chunks.replacePoints) await runner.query(toPostgres(REPLACE_POINTS_JSON), [chunk]);
        for (const chunk of chunks.guardPoints) await runner.query(toPostgres(UPSERT_POINTS_JSON), [chunk]);
        for (const chunk of chunks.insertOnly) await runner.query(toPostgres(INSERT_WORKOUTS_JSON), [chunk]);
        for (const chunk of chunks.upserts) await runner.query(toPostgres(UPSERT_WORKOUTS_JSON), [chunk]);
        if (action === "clear") await runner.query(toPostgres(DELETE_HINT));
        if (action === "set") await runner.query(toPostgres(UPSERT_HINT), [options.hint]);
      };
      // A caller that already holds the ingest transaction must not check out
      // another connection. Nested BEGIN would commit the outer transaction.
      if (client) {
        await write(client);
        return { written: diff.written, unchanged: diff.unchanged, newDays };
      }
      const held = await pool.connect();
      await finishClient(held, async () => {
        await held.query("BEGIN");
        await write(held);
        await held.query("COMMIT");
      });
      return { written: diff.written, unchanged: diff.unchanged, newDays };
    },
    async queryDaySummary(date) {
      const points = await pool.query(toPostgres(POINTS_FOR_DATE), [date]);
      const workouts = await pool.query(toPostgres(WORKOUTS_FOR_DATE), [date]);
      const hint = await this.readExportHint();
      return withExportHint(summarizeDay(date, points.rows, workouts.rows), hint);
    },
    async queryMetricRange(metric, startDate, endDate) {
      const result = await pool.query(toPostgres(METRIC_RANGE), [metric, startDate, endDate]);
      return result.rows;
    },
    async listMetrics() {
      const result = await pool.query(toPostgres(LIST_METRICS));
      return result.rows.map((row) => row.metric);
    },
    async listWorkouts(startDate, endDate) {
      const result = await pool.query(toPostgres(WORKOUTS_RANGE), [startDate, endDate]);
      return result.rows;
    },
    async close() {
      await pool.end();
    },
  };
}

export async function openPostgres(connectionString) {
  const pool = new Pool({ connectionString });
  const storage = createPostgresStorageFromPool(pool);
  await storage.migrate();
  return storage;
}
