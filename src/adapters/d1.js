import { shouldStoreRaw } from "../core/aggregate.js";
import { D1DailyLimitError, d1DailyLimitKind } from "../core/free-tier.js";
import { countNewDays, dateGroups, hintAction, MAX_INGEST_DATES, normalizeBackfill, partitionIngest, resolveMaxStatements, withExportHint } from "../core/ingest-guard.js";
import { summarizeDay } from "../core/summary.js";
import { ingestWriteChunks } from "./bulk.js";
import { addedColumn, migrationFiles } from "./migrate.js";
import {
  D1_BATCH_LIMIT,
  CLOSE_BACKFILL,
  DELETE_EMPTY_BACKFILL,
  DELETE_HINT,
  FINISH_BACKFILL,
  APPLE_MARKER_ID,
  HAS_STORED_DATA,
  INGEST_MARKER_ID,
  INSERT_RAW,
  MARK_ORIGIN,
  READ_MARKER,
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
  SEAL_BACKFILL_IF_MISSING,
  CLAIM_QUOTA,
  splitStatements,
  UPSERT_HINT,
  UPSERT_POINTS_JSON,
  UPSERT_WORKOUTS_JSON,
  WORKOUTS_FOR_DATE,
  WORKOUTS_ON_DATES,
  WORKOUTS_RANGE,
} from "./statements.js";

/**
 * Cloudflare D1 adapter. `db` is the binding (`env.DB`).
 * Schema comes from `migrations/` via `node src/cli/d1-migrate.js`.
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

  /** D1 is the only adapter with a statement budget. The ceiling is 45. */
  statementLimit(configured) {
    return resolveMaxStatements(configured);
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
      // Release only this group's share. Never clear closed_at, and do not
      // delete a row this reservation closed.
      const release = this.db.prepare(RELEASE_BACKFILL).bind(
        args.addBytes,
        addDays,
        addDays,
        args.addBytes,
      );
      const statements = [release];
      if (!reserved.closed_at) statements.push(this.db.prepare(DELETE_EMPTY_BACKFILL).bind());
      await this.run(() => this.db.batch(statements));
      throw error;
    }
    return reserved;
  }

  async sealIngestBackfillIfMissing({ openedAt, closedAt, deadline, totalBytes = 0 }) {
    const statement = this.db.prepare(SEAL_BACKFILL_IF_MISSING).bind(openedAt, closedAt, 0, 0, deadline || closedAt, totalBytes);
    await this.run(() => this.db.batch([statement]));
    return this.readIngestBackfill();
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
    const chunks = ingestWriteChunks(diff.points, diff.workouts);
    const statements = [];
    if (options.markOrigin) {
      const markerId = options.markOrigin === "apple" ? APPLE_MARKER_ID : INGEST_MARKER_ID;
      const existing = await this.rowsFor(READ_MARKER, markerId);
      if (!existing.length) statements.push(this.db.prepare(MARK_ORIGIN).bind(markerId));
    }
    if (shouldStoreRaw(batch)) {
      statements.push(this.db.prepare(INSERT_RAW).bind(batch.id, batch.date, batch.receivedAt, batch.bytes, batch.payload));
    }
    for (const chunk of chunks.replacePoints) statements.push(this.db.prepare(REPLACE_POINTS_JSON).bind(chunk));
    for (const chunk of chunks.guardPoints) statements.push(this.db.prepare(UPSERT_POINTS_JSON).bind(chunk));
    for (const chunk of chunks.insertOnly) statements.push(this.db.prepare(INSERT_WORKOUTS_JSON).bind(chunk));
    for (const chunk of chunks.upserts) statements.push(this.db.prepare(UPSERT_WORKOUTS_JSON).bind(chunk));
    if (options.hint !== undefined) {
      await this.readExportHint();
      const hintWrite = options.hint === null
        ? this.db.prepare(DELETE_HINT).bind()
        : this.db.prepare(UPSERT_HINT).bind(options.hint);
      statements.push(hintWrite);
    }
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

/**
 * Apply migrations through a D1 binding. A file recorded in either
 * schema_migrations or d1_migrations is not run again; the missing table
 * receives a copy of that id. An ADD COLUMN whose name is already on the
 * table is skipped, so a database that applied an earlier copy of 0004 can
 * apply 0006. Returns the ids whose SQL ran.
 */
export async function applyD1Migrations(db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"),
  ]);
  const schemaRows = await db.prepare("SELECT id FROM schema_migrations").all();
  const wranglerRows = await db.prepare("SELECT name FROM d1_migrations").all();
  const schema = new Set((schemaRows?.results || []).map((row) => row.id));
  const wrangler = new Set((wranglerRows?.results || []).map((row) => row.name));
  const applied = [];
  const now = new Date().toISOString();
  for (const file of migrationFiles()) {
    const inSchema = schema.has(file.id);
    const inWrangler = wrangler.has(file.id);
    if (inSchema || inWrangler) {
      const copies = [];
      if (!inSchema) {
        copies.push(db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").bind(file.id, now));
        schema.add(file.id);
      }
      if (!inWrangler) {
        copies.push(db.prepare("INSERT INTO d1_migrations (name, applied_at) VALUES (?, ?)").bind(file.id, now));
        wrangler.add(file.id);
      }
      if (copies.length) await db.batch(copies);
      continue;
    }
    const statements = [];
    for (const statement of splitStatements(file.sql)) {
      const column = addedColumn(statement);
      if (column) {
        const info = await db.prepare(`PRAGMA table_info(${column.table})`).all();
        const columns = info?.results || [];
        if (columns.some((entry) => String(entry.name).toLowerCase() === column.name.toLowerCase())) continue;
      }
      statements.push(db.prepare(statement));
    }
    statements.push(db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").bind(file.id, now));
    statements.push(db.prepare("INSERT INTO d1_migrations (name, applied_at) VALUES (?, ?)").bind(file.id, now));
    if (statements.length) await db.batch(statements);
    schema.add(file.id);
    wrangler.add(file.id);
    applied.push(file.id);
  }
  return applied;
}
