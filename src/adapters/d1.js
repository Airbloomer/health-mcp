import { shouldStoreRaw } from "../core/aggregate.js";
import { D1DailyLimitError, d1DailyLimitKind } from "../core/free-tier.js";
import { summarizeDay } from "../core/summary.js";
import {
  D1_BATCH_LIMIT,
  INSERT_RAW,
  LIST_METRICS,
  METRIC_RANGE,
  POINTS_FOR_DATE,
  UPSERT_POINT,
  REPLACE_POINT,
  INSERT_WORKOUT_IF_NEW,
  UPSERT_WORKOUT,
  WORKOUTS_FOR_DATE,
  WORKOUTS_RANGE,
} from "./statements.js";

/**
 * Cloudflare D1 adapter. `db` is the binding (`env.DB`).
 * Schema comes from `migrations/` via `wrangler d1 migrations apply`.
 * Every prepared statement is sent. A documented daily-limit error is rethrown
 * as D1DailyLimitError so the caller can answer 429. Writes are not dropped first.
 */
export class D1Storage {
  constructor(db) {
    this.db = db;
  }

  async run(op) {
    try {
      return await op();
    } catch (error) {
      const limit = d1DailyLimitKind(error);
      if (limit) throw new D1DailyLimitError(limit);
      throw error;
    }
  }

  async insertIngest(batch) {
    const statements = [];
    if (shouldStoreRaw(batch)) {
      statements.push(this.db.prepare(INSERT_RAW).bind(batch.id, batch.date, batch.receivedAt, batch.bytes, batch.payload));
    }
    for (const point of batch.points) {
      statements.push(
        this.db.prepare(point.replace ? REPLACE_POINT : UPSERT_POINT).bind(
          point.date,
          point.metric,
          point.sum_qty,
          point.last_qty,
          point.last_ts,
          point.units,
          point.n,
        ),
      );
    }
    for (const workout of batch.workouts) {
      statements.push(
        this.db.prepare(workout.insertOnly ? INSERT_WORKOUT_IF_NEW : UPSERT_WORKOUT).bind(workout.name, workout.start, workout.date, workout.duration_min, workout.kcal),
      );
    }
    for (let i = 0; i < statements.length; i += D1_BATCH_LIMIT) {
      const chunk = statements.slice(i, i + D1_BATCH_LIMIT);
      if (chunk.length) await this.run(() => this.db.batch(chunk));
    }
  }

  async queryDaySummary(date) {
    const points = await this.run(() => this.db.prepare(POINTS_FOR_DATE).bind(date).all());
    const workouts = await this.run(() => this.db.prepare(WORKOUTS_FOR_DATE).bind(date).all());
    return summarizeDay(date, points.results, workouts.results);
  }

  async queryMetricRange(metric, startDate, endDate) {
    const result = await this.run(() => this.db.prepare(METRIC_RANGE).bind(metric, startDate, endDate).all());
    return result.results || [];
  }

  async listMetrics() {
    const result = await this.run(() => this.db.prepare(LIST_METRICS).all());
    return (result.results || []).map((row) => row.metric);
  }

  async listWorkouts(startDate, endDate) {
    const result = await this.run(() => this.db.prepare(WORKOUTS_RANGE).bind(startDate, endDate).all());
    return result.results || [];
  }
}
