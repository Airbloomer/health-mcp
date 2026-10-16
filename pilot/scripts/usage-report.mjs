import { USAGE_INTROSPECTION_TODO, buildUsagePlan, previousMonth } from "../src/usage.mjs";

if (process.argv.includes("--live")) {
  console.error("live analytics queries stay disabled until the introspection TODOs are resolved");
  process.exit(1);
}

const { year, month } = previousMonth();
const plan = buildUsagePlan({ year, month, databaseIds: [] });
console.log(JSON.stringify({
  year,
  month,
  dayOfMonth: plan.cadence.dayOfMonth,
  crons: plan.cadence.crons,
  ownership: plan.cadence.ownership,
  reason: plan.cadence.reason,
  worker_windows: plan.workers.length,
  introspection_todo: USAGE_INTROSPECTION_TODO,
  storage_bytes: plan.storage_bytes,
}, null, 2));
