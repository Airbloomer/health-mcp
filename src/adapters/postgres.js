import pg from "pg";
import { shouldStoreRaw } from "../core/aggregate.js";
import { shiftIsoDate, workoutsForRange } from "../core/dedupe-workouts.js";
import { isMissingWriterError } from "../core/limits.js";
import { DEFAULT_TIME_ZONE } from "../core/metrics.js";
import { summarizeDay } from "../core/summary.js";
import { migrationFiles } from "./migrate.js";
import {
  INSERT_RAW,
  LIST_METRICS,
  METRIC_RANGE,
  POINTS_FOR_DATE,
  splitStatements,
  toPostgres,
  UPSERT_POINT,
  REPLACE_POINT,
  INSERT_WORKOUT_IF_NEW,
  UPSERT_WORKOUT,
  WORKOUTS_RANGE,
  WORKOUTS_RANGE_LEGACY,
} from "./statements.js";

const { Pool } = pg;

/**
 * Storage over a node-postgres pool. Pass a pool in tests; `openPostgres` opens one from a URL.
 */
async function postgresHasWriter(pool) {
  try {
    await pool.query("SELECT writer FROM workouts LIMIT 0");
    return true;
  } catch (error) {
    if (isMissingWriterError(error)) return false;
    if (error instanceof TypeError) return true;
    throw error;
  }
}

export function createPostgresStorageFromPool(pool, options = {}) {
  const timeZone = options.timeZone || DEFAULT_TIME_ZONE;
  let hasWriter;
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
    async insertIngest(batch) {
      if (hasWriter == null) hasWriter = options.migrate === false ? await postgresHasWriter(pool) : true;
      if (options.migrate === false && hasWriter === false) {
        throw new Error("table workouts has no column named writer");
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        if (shouldStoreRaw(batch)) {
          await client.query(toPostgres(INSERT_RAW), [batch.id, batch.date, batch.receivedAt, batch.bytes, batch.payload]);
        }
        for (const point of batch.points) {
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
        for (const workout of batch.workouts) {
          const writer = workout.writer === "url" ? "url" : "bearer";
          await client.query(toPostgres(workout.insertOnly ? INSERT_WORKOUT_IF_NEW : UPSERT_WORKOUT), [
            workout.name,
            workout.start,
            workout.date,
            workout.duration_min,
            workout.kcal,
            writer,
          ]);
        }
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
    },
    async readWorkouts(startDate, endDate) {
      if (hasWriter == null) {
        try {
          hasWriter = await postgresHasWriter(pool);
        } catch {
          hasWriter = true;
        }
      }
      const sql = toPostgres(hasWriter ? WORKOUTS_RANGE : WORKOUTS_RANGE_LEGACY);
      const result = await pool.query(sql, [shiftIsoDate(startDate, -1), shiftIsoDate(endDate, 1)]);
      return result.rows.map((row) => ({ ...row, writer: row.writer ?? null }));
    },
    async queryDaySummary(date) {
      const points = await pool.query(toPostgres(POINTS_FOR_DATE), [date]);
      const workouts = workoutsForRange(await this.readWorkouts(date, date), date, date, timeZone);
      return summarizeDay(date, points.rows, workouts);
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
      return workoutsForRange(await this.readWorkouts(startDate, endDate), startDate, endDate, timeZone);
    },
    pool,
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
