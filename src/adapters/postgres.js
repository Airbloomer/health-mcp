import pg from "pg";
import { shouldStoreRaw } from "../core/aggregate.js";
import { countNewDays, hintAction, normalizeBackfill, partitionIngest, withExportHint } from "../core/ingest-guard.js";
import { summarizeDay } from "../core/summary.js";
import { migrationFiles } from "./migrate.js";
import {
  DELETE_HINT,
  INSERT_RAW,
  LIST_METRICS,
  METRIC_RANGE,
  POINTS_FOR_DATE,
  ADD_BACKFILL,
  CLAIM_QUOTA,
  CLOSE_BACKFILL,
  READ_BACKFILL,
  READ_HINT,
  splitStatements,
  toPostgres,
  UPSERT_HINT,
  UPSERT_POINT,
  REPLACE_POINT,
  INSERT_WORKOUT_IF_NEW,
  UPSERT_WORKOUT,
  WORKOUTS_FOR_DATE,
  WORKOUTS_RANGE,
} from "./statements.js";

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
    async addIngestBackfill({ openedAt, closeAt = null, addBytes = 0, addDays = 0 }) {
      const result = await pool.query(toPostgres(ADD_BACKFILL), [openedAt, closeAt, addBytes, addDays]);
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
      const stored = { points: [], workouts: [] };
      for (const date of dates) {
        const points = await pool.query(toPostgres(POINTS_FOR_DATE), [date]);
        const workouts = await pool.query(toPostgres(WORKOUTS_FOR_DATE), [date]);
        stored.points.push(...points.rows);
        stored.workouts.push(...workouts.rows);
      }
      const diff = partitionIngest(batch.points, batch.workouts, stored);
      const newDays = countNewDays(batch.points, batch.workouts, stored);
      const action = hintAction(options.hint === undefined ? null : await this.readExportHint(), options.hint);
      const hasRaw = shouldStoreRaw(batch);
      if (!hasRaw && diff.points.length === 0 && diff.workouts.length === 0 && action === "skip") {
        return { written: diff.written, unchanged: diff.unchanged, newDays };
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        if (hasRaw) {
          await client.query(toPostgres(INSERT_RAW), [batch.id, batch.date, batch.receivedAt, batch.bytes, batch.payload]);
        }
        for (const point of diff.points) {
          await client.query(toPostgres(point.replace ? REPLACE_POINT : UPSERT_POINT), [
            point.date,
            point.metric,
            point.sum_qty,
            point.last_qty,
            point.last_ts,
            point.units,
            point.n,
          ]);
        }
        for (const workout of diff.workouts) {
          await client.query(toPostgres(workout.insertOnly ? INSERT_WORKOUT_IF_NEW : UPSERT_WORKOUT), [
            workout.name,
            workout.start,
            workout.date,
            workout.duration_min,
            workout.kcal,
          ]);
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
