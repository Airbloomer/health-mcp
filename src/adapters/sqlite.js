import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { shouldStoreRaw } from "../core/aggregate.js";
import { shiftIsoDate, workoutsForRange } from "../core/dedupe-workouts.js";
import { isMissingWriterError } from "../core/limits.js";
import { DEFAULT_TIME_ZONE } from "../core/metrics.js";
import { summarizeDay } from "../core/summary.js";
import { migrationFiles } from "./migrate.js";
import { splitStatements, INSERT_RAW, LIST_METRICS, METRIC_RANGE, POINTS_FOR_DATE, UPSERT_POINT,
  REPLACE_POINT, UPSERT_WORKOUT, INSERT_WORKOUT_IF_NEW, WORKOUTS_RANGE, WORKOUTS_RANGE_LEGACY } from "./statements.js";

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

function sqliteHasWriter(db) {
  try {
    db.prepare("SELECT writer FROM workouts LIMIT 0").get();
    return true;
  } catch (error) {
    if (isMissingWriterError(error)) return false;
    throw error;
  }
}

export function createSqliteStorage(filename, options = {}) {
  let db = options.database;
  if (!db) {
    if (filename !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
    db = new Database(filename);
    if (filename !== ":memory:") db.pragma("journal_mode = WAL");
  }
  db.pragma("busy_timeout = 5000");
  if (options.migrate !== false) applySqliteMigrations(db);
  const timeZone = options.timeZone || DEFAULT_TIME_ZONE;
  const hasWriter = sqliteHasWriter(db);

  const insertRaw = db.prepare(INSERT_RAW);
  const upsertPoint = db.prepare(UPSERT_POINT);
  const replacePoint = db.prepare(REPLACE_POINT);
  const upsertWorkout = hasWriter ? db.prepare(UPSERT_WORKOUT) : null;
  const insertWorkout = hasWriter ? db.prepare(INSERT_WORKOUT_IF_NEW) : null;
  const pointsForDate = db.prepare(POINTS_FOR_DATE);
  const metricRange = db.prepare(METRIC_RANGE);
  const metricsStmt = db.prepare(LIST_METRICS);
  const workoutsRange = db.prepare(hasWriter ? WORKOUTS_RANGE : WORKOUTS_RANGE_LEGACY);
  const insertAll = db.transaction((batch) => {
    if (!hasWriter) throw new Error("table workouts has no column named writer");
    if (shouldStoreRaw(batch)) {
      insertRaw.run(batch.id, batch.date, batch.receivedAt, batch.bytes, batch.payload);
    }
    for (const point of batch.points) {
      (point.replace ? replacePoint : upsertPoint).run(point.date, point.metric, point.sum_qty, point.last_qty, point.last_ts, point.units, point.n);
    }
    for (const workout of batch.workouts) {
      const writer = workout.writer === "url" ? "url" : "bearer";
      (workout.insertOnly ? insertWorkout : upsertWorkout).run(workout.name, workout.start, workout.date, workout.duration_min, workout.kcal, writer);
    }
  });

  function readWorkouts(startDate, endDate) {
    return workoutsRange.all(shiftIsoDate(startDate, -1), shiftIsoDate(endDate, 1)).map((row) => ({ ...row, writer: row.writer ?? null }));
  }

  return {
    async insertIngest(batch) {
      insertAll(batch);
    },
    async queryDaySummary(date) {
      return summarizeDay(date, pointsForDate.all(date), workoutsForRange(readWorkouts(date, date), date, date, timeZone));
    },
    async queryMetricRange(metric, startDate, endDate) {
      return metricRange.all(metric, startDate, endDate);
    },
    async listMetrics() {
      return metricsStmt.all().map((row) => row.metric);
    },
    async listWorkouts(startDate, endDate) {
      return workoutsForRange(readWorkouts(startDate, endDate), startDate, endDate, timeZone);
    },
    raw: db,
    async close() {
      db.close();
    },
  };
}
