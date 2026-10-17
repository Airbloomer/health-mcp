import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { applyD1Migrations } from "../adapters/d1.js";

const USAGE = "Usage: node src/cli/d1-migrate.js --remote|--local [--database name]";

/** Quote a bound value for a SQLite statement sent as text. */
export function sqlLiteral(value) {
  if (value == null) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("invalid parameter");
    return String(value);
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "boolean") return value ? "1" : "0";
  return `'${String(value).replaceAll("'", "''")}'`;
}

/**
 * Replace `?` placeholders. A `?` inside a quoted string or identifier is left
 * as text. The replacement is not scanned for further placeholders.
 */
export function bindSql(sql, params = []) {
  const source = String(sql);
  let out = "";
  let index = 0;
  let used = 0;
  while (index < source.length) {
    const ch = source[index];
    if (ch === "'" || ch === "\"") {
      let end = index + 1;
      while (end < source.length) {
        if (source[end] === ch) {
          if (source[end + 1] === ch) {
            end += 2;
            continue;
          }
          end += 1;
          break;
        }
        end += 1;
      }
      out += source.slice(index, end);
      index = end;
      continue;
    }
    if (ch === "?") {
      if (used >= params.length) throw new Error("parameter count mismatch");
      out += sqlLiteral(params[used]);
      used += 1;
      index += 1;
      continue;
    }
    out += ch;
    index += 1;
  }
  if (used !== params.length) throw new Error("parameter count mismatch");
  return out;
}

function collectRows(node, rows) {
  if (Array.isArray(node)) {
    for (const item of node) collectRows(item, rows);
    return;
  }
  if (node == null || typeof node !== "object") return;
  if (node.success === false || node.error) throw new Error("wrangler command failed");
  if (Array.isArray(node.results)) {
    const nested = node.results.some((row) => row && typeof row === "object" && (Array.isArray(row.results) || Object.hasOwn(row, "success") || row.error));
    if (nested) collectRows(node.results, rows);
    else rows.push(...node.results);
    return;
  }
  if (Array.isArray(node.result)) collectRows(node.result, rows);
}

function parseLastJson(text) {
  const source = String(text).replace(/\u001b\[[0-9;]*m/g, "");
  let parsed = null;
  for (let index = 0; index < source.length; index += 1) {
    const ch = source[index];
    if (ch !== "{" && ch !== "[") continue;
    try {
      const value = JSON.parse(source.slice(index));
      if (value && typeof value === "object") parsed = value;
    } catch {
      // A bracket in a log line is not the result payload.
    }
  }
  if (!parsed) throw new Error("wrangler returned no rows");
  return parsed;
}

/**
 * Rows from `wrangler d1 execute --json`. The last JSON array or object is the
 * payload, so bracketed log text before it is ignored. Nested result objects
 * are flattened. `success: false` or an `error` field throws.
 */
export function parseWranglerRows(text) {
  const rows = [];
  collectRows(parseLastJson(text), rows);
  return rows;
}

function defaultRun({ database, remote, sql, mode }) {
  const args = [
    "wrangler",
    "d1",
    "execute",
    database,
    remote ? "--remote" : "--local",
    "--json",
  ];
  let file = null;
  if (mode === "file") {
    file = path.join(os.tmpdir(), `d1-migrate-${process.pid}-${Date.now()}.sql`);
    fs.writeFileSync(file, sql);
    args.push("--file", file);
  } else {
    args.push("--command", sql);
  }
  try {
    return execFileSync("npx", args, { encoding: "utf8" });
  } finally {
    if (file) fs.rmSync(file, { force: true });
  }
}

/** D1 binding. A batch is one `wrangler d1 execute --file`. Reads use `--command`. */
export function createWranglerD1({ database = "health-mcp", remote, run = defaultRun } = {}) {
  if (remote !== true && remote !== false) throw new Error(USAGE);
  if (!/^[A-Za-z0-9_-]+$/.test(database)) throw new Error("invalid database name");
  const execute = (sql, mode) => parseWranglerRows(run({ database, remote, sql, mode }));
  function statement(sql, params = []) {
    return {
      sql,
      params,
      bind(...next) {
        return statement(sql, next);
      },
      async all() {
        return { results: execute(bindSql(sql, params), "command") };
      },
    };
  }
  return {
    prepare(sql) {
      return statement(sql);
    },
    async batch(statements) {
      const sql = statements.map((stmt) => `${bindSql(stmt.sql, stmt.params || [])};`).join("\n");
      if (!sql) return [];
      execute(sql, "file");
      return statements.map(() => ({ results: [] }));
    },
  };
}

/** `--remote` or `--local` is required. The database name defaults to health-mcp. */
export function parseMigrateArgs(argv) {
  const options = { database: "health-mcp", remote: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--remote" || arg === "--local") {
      if (options.remote != null) throw new Error(USAGE);
      options.remote = arg === "--remote";
    } else if (arg === "--database") options.database = argv[++index] || "";
    else throw new Error(USAGE);
  }
  if (options.remote == null) throw new Error(USAGE);
  if (!/^[A-Za-z0-9_-]+$/.test(options.database)) throw new Error("invalid database name");
  return options;
}

function isMainModule() {
  const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
  return entry === import.meta.url;
}

if (isMainModule()) {
  try {
    const options = parseMigrateArgs(process.argv.slice(2));
    const applied = await applyD1Migrations(createWranglerD1(options));
    for (const id of applied) console.log(id);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
