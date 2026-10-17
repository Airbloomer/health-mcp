import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { shouldStoreRaw } from "../core/aggregate.js";
import { countNewDays, hintAction, normalizeBackfill, partitionIngest, withExportHint } from "../core/ingest-guard.js";
import { summarizeDay } from "../core/summary.js";
import { migrationFiles } from "./migrate.js";
import { splitStatements, INSERT_RAW, LIST_METRICS, METRIC_RANGE, POINTS_FOR_DATE, UPSERT_POINT,
  REPLACE_POINT, UPSERT_WORKOUT, INSERT_WORKOUT_IF_NEW, WORKOUTS_FOR_DATE, WORKOUTS_RANGE,
  CLAIM_QUOTA, READ_HINT, UPSERT_HINT, DELETE_HINT, READ_BACKFILL, ADD_BACKFILL, CLOSE_BACKFILL } from "./statements.js";

export function applySqliteMigrations(db) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const applied = new Set(db.prepare("SELECT id FROM schema_migrations").all().map((row) => row.id));
  const mark = db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)");
  for (const file of migrationFiles()) {
    if (applied.has(file.id)) continue;
    const statements = splitStatements(file.sql);
    const apply = db.transaction(() => {
      for (const statement of statements) db.prepare(statement).run();
      mark.run(file.id, new Date().toISOString());
    });
    apply();
  }
}

export function createSqliteStorage(filename) {
  if (filename !== ":memory:") {
    fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
  }
  const db = new Database(filename);
  if (filename !== ":memory:") db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  applySqliteMigrations(db);

  const insertRaw = db.prepare(INSERT_RAW);
  const upsertPoint = db.prepare(UPSERT_POINT);
  const replacePoint = db.prepare(REPLACE_POINT);
  const upsertWorkout = db.prepare(UPSERT_WORKOUT);
  const insertWorkout = db.prepare(INSERT_WORKOUT_IF_NEW);
  const pointsForDate = db.prepare(POINTS_FOR_DATE);
  const workoutsForDate = db.prepare(WORKOUTS_FOR_DATE);
  const metricRange = db.prepare(METRIC_RANGE);
  const metricsStmt = db.prepare(LIST_METRICS);
  const workoutsRange = db.prepare(WORKOUTS_RANGE);
  const claimQuota = db.prepare(CLAIM_QUOTA);
  const readHint = db.prepare(READ_HINT);
  const upsertHint = db.prepare(UPSERT_HINT);
  const deleteHint = db.prepare(DELETE_HINT);
  const readBackfill = db.prepare(READ_BACKFILL);
  const addBackfill = db.prepare(ADD_BACKFILL);
  const closeBackfill = db.prepare(CLOSE_BACKFILL);
  const insertAll = db.transaction((batch, options = {}) => {
    const dates = [...new Set([...(batch.points || []).map((point) => point.date), ...(batch.workouts || []).map((workout) => workout.date)])];
    const stored = { points: [], workouts: [] };
    for (const date of dates) {
      stored.points.push(...pointsForDate.all(date));
      stored.workouts.push(...workoutsForDate.all(date));
    }
    const diff = partitionIngest(batch.points, batch.workouts, stored);
    const newDays = countNewDays(batch.points, batch.workouts, stored);
    if (shouldStoreRaw(batch)) {
      insertRaw.run(batch.id, batch.date, batch.receivedAt, batch.bytes, batch.payload);
    }
    for (const point of diff.points) {
      (point.replace ? replacePoint : upsertPoint).run(point.date, point.metric, point.sum_qty, point.last_qty, point.last_ts, point.units, point.n);
    }
    for (const workout of diff.workouts) {
      (workout.insertOnly ? insertWorkout : upsertWorkout).run(workout.name, workout.start, workout.date, workout.duration_min, workout.kcal);
    }
    const action = hintAction(options.hint === undefined ? null : (readHint.get()?.hint ?? null), options.hint);
    if (action === "clear") deleteHint.run();
    if (action === "set") upsertHint.run(options.hint);
    return { written: diff.written, unchanged: diff.unchanged, newDays };
  });

  return {
    async readIngestBackfill() {
      return normalizeBackfill(readBackfill.get());
    },
    async addIngestBackfill({ openedAt, closeAt = null, addBytes = 0, addDays = 0 }) {
      return normalizeBackfill(addBackfill.get(openedAt, closeAt, addBytes, addDays)) || this.readIngestBackfill();
    },
    async closeIngestBackfill(closedAt) {
      return normalizeBackfill(closeBackfill.get(closedAt)) || this.readIngestBackfill();
    },
    async claimIngestQuota(tokenKey, windowStart, limit) {
      const row = claimQuota.get(tokenKey, windowStart, limit);
      return row?.hits == null ? null : Number(row.hits);
    },
    async readExportHint() {
      return readHint.get()?.hint ?? null;
    },
    async setExportHint(hint) {
      const action = hintAction(readHint.get()?.hint ?? null, hint);
      if (action === "skip") return false;
      if (action === "clear") deleteHint.run();
      else upsertHint.run(hint);
      return true;
    },
    async insertIngest(batch, options) {
      return insertAll(batch, options);
    },
    async queryDaySummary(date) {
      return withExportHint(summarizeDay(date, pointsForDate.all(date), workoutsForDate.all(date)), readHint.get()?.hint ?? null);
    },
    async queryMetricRange(metric, startDate, endDate) {
      return metricRange.all(metric, startDate, endDate);
    },
    async listMetrics() {
      return metricsStmt.all().map((row) => row.metric);
    },
    async listWorkouts(startDate, endDate) {
      return workoutsRange.all(startDate, endDate);
    },
    async close() {
      db.close();
    },
  };
}
