import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { shouldStoreRaw } from "../core/aggregate.js";
import { countNewDays, dateGroups, hintAction, MAX_INGEST_DATES, normalizeBackfill, partitionIngest, withExportHint } from "../core/ingest-guard.js";
import { summarizeDay } from "../core/summary.js";
import { jsonChunks, pointJson, workoutJson } from "./bulk.js";
import { migrationFiles } from "./migrate.js";
import { splitStatements, INSERT_RAW, LIST_METRICS, METRIC_RANGE, POINTS_FOR_DATE, POINTS_ON_DATES,
  UPSERT_POINTS_JSON, REPLACE_POINTS_JSON, UPSERT_WORKOUTS_JSON, INSERT_WORKOUTS_JSON,
  WORKOUTS_FOR_DATE, WORKOUTS_ON_DATES, WORKOUTS_RANGE, CLAIM_QUOTA, READ_HINT, UPSERT_HINT, DELETE_HINT,
  READ_BACKFILL, RESERVE_BACKFILL, RELEASE_BACKFILL, DELETE_EMPTY_BACKFILL, FINISH_BACKFILL, CLOSE_BACKFILL, HAS_STORED_DATA } from "./statements.js";

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
  const reserveBackfill = db.prepare(RESERVE_BACKFILL);
  const finishBackfill = db.prepare(FINISH_BACKFILL);
  const closeBackfill = db.prepare(CLOSE_BACKFILL);
  const hasStored = db.prepare(HAS_STORED_DATA);
  const pointsOnDates = db.prepare(POINTS_ON_DATES);
  const workoutsOnDates = db.prepare(WORKOUTS_ON_DATES);
  const releaseBackfill = db.prepare(RELEASE_BACKFILL);
  const deleteEmptyBackfill = db.prepare(DELETE_EMPTY_BACKFILL);
  const upsertPointsJson = db.prepare(UPSERT_POINTS_JSON);
  const replacePointsJson = db.prepare(REPLACE_POINTS_JSON);
  const upsertWorkoutsJson = db.prepare(UPSERT_WORKOUTS_JSON);
  const insertWorkoutsJson = db.prepare(INSERT_WORKOUTS_JSON);
  const loadSpan = (dates) => {
    const points = [];
    const workouts = [];
    for (const group of dateGroups(dates, MAX_INGEST_DATES)) {
      const json = JSON.stringify(group);
      points.push(...pointsOnDates.all(json));
      workouts.push(...workoutsOnDates.all(json));
    }
    return { points, workouts };
  };
  const insertAll = db.transaction((batch, options = {}) => {
    const dates = [...new Set([...(batch.points || []).map((point) => point.date), ...(batch.workouts || []).map((workout) => workout.date)])];
    const stored = loadSpan(dates);
    const diff = partitionIngest(batch.points, batch.workouts, stored);
    const newDays = countNewDays(batch.points, batch.workouts, stored);
    if (shouldStoreRaw(batch)) {
      insertRaw.run(batch.id, batch.date, batch.receivedAt, batch.bytes, batch.payload);
    }
    const replacePoints = diff.points.filter((point) => point.replace);
    const guardPoints = diff.points.filter((point) => !point.replace);
    for (const chunk of jsonChunks(replacePoints.map(pointJson))) replacePointsJson.run(chunk);
    for (const chunk of jsonChunks(guardPoints.map(pointJson))) upsertPointsJson.run(chunk);
    const insertOnly = diff.workouts.filter((workout) => workout.insertOnly);
    const upserts = diff.workouts.filter((workout) => !workout.insertOnly);
    for (const chunk of jsonChunks(insertOnly.map(workoutJson))) insertWorkoutsJson.run(chunk);
    for (const chunk of jsonChunks(upserts.map(workoutJson))) upsertWorkoutsJson.run(chunk);
    const action = hintAction(options.hint === undefined ? null : (readHint.get()?.hint ?? null), options.hint);
    if (action === "clear") deleteHint.run();
    if (action === "set") upsertHint.run(options.hint);
    return { written: diff.written, unchanged: diff.unchanged, newDays };
  });

  return {
    async readIngestBackfill() {
      return normalizeBackfill(readBackfill.get());
    },
    async hasStoredData() {
      return Boolean(hasStored.get());
    },
    async countNewIngestDays(points, workouts) {
      const dates = [...new Set([...(points || []).map((point) => point.date), ...(workouts || []).map((workout) => workout.date)])];
      return countNewDays(points, workouts, loadSpan(dates));
    },
    async reserveIngestBackfill(args) {
      const addDays = await this.countNewIngestDays(args.points, args.workouts);
      const row = reserveBackfill.get(
        args.openedAt,
        args.closeAt,
        args.addBytes,
        addDays,
        args.deadline,
        args.totalBytes,
        args.nowIso,
        args.nowIso,
      );
      const reserved = normalizeBackfill(row);
      if (!reserved) return null;
      try {
        if (args.write) await args.write();
      } catch (error) {
        releaseBackfill.run(args.addBytes, addDays, addDays, reserved.closed_at, args.addBytes);
        deleteEmptyBackfill.run();
        throw error;
      }
      return reserved;
    },
    async finishIngestBackfill({ openedAt, closedAt, addBytes = 0, addDays = 0, deadline, totalBytes = 0 }) {
      const row = finishBackfill.get(openedAt, closedAt, addBytes, addDays, deadline || closedAt, totalBytes);
      return normalizeBackfill(row) || this.readIngestBackfill();
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
