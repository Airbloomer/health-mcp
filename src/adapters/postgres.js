import pg from "pg";
import { shouldStoreRaw } from "../core/aggregate.js";
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
    async insertIngest(batch) {
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
          await client.query(toPostgres(workout.insertOnly ? INSERT_WORKOUT_IF_NEW : UPSERT_WORKOUT), [
            workout.name,
            workout.start,
            workout.date,
            workout.duration_min,
            workout.kcal,
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
    async queryDaySummary(date) {
      const points = await pool.query(toPostgres(POINTS_FOR_DATE), [date]);
      const workouts = await pool.query(toPostgres(WORKOUTS_FOR_DATE), [date]);
      return summarizeDay(date, points.rows, workouts.rows);
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
