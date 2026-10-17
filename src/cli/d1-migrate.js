import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { applyD1Migrations } from "../adapters/d1.js";

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

/** Replace `?` placeholders. The replacement is not scanned for further placeholders. */
export function bindSql(sql, params = []) {
  const parts = String(sql).split("?");
  if (parts.length !== params.length + 1) throw new Error("parameter count mismatch");
  let bound = parts[0];
  for (let index = 0; index < params.length; index += 1) {
    bound += sqlLiteral(params[index]) + parts[index + 1];
  }
  return bound;
}

function collectRows(node, rows) {
  if (Array.isArray(node)) {
    for (const item of node) collectRows(item, rows);
    return;
  }
  if (node == null || typeof node !== "object") return;
  if (node.success === false) throw new Error("wrangler command failed");
  if (Array.isArray(node.results)) {
    const nested = node.results.some((row) => row && typeof row === "object" && (Array.isArray(row.results) || Object.hasOwn(row, "success")));
    if (nested) collectRows(node.results, rows);
    else rows.push(...node.results);
    return;
  }
  if (Array.isArray(node.result)) collectRows(node.result, rows);
}

/**
 * Rows from `wrangler d1 execute --json`. A log prefix before the JSON is ignored.
 * Nested result objects are flattened. `success: false` throws.
 */
export function parseWranglerRows(text) {
  const source = String(text);
  const start = source.search(/[\[{]/);
  if (start < 0) throw new Error("wrangler returned no rows");
  const rows = [];
  collectRows(JSON.parse(source.slice(start)), rows);
  return rows;
}

function defaultRun(database, remote, sql) {
  return execFileSync("npx", [
    "wrangler",
    "d1",
    "execute",
    database,
    remote ? "--remote" : "--local",
    "--json",
    "--command",
    sql,
  ], { encoding: "utf8" });
}

/** D1 binding that runs each statement through `wrangler d1 execute`. */
export function createWranglerD1({ database = "health-mcp", remote = true, run = defaultRun } = {}) {
  if (!/^[A-Za-z0-9_-]+$/.test(database)) throw new Error("invalid database name");
  const execute = (sql) => parseWranglerRows(run(database, remote, sql));
  function statement(sql, params = []) {
    return {
      sql,
      params,
      bind(...next) {
        return statement(sql, next);
      },
      async all() {
        return { results: execute(bindSql(sql, params)) };
      },
    };
  }
  return {
    prepare(sql) {
      return statement(sql);
    },
    async batch(statements) {
      const out = [];
      for (const stmt of statements) out.push({ results: execute(bindSql(stmt.sql, stmt.params || [])) });
      return out;
    },
  };
}

function parseArgs(argv) {
  const options = { database: "health-mcp", remote: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--remote") options.remote = true;
    else if (arg === "--local") options.remote = false;
    else if (arg === "--database") options.database = argv[++index] || "";
    else throw new Error(`Unknown option ${arg}`);
  }
  return options;
}

function isMainModule() {
  const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
  return entry === import.meta.url;
}

if (isMainModule()) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const applied = await applyD1Migrations(createWranglerD1(options));
    for (const id of applied) console.log(id);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
