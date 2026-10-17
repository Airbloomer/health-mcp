import { shouldStoreRaw } from "../core/aggregate.js";
import { D1DailyLimitError, d1DailyLimitKind } from "../core/free-tier.js";
import { hintAction, partitionIngest, withExportHint } from "../core/ingest-guard.js";
import { summarizeDay } from "../core/summary.js";
import {
  D1_BATCH_LIMIT,
  DELETE_HINT,
  INSERT_RAW,
  LIST_METRICS,
  METRIC_RANGE,
  POINTS_FOR_DATE,
  READ_HINT,
  CLAIM_QUOTA,
  REPLACE_POINT,
  UPSERT_HINT,
  UPSERT_POINT,
  INSERT_WORKOUT_IF_NEW,
  UPSERT_WORKOUT,
  WORKOUTS_FOR_DATE,
  WORKOUTS_RANGE,
} from "./statements.js";

/**
 * Cloudflare D1 adapter. `db` is the binding (`env.DB`).
 * Schema comes from `migrations/` via `wrangler d1 migrations apply`.
 * Every prepared statement is sent through `db.batch()`. D1 rejects
 * transaction statements, so this adapter never sends those.
 * A documented daily-limit error is rethrown as D1DailyLimitError so the
 * caller can answer 429. Writes are not dropped first.
 * Rows whose stored values already match are omitted, so a repeat post
 * does not write them.
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

  async rowsFor(sql, ...params) {
    const result = await this.run(() => this.db.prepare(sql).bind(...params).all());
    return result?.results || [];
  }

  async loadStored(dates) {
    const points = [];
    const workouts = [];
    for (const date of dates) {
      points.push(...await this.rowsFor(POINTS_FOR_DATE, date));
      workouts.push(...await this.rowsFor(WORKOUTS_FOR_DATE, date));
    }
    return { points, workouts };
  }

  async claimIngestQuota(tokenKey, windowStart, limit) {
    const statement = this.db.prepare(CLAIM_QUOTA).bind(tokenKey, windowStart, limit);
    const results = await this.run(() => this.db.batch([statement]));
    const hits = results?.[0]?.results?.[0]?.hits;
    return hits == null ? null : Number(hits);
  }

  async readExportHint() {
    const rows = await this.rowsFor(READ_HINT);
    return rows[0]?.hint ?? null;
  }

  async setExportHint(hint) {
    const action = hintAction(await this.readExportHint(), hint);
    if (action === "skip") return false;
    const statement = action === "clear" ? this.db.prepare(DELETE_HINT).bind() : this.db.prepare(UPSERT_HINT).bind(hint);
    await this.run(() => this.db.batch([statement]));
    return true;
  }

  async insertIngest(batch, options = {}) {
    const dates = [...new Set([...(batch.points || []).map((point) => point.date), ...(batch.workouts || []).map((workout) => workout.date)])];
    const diff = partitionIngest(batch.points, batch.workouts, await this.loadStored(dates));
    const statements = [];
    if (shouldStoreRaw(batch)) {
      statements.push(this.db.prepare(INSERT_RAW).bind(batch.id, batch.date, batch.receivedAt, batch.bytes, batch.payload));
    }
    for (const point of diff.points) {
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
    for (const workout of diff.workouts) {
      statements.push(
        this.db.prepare(workout.insertOnly ? INSERT_WORKOUT_IF_NEW : UPSERT_WORKOUT).bind(workout.name, workout.start, workout.date, workout.duration_min, workout.kcal),
      );
    }
    const action = hintAction(options.hint === undefined ? null : await this.readExportHint(), options.hint);
    if (action === "clear") statements.push(this.db.prepare(DELETE_HINT).bind());
    if (action === "set") statements.push(this.db.prepare(UPSERT_HINT).bind(options.hint));
    for (let i = 0; i < statements.length; i += D1_BATCH_LIMIT) {
      const chunk = statements.slice(i, i + D1_BATCH_LIMIT);
      if (chunk.length) await this.run(() => this.db.batch(chunk));
    }
    return { written: diff.written, unchanged: diff.unchanged };
  }

  async queryDaySummary(date) {
    const points = await this.run(() => this.db.prepare(POINTS_FOR_DATE).bind(date).all());
    const workouts = await this.run(() => this.db.prepare(WORKOUTS_FOR_DATE).bind(date).all());
    const hint = await this.readExportHint();
    return withExportHint(summarizeDay(date, points.results, workouts.results), hint);
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
