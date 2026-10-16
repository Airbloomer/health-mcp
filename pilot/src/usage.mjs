import { USAGE_CSV_COLUMNS } from "./constants.mjs";

export { USAGE_CSV_COLUMNS };

/**
 * Workers and D1 analytics query.
 * Variable scalars use Cloudflare's lowercase `string` plus `Time` and `Date`.
 * `cpu` is `sum { cpuTimeUs }` because a percentile is not additive.
 * One D1 database id per query (`databaseId: $dbId`).
 */
export const USAGE_QUERY = `query (
  $acct: string!,
  $from: Time!,
  $to: Time!,
  $fromDate: Date!,
  $toDate: Date!,
  $dbId: string!
) {
  viewer {
    accounts(filter: { accountTag: $acct }) {
      workers: workersInvocationsAdaptive(
        limit: 1000
        orderBy: [scriptName_ASC]
        filter: { datetime_geq: $from, datetime_lt: $to, scriptName_like: "hmcp-pilot-%" }
      ) {
        dimensions { scriptName }
        sum { requests errors subrequests cpuTimeUs }
      }
      d1: d1AnalyticsAdaptiveGroups(
        limit: 1000
        filter: { date_geq: $fromDate, date_leq: $toDate, databaseId: $dbId }
      ) {
        dimensions { databaseId }
        sum { readQueries writeQueries rowsRead rowsWritten }
      }
    }
  }
}`;

/** Confirmed only by authenticated introspection before either is added to USAGE_QUERY. */
export const USAGE_INTROSPECTION_TODO = [
  "TODO: verify databaseId_in by authenticated introspection. Docs show databaseId equality, so query one database id at a time until _in is confirmed.",
  "TODO: verify the d1StorageAdaptiveGroups max aggregate block by authenticated introspection before selecting storage bytes. Do not hardcode that block.",
];

export const USAGE_PAGINATION_NOTE =
  "limit 1000 is enough for the 2-tenant pilot. If a window returns 1000 groups, split the window and query again. Add orderBy on D1 after introspection.";

export const USAGE_CRONS = ["30 0 1 * *", "30 0 16 * *"];

export const DAY_OWNERSHIP =
  "Days 1-15 come from the day-16 pull. Days 16 through the end of the month come from the day-1 run.";

export const REPORTING_CADENCE = {
  dayOfMonth: 1,
  crons: USAGE_CRONS,
  ownership: DAY_OWNERSHIP,
  reason:
    "D1 metrics are kept 31 days. The day-16 pull records days 1-15. The day-1 run records days 16 through the end of the month. Merge keeps only the owning pull, so the retention boundary does not choose the row.",
};

/** Day-of-month owner. Days 1-15 belong to the day-16 pull. Days 16-31 belong to the day-1 run. */
export function owningPull(dayOfMonth) {
  const day = Number(dayOfMonth);
  if (!Number.isInteger(day) || day < 1 || day > 31) {
    throw new Error(`day ${dayOfMonth} is outside 1..31`);
  }
  return day <= 15 ? "day-16" : "day-1";
}

/**
 * Keep each calendar day only from the pull that owns it.
 * A value from the other pull is ignored, whether retention still has it or has already dropped it.
 */
export function mergeOwnedDays(records) {
  const chosen = new Map();
  for (const record of records) {
    if (owningPull(record.day) !== record.pull) continue;
    chosen.set(record.day, record);
  }
  return [...chosen.keys()].sort((a, b) => a - b).map((day) => chosen.get(day));
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

export function previousMonth(now = new Date()) {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
}

export function monthBounds(year, month) {
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  const last = new Date(end.getTime() - 86_400_000);
  return {
    from: start.toISOString(),
    to: end.toISOString(),
    fromDate: isoDate(start),
    toDate: isoDate(last),
  };
}

/** Workers adaptive queries are chunked by day because a month can exceed the per-query range. */
export function eachUtcDay(fromIso, toIso) {
  const windows = [];
  let cursor = new Date(fromIso);
  const end = new Date(toIso);
  while (cursor < end) {
    const next = new Date(cursor.getTime() + 86_400_000);
    windows.push({ from: cursor.toISOString(), to: (next < end ? next : end).toISOString() });
    cursor = next;
  }
  return windows;
}

export function buildUsagePlan({ year, month, databaseIds }) {
  const bounds = monthBounds(year, month);
  return {
    cadence: REPORTING_CADENCE,
    csv_columns: USAGE_CSV_COLUMNS,
    pagination: USAGE_PAGINATION_NOTE,
    introspection_todo: USAGE_INTROSPECTION_TODO,
    storage_bytes: null,
    workers: eachUtcDay(bounds.from, bounds.to).map((window) => ({
      query: "workersInvocationsAdaptive",
      ...window,
      scriptName_like: "hmcp-pilot-%",
      cpu_field: "sum.cpuTimeUs",
    })),
    d1: databaseIds.map((databaseId) => ({
      query: "d1AnalyticsAdaptiveGroups",
      databaseId,
      fromDate: bounds.fromDate,
      toDate: bounds.toDate,
    })),
  };
}

export function usageRows({ month, workers = [], d1 = [] }) {
  const rows = [];
  for (const item of workers) {
    rows.push({
      month,
      resource: item.scriptName,
      requests: item.requests ?? 0,
      cpu: item.cpuTimeUs ?? 0,
      d1_rows_read: "",
      d1_rows_written: "",
      storage_bytes: "",
    });
  }
  for (const item of d1) {
    rows.push({
      month,
      resource: item.databaseId,
      requests: "",
      cpu: "",
      d1_rows_read: item.rowsRead ?? 0,
      d1_rows_written: item.rowsWritten ?? 0,
      storage_bytes: "",
    });
  }
  return rows;
}

export function toCsv(rows) {
  const header = USAGE_CSV_COLUMNS.join(",");
  const lines = rows.map((row) => USAGE_CSV_COLUMNS.map((key) => {
    if (!Object.prototype.hasOwnProperty.call(row, key)) {
      throw new Error(`missing csv column ${key}`);
    }
    return String(row[key] ?? "");
  }).join(","));
  return [header, ...lines].join("\n") + "\n";
}

export function assertCsvColumns(text) {
  const header = String(text).split(/\n/)[0].trim();
  if (header !== USAGE_CSV_COLUMNS.join(",")) {
    throw new Error("usage csv columns do not match the allowlist");
  }
}
