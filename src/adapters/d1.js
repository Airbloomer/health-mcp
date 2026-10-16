import { shouldStoreRaw } from "../core/aggregate.js";
import { shiftIsoDate, workoutsForRange } from "../core/dedupe-workouts.js";
import { D1DailyLimitError, d1DailyLimitKind } from "../core/free-tier.js";
import { isMissingWriterError } from "../core/limits.js";
import { DEFAULT_TIME_ZONE } from "../core/metrics.js";
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
  WORKOUTS_RANGE,
  WORKOUTS_RANGE_LEGACY,
} from "./statements.js";

/**
 * Cloudflare D1 adapter. `db` is the binding (`env.DB`).
 * Schema comes from `migrations/` via `wrangler d1 migrations apply`.
 * Every prepared statement is sent. A documented daily-limit error is rethrown
 * as D1DailyLimitError so the caller can answer 429. Writes are not dropped first.
 */
export class D1Storage {
  constructor(db, options = {}) {
    this.db = db;
    this.timeZone = options.timeZone || DEFAULT_TIME_ZONE;
    this.hasWriter = null;
  }

  async detectWriter() {
    if (this.hasWriter != null) return this.hasWriter;
    try {
      const prepared = this.db.prepare("SELECT writer FROM workouts LIMIT 0");
      const bound = typeof prepared.bind === "function" ? prepared.bind() : prepared;
      if (typeof bound.all !== "function") {
        this.hasWriter = true;
        return true;
      }
      await this.run(() => bound.all());
      this.hasWriter = true;
    } catch (error) {
      if (!isMissingWriterError(error)) throw error;
      this.hasWriter = false;
    }
    return this.hasWriter;
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
    if (!(await this.detectWriter())) throw new Error("table workouts has no column named writer");
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
        this.db.prepare(workout.insertOnly ? INSERT_WORKOUT_IF_NEW : UPSERT_WORKOUT).bind(
          workout.name,
          workout.start,
          workout.date,
          workout.duration_min,
          workout.kcal,
          workout.writer === "url" ? "url" : "bearer",
        ),
      );
    }
    for (let i = 0; i < statements.length; i += D1_BATCH_LIMIT) {
      const chunk = statements.slice(i, i + D1_BATCH_LIMIT);
      if (chunk.length) await this.run(() => this.db.batch(chunk));
    }
  }

  async readWorkouts(startDate, endDate) {
    const hasWriter = await this.detectWriter();
    const sql = hasWriter ? WORKOUTS_RANGE : WORKOUTS_RANGE_LEGACY;
    const result = await this.run(() => this.db.prepare(sql).bind(shiftIsoDate(startDate, -1), shiftIsoDate(endDate, 1)).all());
    return (result.results || []).map((row) => ({ ...row, writer: row.writer ?? null }));
  }

  async queryDaySummary(date) {
    const points = await this.run(() => this.db.prepare(POINTS_FOR_DATE).bind(date).all());
    const workouts = workoutsForRange(await this.readWorkouts(date, date), date, date, this.timeZone);
    return summarizeDay(date, points.results, workouts);
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
    return workoutsForRange(await this.readWorkouts(startDate, endDate), startDate, endDate, this.timeZone);
  }
}
