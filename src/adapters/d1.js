import { shouldStoreRaw } from "../core/aggregate.js";
import { D1DailyLimitError, d1DailyLimitKind } from "../core/free-tier.js";
import { countNewDays, dateGroups, hintAction, MAX_INGEST_DATES, normalizeBackfill, partitionIngest, withExportHint } from "../core/ingest-guard.js";
import { summarizeDay } from "../core/summary.js";
import { jsonChunks, pointJson, workoutJson } from "./bulk.js";
import {
  D1_BATCH_LIMIT,
  CLOSE_BACKFILL,
  DELETE_EMPTY_BACKFILL,
  DELETE_HINT,
  FINISH_BACKFILL,
  HAS_STORED_DATA,
  INSERT_RAW,
  INSERT_WORKOUTS_JSON,
  LIST_METRICS,
  METRIC_RANGE,
  POINTS_FOR_DATE,
  POINTS_ON_DATES,
  READ_BACKFILL,
  READ_HINT,
  RELEASE_BACKFILL,
  REPLACE_POINTS_JSON,
  RESERVE_BACKFILL,
  CLAIM_QUOTA,
  UPSERT_HINT,
  UPSERT_POINTS_JSON,
  UPSERT_WORKOUTS_JSON,
  WORKOUTS_FOR_DATE,
  WORKOUTS_ON_DATES,
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
    for (const group of dateGroups(dates, MAX_INGEST_DATES)) {
      const json = JSON.stringify(group);
      points.push(...await this.rowsFor(POINTS_ON_DATES, json));
      workouts.push(...await this.rowsFor(WORKOUTS_ON_DATES, json));
    }
    return { points, workouts };
  }

  async readIngestBackfill() {
    const rows = await this.rowsFor(READ_BACKFILL);
    return normalizeBackfill(rows[0]);
  }

  async hasStoredData() {
    const rows = await this.rowsFor(HAS_STORED_DATA);
    return rows.length > 0;
  }

  async countNewIngestDays(points, workouts) {
    const dates = [...new Set([...(points || []).map((point) => point.date), ...(workouts || []).map((workout) => workout.date)])];
    return countNewDays(points, workouts, await this.loadStored(dates));
  }

  async reserveIngestBackfill(args) {
    const addDays = await this.countNewIngestDays(args.points, args.workouts);
    const statement = this.db.prepare(RESERVE_BACKFILL).bind(
      args.openedAt,
      args.closeAt,
      args.addBytes,
      addDays,
      args.deadline,
      args.totalBytes,
      args.nowIso,
      args.nowIso,
    );
    const results = await this.run(() => this.db.batch([statement]));
    const reserved = normalizeBackfill(results?.[0]?.results?.[0]);
    if (!reserved) return null;
    try {
      if (args.write) await args.write();
    } catch (error) {
      const release = this.db.prepare(RELEASE_BACKFILL).bind(
        args.addBytes,
        addDays,
        addDays,
        reserved.closed_at,
        args.addBytes,
      );
      const clear = this.db.prepare(DELETE_EMPTY_BACKFILL).bind();
      await this.run(() => this.db.batch([release, clear]));
      throw error;
    }
    return reserved;
  }

  async finishIngestBackfill({ openedAt, closedAt, addBytes = 0, addDays = 0, deadline, totalBytes = 0 }) {
    const statement = this.db.prepare(FINISH_BACKFILL).bind(
      openedAt,
      closedAt,
      addBytes,
      addDays,
      deadline || closedAt,
      totalBytes,
    );
    const results = await this.run(() => this.db.batch([statement]));
    return normalizeBackfill(results?.[0]?.results?.[0]) || this.readIngestBackfill();
  }

  async closeIngestBackfill(closedAt) {
    const statement = this.db.prepare(CLOSE_BACKFILL).bind(closedAt);
    const results = await this.run(() => this.db.batch([statement]));
    return normalizeBackfill(results?.[0]?.results?.[0]) || this.readIngestBackfill();
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
    const stored = await this.loadStored(dates);
    const diff = partitionIngest(batch.points, batch.workouts, stored);
    const newDays = countNewDays(batch.points, batch.workouts, stored);
    const statements = [];
    if (shouldStoreRaw(batch)) {
      statements.push(this.db.prepare(INSERT_RAW).bind(batch.id, batch.date, batch.receivedAt, batch.bytes, batch.payload));
    }
    const replacePoints = diff.points.filter((point) => point.replace);
    const guardPoints = diff.points.filter((point) => !point.replace);
    for (const chunk of jsonChunks(replacePoints.map(pointJson))) {
      statements.push(this.db.prepare(REPLACE_POINTS_JSON).bind(chunk));
    }
    for (const chunk of jsonChunks(guardPoints.map(pointJson))) {
      statements.push(this.db.prepare(UPSERT_POINTS_JSON).bind(chunk));
    }
    const insertOnly = diff.workouts.filter((workout) => workout.insertOnly);
    const upserts = diff.workouts.filter((workout) => !workout.insertOnly);
    for (const chunk of jsonChunks(insertOnly.map(workoutJson))) {
      statements.push(this.db.prepare(INSERT_WORKOUTS_JSON).bind(chunk));
    }
    for (const chunk of jsonChunks(upserts.map(workoutJson))) {
      statements.push(this.db.prepare(UPSERT_WORKOUTS_JSON).bind(chunk));
    }
    const action = hintAction(options.hint === undefined ? null : await this.readExportHint(), options.hint);
    if (action === "clear") statements.push(this.db.prepare(DELETE_HINT).bind());
    if (action === "set") statements.push(this.db.prepare(UPSERT_HINT).bind(options.hint));
    for (let i = 0; i < statements.length; i += D1_BATCH_LIMIT) {
      const chunk = statements.slice(i, i + D1_BATCH_LIMIT);
      if (chunk.length) await this.run(() => this.db.batch(chunk));
    }
    return { written: diff.written, unchanged: diff.unchanged, newDays };
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
