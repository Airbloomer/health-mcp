/** Request limits for self-hosting. `free` is the smaller profile. `node` is the larger Node and Docker profile. */

export const FREE_MAX_BYTES = 262_144;
export const NODE_MAX_BYTES = 10_000_000;
export const OTHER_MAX_BYTES = 65_536;

export const FREE_MAX_URL_WORKOUTS = 40;
export const FREE_MAX_BEARER_WORKOUTS = 40;
export const FREE_MAX_STORED_ROWS = 40;
/** Raw input records accepted by one request on the free profile. */
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

/**
 * D1 daily row limits, matched as documented text rather than keywords.
 * Debug D1, List of D1_ERRORs:
 * https://developers.cloudflare.com/d1/observability/debug-d1/
 * The same sentences, without the trailing "See https://..." line, are in
 * https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/
 * Both reset at midnight UTC. Debug D1 may append
 * " See https://developers.cloudflare.com/d1/platform/limits/ for more details."
 */
export const D1_DAILY_ROW_WRITE_LIMIT =
  "Your account has exceeded D1's free tier daily row write limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.";
export const D1_DAILY_ROW_READ_LIMIT =
  "Your account has exceeded D1's free tier daily row read limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.";

const D1_DAILY_LIMIT_MESSAGES = [D1_DAILY_ROW_WRITE_LIMIT, D1_DAILY_ROW_READ_LIMIT];

function errorText(error) {
  const parts = [];
  let current = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (typeof current === "string") parts.push(current);
    else if (current.message) parts.push(String(current.message));
    current = current.cause;
  }
  return parts.join("\n");
}

export function isDailyWriteLimitError(error) {
  const text = errorText(error);
  return D1_DAILY_LIMIT_MESSAGES.some((message) => text.includes(message));
}

export function isMissingWriterError(error) {
  const text = `${error?.message || ""} ${error?.cause?.message || ""}`;
  return /writer/i.test(text) && /(no such column|no column|has no column|does not exist|unknown column)/i.test(text);
}
