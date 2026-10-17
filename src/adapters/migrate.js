import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { splitStatements } from "./statements.js";

const migrationsDir = fileURLToPath(new URL("../../migrations/", import.meta.url));

/** SQL files in `migrations/`, oldest first. Each file runs once. */
export function migrationFiles() {
  return fs
    .readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({
      id: name,
      sql: fs.readFileSync(path.join(migrationsDir, name), "utf8"),
    }));
}

export function migrationStatements() {
  return migrationFiles().flatMap((file) => splitStatements(file.sql));
}

/** Postgres accepts ADD COLUMN IF NOT EXISTS. SQLite does not, so only this path rewrites it. */
export function statementsForPostgres(sql) {
  return splitStatements(sql).map((statement) =>
    statement.replace(/\bADD\s+COLUMN\s+(?!IF\s+NOT\s+EXISTS\b)/i, "ADD COLUMN IF NOT EXISTS "),
  );
}

/** `ALTER TABLE ... ADD COLUMN name`, or null. Leading `--` comments are ignored. */
export function addedColumn(statement) {
  const body = statement.replace(/--[^\n]*/g, "").trim();
  const alter = body.match(/^ALTER\s+TABLE\s+([A-Za-z_][A-Za-z0-9_]*)\s+ADD\s+COLUMN\s+([A-Za-z_][A-Za-z0-9_]*)\b/i);
  if (!alter) return null;
  return { table: alter[1], name: alter[2] };
}

/**
 * Skip an ADD COLUMN whose name is already on the table. A database that
 * applied an older copy of 0004 already has deadline and total_bytes.
 */
export function statementsForSqlite(db, sql) {
  const runnable = [];
  for (const statement of splitStatements(sql)) {
    const added = addedColumn(statement);
    if (added) {
      const columns = db.prepare(`PRAGMA table_info(${added.table})`).all();
      if (columns.some((column) => String(column.name).toLowerCase() === added.name.toLowerCase())) continue;
    }
    runnable.push(statement);
  }
  return runnable;
}
