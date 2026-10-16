import Database from "better-sqlite3";
import pg from "pg";
import { D1Storage } from "../src/adapters/d1.js";
import { migrationFiles } from "../src/adapters/migrate.js";
import { createPostgresStorageFromPool } from "../src/adapters/postgres.js";
import { applySqliteMigrations, createSqliteStorage } from "../src/adapters/sqlite.js";
import { splitStatements } from "../src/adapters/statements.js";
import { MemoryStorage } from "../src/core/memory.js";

const { Client, Pool } = pg;

export function d1FromSqlite(db) {
  function statement(sql, params = []) {
    return {
      sql,
      params,
      bind(...next) {
        return statement(sql, next);
      },
      async all() {
        return { results: db.prepare(sql).all(...params) };
      },
      async run() {
        db.prepare(sql).run(...params);
        return { success: true };
      },
    };
  }
  return {
    prepare(sql) {
      return statement(sql);
    },
    async batch(statements) {
      db.transaction((list) => {
        for (const stmt of list) db.prepare(stmt.sql).run(...stmt.params);
      })(statements);
      return [];
    },
  };
}

function filesBeforeWriter() {
  return migrationFiles().filter((file) => file.id < "0003");
}

function execSqliteFiles(db, files) {
  for (const file of files) db.exec(file.sql);
}

async function execPostgresFiles(pool, files) {
  for (const file of files) {
    for (const statement of splitStatements(file.sql)) await pool.query(statement);
  }
}

export function openMemory(options = {}) {
  return { kind: "memory", storage: new MemoryStorage(options), raw: null, async close() {} };
}

export function openSqlite(options = {}) {
  const db = new Database(":memory:");
  const storage = createSqliteStorage(":memory:", { ...options, database: db });
  return { kind: "sqlite", storage, raw: db, async close() { db.close(); } };
}

export function openSqlitePre0003() {
  const db = new Database(":memory:");
  execSqliteFiles(db, filesBeforeWriter());
  const storage = createSqliteStorage(":memory:", { database: db, migrate: false });
  return { kind: "sqlite", storage, raw: db, async close() { db.close(); } };
}

export function openD1(options = {}) {
  const db = new Database(":memory:");
  applySqliteMigrations(db);
  const storage = new D1Storage(d1FromSqlite(db), options);
  return { kind: "d1", storage, raw: db, async close() { db.close(); } };
}

export function openD1Pre0003() {
  const db = new Database(":memory:");
  execSqliteFiles(db, filesBeforeWriter());
  const storage = new D1Storage(d1FromSqlite(db));
  return { kind: "d1", storage, raw: db, async close() { db.close(); } };
}

export async function openPostgres(options = {}) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    if (process.env.CI) throw new Error("DATABASE_URL is required in CI");
    console.log("skip postgres: DATABASE_URL is unset");
    return null;
  }
  const schema = `p${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString, connectionTimeoutMillis: 2000 });
  try {
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
  } catch (error) {
    try { await admin.end(); } catch { /* already closed */ }
    if (process.env.CI) throw error;
    console.log(`skip postgres: ${error.message}`);
    return null;
  }
  await admin.end();
  const pool = new Pool({ connectionString, max: 4, options: `-c search_path=${schema}` });
  const storage = createPostgresStorageFromPool(pool, options);
  if (options.migrate !== false) await storage.migrate();
  else await execPostgresFiles(pool, filesBeforeWriter());
  return {
    kind: "postgres",
    storage,
    raw: pool,
    async close() {
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await pool.end();
    },
  };
}

const FACTORIES = [
  ["memory", () => openMemory()],
  ["sqlite", () => openSqlite()],
  ["d1", () => openD1()],
  ["postgres", () => openPostgres()],
];

export async function eachBackend(fn) {
  for (const [name, open] of FACTORIES) {
    const backend = await open();
    if (!backend) continue;
    try {
      await fn(backend, name);
    } finally {
      await backend.close();
    }
  }
}

export async function pointOf(backend, date, metric) {
  if (backend.kind === "memory") return backend.storage.points.get(`${date}\0${metric}`) || null;
  if (backend.kind === "postgres") {
    const result = await backend.raw.query("SELECT * FROM points_daily WHERE date = $1 AND metric = $2", [date, metric]);
    return result.rows[0] || null;
  }
  return backend.raw.prepare("SELECT * FROM points_daily WHERE date = ? AND metric = ?").get(date, metric) || null;
}

export async function countRows(backend, table) {
  if (backend.kind === "memory") {
    if (table === "workouts") return backend.storage.workouts.size;
    return backend.storage.points.size;
  }
  if (backend.kind === "postgres") {
    const result = await backend.raw.query(`SELECT COUNT(*)::int AS n FROM ${table}`);
    return result.rows[0].n;
  }
  return backend.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
}

export async function seedWorkout(backend, row) {
  const writer = Object.hasOwn(row, "writer") ? row.writer : null;
  if (backend.kind === "memory") {
    backend.storage.workouts.set(`${row.name}\0${row.start}`, {
      name: row.name,
      start: row.start,
      date: row.date,
      duration_min: row.duration_min,
      kcal: row.kcal,
      writer,
    });
    return;
  }
  const params = [row.name, row.start, row.date, row.duration_min, row.kcal, writer];
  if (backend.kind === "postgres") {
    await backend.raw.query(
      "INSERT INTO workouts (name, start, date, duration_min, kcal, writer) VALUES ($1, $2, $3, $4, $5, $6)",
      params,
    );
    return;
  }
  backend.raw.prepare(
    "INSERT INTO workouts (name, start, date, duration_min, kcal, writer) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(...params);
}

export async function seedPoint(backend, row) {
  if (backend.kind === "memory") {
    backend.storage.points.set(`${row.date}\0${row.metric}`, row);
    return;
  }
  const params = [row.date, row.metric, row.sum_qty, row.last_qty, row.last_ts, row.units, row.n];
  if (backend.kind === "postgres") {
    await backend.raw.query(
      "INSERT INTO points_daily (date, metric, sum_qty, last_qty, last_ts, units, n) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      params,
    );
    return;
  }
  backend.raw.prepare(
    "INSERT INTO points_daily (date, metric, sum_qty, last_qty, last_ts, units, n) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(...params);
}
