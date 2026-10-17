import pg from "pg";
import { shouldStoreRaw } from "../core/aggregate.js";
import { countNewDays, hintAction, normalizeBackfill, partitionIngest, withExportHint } from "../core/ingest-guard.js";
import { summarizeDay } from "../core/summary.js";
import { dateSpan, jsonChunks, pointJson, workoutJson } from "./bulk.js";
import { migrationFiles } from "./migrate.js";
import {
  DELETE_HINT,
  FINISH_BACKFILL,
  HAS_STORED_DATA,
  INSERT_RAW,
  LIST_METRICS,
  METRIC_RANGE,
  POINTS_BETWEEN,
  POINTS_FOR_DATE,
  CLAIM_QUOTA,
  CLOSE_BACKFILL,
  READ_BACKFILL,
  READ_HINT,
  RESERVE_BACKFILL,
  splitStatements,
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

const INSERT_WORKOUTS_JSON =
  "INSERT INTO workouts (name, start, date, duration_min, kcal) " +
  "SELECT r.n, r.s, r.d, r.m, r.k FROM jsonb_to_recordset(?::jsonb) " +
  "AS r(n text, s text, d text, m float8, k float8) " +
  "ON CONFLICT(name, start) DO NOTHING";

const { Pool } = pg;

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
        try {
          await client.query("BEGIN");
          for (const statement of splitStatements(file.sql)) await client.query(statement);
          await client.query("INSERT INTO schema_migrations (id, applied_at) VALUES ($1, $2)", [
            file.id,
            new Date().toISOString(),
          ]);
          await client.query("COMMIT");
        } catch (error) {
          try {
            await client.query("ROLLBACK");
          } catch {
            // The connection may already be unusable.
          }
          throw error;
        } finally {
          client.release();
        }
      }
    },
    async readIngestBackfill() {
      const result = await pool.query(toPostgres(READ_BACKFILL));
      return normalizeBackfill(result.rows[0]);
    },
    async hasStoredData() {
      const result = await pool.query(toPostgres(HAS_STORED_DATA));
      return result.rows.length > 0;
    },
    async loadStored(dates) {
      const span = dateSpan(dates);
      if (!span) return { points: [], workouts: [] };
      const points = await pool.query(toPostgres(POINTS_BETWEEN), span);
      const workouts = await pool.query(toPostgres(WORKOUTS_RANGE), span);
      return { points: points.rows, workouts: workouts.rows };
    },
    async countNewIngestDays(points, workouts) {
      const dates = [...new Set([...(points || []).map((point) => point.date), ...(workouts || []).map((workout) => workout.date)])];
      return countNewDays(points, workouts, await this.loadStored(dates));
    },
    async reserveIngestBackfill(args) {
      const addDays = await this.countNewIngestDays(args.points, args.workouts);
      const result = await pool.query(toPostgres(RESERVE_BACKFILL), [
        args.openedAt,
        args.closeAt,
        args.addBytes,
        addDays,
        args.deadline,
        args.totalBytes,
        args.nowIso,
        args.nowIso,
      ]);
      const reserved = normalizeBackfill(result.rows[0]);
      if (!reserved) return null;
      if (args.write) await args.write();
      return reserved;
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
    async readExportHint() {
      const result = await pool.query(toPostgres(READ_HINT));
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
      const dates = [...new Set([...(batch.points || []).map((point) => point.date), ...(batch.workouts || []).map((workout) => workout.date)])];
      const stored = await this.loadStored(dates);
      const diff = partitionIngest(batch.points, batch.workouts, stored);
      const newDays = countNewDays(batch.points, batch.workouts, stored);
      const action = hintAction(options.hint === undefined ? null : await this.readExportHint(), options.hint);
      const hasRaw = shouldStoreRaw(batch);
      const replacePoints = diff.points.filter((point) => point.replace);
      const guardPoints = diff.points.filter((point) => !point.replace);
      const insertOnly = diff.workouts.filter((workout) => workout.insertOnly);
      const upserts = diff.workouts.filter((workout) => !workout.insertOnly);
      if (!hasRaw && diff.points.length === 0 && diff.workouts.length === 0 && action === "skip") {
        return { written: diff.written, unchanged: diff.unchanged, newDays };
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        if (hasRaw) {
          await client.query(toPostgres(INSERT_RAW), [batch.id, batch.date, batch.receivedAt, batch.bytes, batch.payload]);
        }
        for (const chunk of jsonChunks(replacePoints.map(pointJson))) {
          await client.query(toPostgres(REPLACE_POINTS_JSON), [chunk]);
        }
        for (const chunk of jsonChunks(guardPoints.map(pointJson))) {
          await client.query(toPostgres(UPSERT_POINTS_JSON), [chunk]);
        }
        for (const chunk of jsonChunks(insertOnly.map(workoutJson))) {
          await client.query(toPostgres(INSERT_WORKOUTS_JSON), [chunk]);
        }
        for (const chunk of jsonChunks(upserts.map(workoutJson))) {
          await client.query(toPostgres(UPSERT_WORKOUTS_JSON), [chunk]);
        }
        if (action === "clear") await client.query(toPostgres(DELETE_HINT));
        if (action === "set") await client.query(toPostgres(UPSERT_HINT), [options.hint]);
        await client.query("COMMIT");
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // The connection may already be unusable.
        }
        throw error;
      } finally {
        client.release();
      }
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
