import { canonicalStart } from "./health-connect.js";
import { DEFAULT_TIME_ZONE } from "./metrics.js";

/** Recorded in schema_migrations when the owner runs the backfill. Not applied at startup. */
export const WORKOUT_STARTS_MIGRATION_ID = "0004_workout_starts_js";

export const D1_BATCH_LIMIT = 500;

function num(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * Winner for one exact (name, canonical start) group.
 * Already-canonical start, then longest duration, then highest kcal, then smallest start string.
 */
export function compareMigrationWinner(a, b) {
  const aCanon = String(a.start) === a.canonical ? 0 : 1;
  const bCanon = String(b.start) === b.canonical ? 0 : 1;
  if (aCanon !== bCanon) return aCanon - bCanon;
  const aDur = num(a.duration_min);
  const bDur = num(b.duration_min);
  if (aDur !== bDur) return (bDur ?? -Infinity) - (aDur ?? -Infinity);
  const aKcal = num(a.kcal);
  const bKcal = num(b.kcal);
  if (aKcal !== bKcal) return (bKcal ?? -Infinity) - (aKcal ?? -Infinity);
  const aStart = String(a.start ?? "");
  const bStart = String(b.start ?? "");
  if (aStart < bStart) return -1;
  if (aStart > bStart) return 1;
  return 0;
}

/**
 * Plan only. Exact name, not the read-time type map. The winner keeps its stored date.
 * Unparseable starts are counted and left out of every group.
 */
export function planWorkoutStarts(rows, timeZone = DEFAULT_TIME_ZONE) {
  const groups = new Map();
  let unparseable = 0;
  for (const row of rows || []) {
    const canonical = canonicalStart(row.start, timeZone);
    if (!canonical) {
      unparseable += 1;
      continue;
    }
    const key = `${row.name}\0${canonical}`;
    const member = { ...row, canonical };
    const list = groups.get(key);
    if (list) list.push(member);
    else groups.set(key, [member]);
  }
  const actions = [];
  for (const members of groups.values()) {
    const ranked = [...members].sort(compareMigrationWinner);
    const winner = ranked[0];
    actions.push({
      deletes: ranked.slice(1).map((row) => ({ name: row.name, start: row.start })),
      update: String(winner.start) === winner.canonical
        ? null
        : { name: winner.name, start: winner.start, next: winner.canonical },
    });
  }
  return { actions, unparseable };
}

const DELETE_SQL = "DELETE FROM workouts WHERE name = ? AND start = ?";
const UPDATE_SQL = "UPDATE workouts SET start = ? WHERE name = ? AND start = ?";

export function actionStatements(actions) {
  const statements = [];
  for (const action of actions) {
    for (const row of action.deletes) statements.push({ sql: DELETE_SQL, params: [row.name, row.start] });
    if (action.update) {
      statements.push({ sql: UPDATE_SQL, params: [action.update.next, action.update.name, action.update.start] });
    }
  }
  return statements;
}

function sqlLiteral(value) {
  if (value == null) return "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

/** SQL text for a D1 file execute. Tests apply it with a local executor, never a live account. */
export function renderWorkoutStartSql(actions, appliedAt) {
  const lines = ["CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);"];
  for (const statement of actionStatements(actions)) {
    const params = statement.params.map(sqlLiteral);
    if (statement.sql.startsWith("DELETE")) {
      lines.push(`DELETE FROM workouts WHERE name = ${params[0]} AND start = ${params[1]};`);
    } else {
      lines.push(`UPDATE workouts SET start = ${params[0]} WHERE name = ${params[1]} AND start = ${params[2]};`);
    }
  }
  lines.push(
    `INSERT INTO schema_migrations (id, applied_at) VALUES (${sqlLiteral(WORKOUT_STARTS_MIGRATION_ID)}, ${sqlLiteral(appliedAt)}) ON CONFLICT(id) DO NOTHING;`,
  );
  return `${lines.join("\n")}\n`;
}

export function applyPlanToMemory(storage, actions) {
  for (const action of actions) {
    for (const row of action.deletes) storage.workouts.delete(`${row.name}\0${row.start}`);
    if (!action.update) continue;
    const key = `${action.update.name}\0${action.update.start}`;
    const current = storage.workouts.get(key);
    if (!current) continue;
    storage.workouts.delete(key);
    storage.workouts.set(`${action.update.name}\0${action.update.next}`, { ...current, start: action.update.next });
  }
}

export function applyPlanToSqlite(db, actions, appliedAt = new Date().toISOString()) {
  const statements = actionStatements(actions);
  const mark = () => {
    db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    db.prepare(
      "INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING",
    ).run(WORKOUT_STARTS_MIGRATION_ID, appliedAt);
  };
  const run = db.transaction(() => {
    for (const statement of statements) db.prepare(statement.sql).run(...statement.params);
    mark();
  });
  run();
}

export async function applyPlanToPostgres(pool, actions, appliedAt = new Date().toISOString()) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const statement of actionStatements(actions)) {
      let index = 0;
      const sql = statement.sql.replace(/\?/g, () => `$${++index}`);
      await client.query(sql, statement.params);
    }
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    await client.query(
      "INSERT INTO schema_migrations (id, applied_at) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
      [WORKOUT_STARTS_MIGRATION_ID, appliedAt],
    );
    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The connection may already be unusable.
    }
    throw error;
  } finally {
    client.release();
  }
}

/** D1 batches stay at or under D1_BATCH_LIMIT statements, and a group is not split across batches. */
export function d1Batches(actions, appliedAt = new Date().toISOString()) {
  const batches = [];
  let current = [];
  const flush = () => {
    if (current.length) batches.push(current);
    current = [];
  };
  for (const action of actions) {
    const group = actionStatements([action]);
    if (current.length && current.length + group.length > D1_BATCH_LIMIT) flush();
    if (group.length > D1_BATCH_LIMIT) {
      flush();
      for (let index = 0; index < group.length; index += D1_BATCH_LIMIT) {
        batches.push(group.slice(index, index + D1_BATCH_LIMIT));
      }
      continue;
    }
    current.push(...group);
  }
  const mark = {
    sql: "INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING",
    params: [WORKOUT_STARTS_MIGRATION_ID, appliedAt],
  };
  const create = {
    sql: "CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
    params: [],
  };
  if (current.length + 2 > D1_BATCH_LIMIT) flush();
  current.push(create, mark);
  flush();
  return batches;
}

export function applyPlanToD1(db, actions, appliedAt) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  for (const batch of d1Batches(actions, appliedAt)) {
    db.transaction((statements) => {
      for (const statement of statements) {
        if (statement.sql.startsWith("CREATE TABLE")) db.exec(statement.sql);
        else db.prepare(statement.sql).run(...statement.params);
      }
    })(batch);
  }
}

export function listSqliteWorkouts(db) {
  return db.prepare("SELECT name, start, date, duration_min, kcal, writer FROM workouts").all();
}
