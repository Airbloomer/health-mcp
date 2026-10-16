import path from "node:path";
import { pathToFileURL } from "node:url";
import { createNodeStorage } from "../adapters/node.js";
import { DEFAULT_TIME_ZONE } from "../core/metrics.js";
import {
  applyPlanToPostgres,
  applyPlanToSqlite,
  listSqliteWorkouts,
  planWorkoutStarts,
  renderWorkoutStartSql,
  WORKOUT_STARTS_MIGRATION_ID,
} from "../core/workout-start-migration.js";

/**
 * Owner-gated backfill. This does not run at startup and is not a deploy step.
 * D1: print SQL for `wrangler d1 execute <db> --remote --file` and do not connect.
 */
export async function migrateWorkoutStarts(env = process.env, out = console) {
  const timeZone = env.HEALTH_TIMEZONE || DEFAULT_TIME_ZONE;
  if (env.HEALTH_MCP_D1 === "render") {
    const rows = JSON.parse(env.HEALTH_MCP_D1_ROWS || "[]");
    const plan = planWorkoutStarts(rows, timeZone);
    out.log(renderWorkoutStartSql(plan.actions, new Date().toISOString()));
    return { id: WORKOUT_STARTS_MIGRATION_ID, unparseable: plan.unparseable, rendered: true };
  }
  const storage = await createNodeStorage(env);
  try {
    if (storage.raw) {
      const plan = planWorkoutStarts(listSqliteWorkouts(storage.raw), timeZone);
      applyPlanToSqlite(storage.raw, plan.actions);
      return { id: WORKOUT_STARTS_MIGRATION_ID, unparseable: plan.unparseable, groups: plan.actions.length };
    }
    const pool = storage.pool;
    if (!pool) throw new Error("workout start backfill needs SQLite or Postgres storage");
    const listed = await pool.query("SELECT name, start, date, duration_min, kcal, writer FROM workouts");
    const plan = planWorkoutStarts(listed.rows, timeZone);
    await applyPlanToPostgres(pool, plan.actions);
    return { id: WORKOUT_STARTS_MIGRATION_ID, unparseable: plan.unparseable, groups: plan.actions.length };
  } finally {
    await storage.close?.();
  }
}

function isMainModule() {
  const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
  return entry === import.meta.url;
}

if (isMainModule()) {
  try {
    const result = await migrateWorkoutStarts(process.env);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
