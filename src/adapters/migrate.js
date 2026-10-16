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
