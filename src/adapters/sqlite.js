import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { shouldStoreRaw } from "../core/aggregate.js";
import { summarizeDay } from "../core/summary.js";
import { migrationFiles } from "./migrate.js";
import { splitStatements, INSERT_RAW, LIST_METRICS, METRIC_RANGE, POINTS_FOR_DATE, UPSERT_POINT,
  REPLACE_POINT, UPSERT_WORKOUT, WORKOUTS_FOR_DATE, WORKOUTS_RANGE } from "./statements.js";

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
  const pointsForDate = db.prepare(POINTS_FOR_DATE);
  const workoutsForDate = db.prepare(WORKOUTS_FOR_DATE);
  const metricRange = db.prepare(METRIC_RANGE);
  const metricsStmt = db.prepare(LIST_METRICS);
  const workoutsRange = db.prepare(WORKOUTS_RANGE);
  const insertAll = db.transaction((batch) => {
    if (shouldStoreRaw(batch)) {
      insertRaw.run(batch.id, batch.date, batch.receivedAt, batch.bytes, batch.payload);
    }
    for (const point of batch.points) {
      (point.replace ? replacePoint : upsertPoint).run(point.date, point.metric, point.sum_qty, point.last_qty, point.last_ts, point.units, point.n);
    }
    for (const workout of batch.workouts) {
      upsertWorkout.run(workout.name, workout.start, workout.date, workout.duration_min, workout.kcal);
    }
  });

  return {
    async insertIngest(batch) {
      insertAll(batch);
    },
    async queryDaySummary(date) {
      return summarizeDay(date, pointsForDate.all(date), workoutsForDate.all(date));
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
