/** Request limits. `free` is the Workers Free profile. `node` is self-hosted Node and Docker. */

export const FREE_MAX_BYTES = 262_144;
export const NODE_MAX_BYTES = 10_000_000;
export const OTHER_MAX_BYTES = 65_536;

export const FREE_MAX_URL_WORKOUTS = 40;
export const FREE_MAX_BEARER_WORKOUTS = 40;
export const FREE_MAX_STORED_ROWS = 40;
/** Routine 2-day HC sync upper bound (~600) plus 25%. Binding after the workerd measurement. */
export const FREE_MAX_INPUT_RECORDS = 750;

export const NODE_MAX_URL_WORKOUTS = 500;
export const NODE_MAX_BEARER_WORKOUTS = 5_000;
export const NODE_MAX_RECORDS_PER_ARRAY = 50_000;
export const NODE_MAX_RECORDS_TOTAL = 200_000;

/** Statements reserved for auth, reads, the ingest log, and a raw row. */
export const RESERVED_STATEMENTS = 8;
export const D1_QUERY_LIMIT = 50;

const PROFILES = {
  free: {
    profile: "free",
    maxBytes: FREE_MAX_BYTES,
    maxUrlWorkouts: FREE_MAX_URL_WORKOUTS,
    maxBearerWorkouts: FREE_MAX_BEARER_WORKOUTS,
    maxStoredRows: FREE_MAX_STORED_ROWS,
    maxInputRecords: FREE_MAX_INPUT_RECORDS,
    maxRecordsPerArray: FREE_MAX_INPUT_RECORDS,
    maxRecordsTotal: FREE_MAX_INPUT_RECORDS,
  },
  node: {
    profile: "node",
    maxBytes: NODE_MAX_BYTES,
    maxUrlWorkouts: NODE_MAX_URL_WORKOUTS,
    maxBearerWorkouts: NODE_MAX_BEARER_WORKOUTS,
    maxStoredRows: Infinity,
    maxInputRecords: NODE_MAX_RECORDS_TOTAL,
    maxRecordsPerArray: NODE_MAX_RECORDS_PER_ARRAY,
    maxRecordsTotal: NODE_MAX_RECORDS_TOTAL,
  },
};

/**
 * @param {unknown} value
 * @param {"cloudflare" | "node"} adapter
 */
export function resolveLimitsProfile(value, adapter) {
  const raw = value == null ? "" : String(value);
  if (raw === "") {
    return { profile: adapter === "node" ? "node" : "free", invalid: false, explicitNode: false };
  }
  if (raw === "free" || raw === "node") {
    return { profile: raw, invalid: false, explicitNode: raw === "node" && adapter === "cloudflare" };
  }
  return { profile: null, invalid: true, explicitNode: false };
}

export function limitsFor(profile) {
  return PROFILES[profile] || PROFILES.free;
}

export function workoutCap(limits, tokenClass) {
  return tokenClass === "url" ? limits.maxUrlWorkouts : limits.maxBearerWorkouts;
}

/** Seconds from `now` until the next 00:00 UTC. At least 1. */
export function secondsUntilUtcMidnight(now = new Date()) {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

export function isDailyWriteLimitError(error) {
  const text = `${error?.message || ""} ${error?.cause?.message || ""}`;
  return /daily/i.test(text) && /(limit|quota|exceed)/i.test(text);
}

export function isMissingWriterError(error) {
  const text = `${error?.message || ""} ${error?.cause?.message || ""}`;
  return /writer/i.test(text) && /(no such column|no column|has no column|does not exist|unknown column)/i.test(text);
}
