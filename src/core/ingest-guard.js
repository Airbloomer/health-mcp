import { ingestWriteChunks } from "./bulk.js";
import { localDate } from "./parse.js";
import { MAX_PAYLOAD_CHARS } from "./metrics.js";

/** Today and yesterday in the configured timezone. */
export const DEFAULT_INGEST_MAX_AGE_DAYS = 1;

/** About 100 years. Larger values make the calendar cutoff invalid. */
export const MAX_INGEST_MAX_AGE_DAYS = 36500;

/** JSON ingest bodies larger than this are rejected. Apple Health import is separate. */
export const DEFAULT_INGEST_MAX_BODY_BYTES = 1_000_000;

/** Accepted posts per token per UTC hour. Zero disables the limit. */
export const DEFAULT_INGEST_RATE_PER_HOUR = 6;

/** Per-request cap while the initial import window is open. */
export const DEFAULT_INGEST_BACKFILL_MAX_BYTES = 5_000_000;

/** Hard upper bound for the per-request import cap. */
export const MAX_INGEST_BACKFILL_MAX_BYTES = 10_000_000;

/** Distinct dates allowed in one ingest request, and in one stored batch. */
export const MAX_INGEST_DATES = 366;

/** Unique sorted dates, sliced so each group stays within `size`. */
export function dateGroups(dates, size = MAX_INGEST_DATES) {
  const unique = [...new Set(dates)].filter((date) => date != null && date !== "").sort();
  const groups = [];
  for (let index = 0; index < unique.length; index += size) groups.push(unique.slice(index, index + size));
  return groups;
}

/** Earliest calendar date an import may store. */
export const DEFAULT_INGEST_MIN_DATE = "2000-01-01";

/** Lowest calendar date a configured minimum may name. */
export const INGEST_MIN_DATE_FLOOR = "1970-01-01";

/**
 * Close time written for a database that already had rows. Public responses
 * report this as null.
 */
const SEEDED_CLOSE_AT = "1970-01-01T00:00:00.000Z";

/** Accepted posts per token per UTC hour while the initial import window is open. */
export const DEFAULT_INGEST_BACKFILL_MAX_PER_HOUR = 60;

/** Upper bound for a malformed import-window hourly cap. */
export const MAX_INGEST_BACKFILL_MAX_PER_HOUR = 10_000;

/** Total accepted body bytes for the whole initial import window. */
export const DEFAULT_INGEST_BACKFILL_MAX_TOTAL_BYTES = 500_000_000;

/** Upper bound for a malformed import-window total. */
export const MAX_INGEST_BACKFILL_MAX_TOTAL_BYTES = 5_000_000_000;

/** How long the initial import window stays open after the first accepted ingest. */
export const DEFAULT_INGEST_BACKFILL_HOURS = 72;

/** About a year. Longer values are clamped. */
export const MAX_INGEST_BACKFILL_HOURS = 24 * 366;

/**
 * D1 allows 50 statements in one request. A successful request stays at or
 * under 45. A failed charged write can add a release and an empty-row delete,
 * which is 47 and leaves a margin of 3. Configuration can only lower the
 * ceiling. SQLite, Postgres, and memory have no budget.
 */
export const D1_STATEMENT_BUDGET = 45;

/** Large Apple exports are split by this command. The Health export has no date range. */
export const APPLE_CHUNK_COMMAND = "node src/cli/import-apple-health.js --chunk-url";

export const DEFAULT_INGEST_MAX_STATEMENTS = D1_STATEMENT_BUDGET;

/** Lock timeout (55P03) and statement timeout (57014) can be retried. */
export function retryableDatabaseError(error) {
  const code = error?.code;
  return code === "55P03" || code === "57014";
}

export const INITIAL_IMPORT_CLOSED = "The initial import window is closed.";

export function byteLabel(maxBytes) {
  const bytes = resolveBackfillMaxBytes(maxBytes);
  if (bytes % 1_000_000 === 0) return `${bytes / 1_000_000} MB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${bytes} bytes`;
}

export function chunkHint(maxBytes) {
  return `Import history in chunks of ${byteLabel(maxBytes)} or less.`;
}

export function shorterDateRange(maxBytes) {
  return `Send a shorter date range. ${chunkHint(maxBytes)}`;
}

export function exportHint(maxBytes) {
  return `This export looks misconfigured: it sent too much history or it is posting too often. ${chunkHint(maxBytes)} Follow Recommended export settings in the README.`;
}

export const CHUNK_HINT = chunkHint();

export const SHORTER_DATE_RANGE = shorterDateRange();

/** A payload that drops at least this many dated records looks like a full history. */
export const STALE_HINT_AT = 50;

/** Dates after today plus this many days are dropped. Covers timezone and device skew. */
export const FUTURE_SKEW_DAYS = 1;

export const EXPORT_HINT = exportHint();

function configuredInteger(value) {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isInteger(Number(value.trim()))) {
    return Number(value.trim());
  }
  return null;
}

export function resolveMaxAgeDays(value) {
  const parsed = configuredInteger(value);
  if (parsed == null || parsed < 0) return DEFAULT_INGEST_MAX_AGE_DAYS;
  return Math.min(parsed, MAX_INGEST_MAX_AGE_DAYS);
}

export function resolveMaxBodyBytes(value) {
  const parsed = configuredInteger(value);
  if (parsed == null || parsed < 1) return DEFAULT_INGEST_MAX_BODY_BYTES;
  return Math.min(parsed, MAX_PAYLOAD_CHARS);
}

export function resolveRatePerHour(value) {
  const parsed = configuredInteger(value);
  if (parsed == null || parsed < 0) return DEFAULT_INGEST_RATE_PER_HOUR;
  return parsed;
}

function resolveAtLeastOne(value, fallback, max) {
  const parsed = configuredInteger(value);
  if (parsed == null || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

export function resolveBackfillMaxBytes(value) {
  return resolveAtLeastOne(value, DEFAULT_INGEST_BACKFILL_MAX_BYTES, MAX_INGEST_BACKFILL_MAX_BYTES);
}

export function resolveBackfillPerHour(value) {
  return resolveAtLeastOne(value, DEFAULT_INGEST_BACKFILL_MAX_PER_HOUR, MAX_INGEST_BACKFILL_MAX_PER_HOUR);
}

export function resolveBackfillTotalBytes(value) {
  return resolveAtLeastOne(value, DEFAULT_INGEST_BACKFILL_MAX_TOTAL_BYTES, MAX_INGEST_BACKFILL_MAX_TOTAL_BYTES);
}

export function resolveBackfillHours(value) {
  return resolveAtLeastOne(value, DEFAULT_INGEST_BACKFILL_HOURS, MAX_INGEST_BACKFILL_HOURS);
}

/** A missing or invalid value uses the D1 ceiling. A larger value cannot raise it. */
export function resolveMaxStatements(value) {
  const parsed = configuredInteger(value);
  if (parsed == null || parsed < 1) return D1_STATEMENT_BUDGET;
  return Math.min(parsed, D1_STATEMENT_BUDGET);
}

/**
 * Statements D1 runs for this batch on an empty store, using the same chunk
 * lists as `insertIngest`. Each group is two stored-row reads. A charged
 * group adds two more reads and the reservation. Group 0 reads the origin
 * marker and inserts it. When `hint` is passed, group 0 reads the hint and
 * writes it only when the stored value would change. Pass `hintKnown` and
 * `storedHint` for that exact write. Omitting them counts the write, which
 * is the safe direction.
 * `prefix` is the window read, the stored-data probe, a seal, and a claim
 * when those run. A release is not included: it runs only after a failed write.
 */
export function projectedIngestStatements({
  points = [],
  workouts = [],
  charge = false,
  raw = false,
  hint,
  storedHint = null,
  hintKnown = false,
  markOrigin = false,
  prefix = 0,
} = {}) {
  const dates = [...new Set([
    ...(points || []).map((point) => point.date),
    ...(workouts || []).map((workout) => workout.date),
  ])].filter((date) => date != null && date !== "");
  const groups = dateGroups(dates, MAX_INGEST_DATES);
  if (groups.length === 0) return prefix;
  let total = prefix;
  for (let index = 0; index < groups.length; index += 1) {
    const group = new Set(groups[index]);
    const groupPoints = (points || []).filter((point) => group.has(point.date));
    const groupWorkouts = (workouts || []).filter((workout) => group.has(workout.date));
    const diff = partitionIngest(groupPoints, groupWorkouts, { points: [], workouts: [] });
    const chunks = ingestWriteChunks(diff.points, diff.workouts);
    let count = 2;
    if (charge) count += 3;
    // The insert is counted even when that marker is already stored. A JSON
    // request on an open window then runs one statement fewer than this
    // projection. The extra count is the safe direction: the request is
    // rejected before it can pass D1's limit.
    if (index === 0 && markOrigin) count += 2;
    if (index === 0 && raw) count += 1;
    count += chunks.replacePoints.length + chunks.guardPoints.length + chunks.insertOnly.length + chunks.upserts.length;
    if (index === 0 && hint !== undefined) {
      count += 1;
      if (!hintKnown || hintAction(storedHint, hint) !== "skip") count += 1;
    }
    total += count;
  }
  return total;
}

/** Split `total` bytes across `count` groups. The shares add up to `total`. */
export function byteShares(total, count) {
  const shares = [];
  if (count <= 0) return shares;
  const base = Math.floor(total / count);
  const extra = total % count;
  for (let index = 0; index < count; index += 1) shares.push(base + (index < extra ? 1 : 0));
  return shares;
}

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function isRealIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (month < 1 || month > 12 || day < 1) return false;
  const lengths = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= lengths[month - 1];
}

/**
 * A real date is clamped to 1970-01-01 through today's UTC calendar date.
 * The configured time zone is not used. Anything that is not a real
 * calendar day uses the default.
 */
export function resolveMinDate(value, { now } = {}) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!isRealIsoDate(trimmed)) return DEFAULT_INGEST_MIN_DATE;
  const today = now instanceof Date && !Number.isNaN(now.getTime())
    ? now.toISOString().slice(0, 10)
    : null;
  if (trimmed < INGEST_MIN_DATE_FLOOR) return INGEST_MIN_DATE_FLOOR;
  if (isRealIsoDate(today) && trimmed > today) return today;
  return trimmed;
}

export function backfillLimits(ctx = {}) {
  return {
    maxBytes: resolveBackfillMaxBytes(ctx.ingestBackfillMaxBytes),
    perHour: resolveBackfillPerHour(ctx.ingestBackfillPerHour),
    totalBytes: resolveBackfillTotalBytes(ctx.ingestBackfillTotalBytes),
    hours: resolveBackfillHours(ctx.ingestBackfillHours),
  };
}

export function normalizeBackfill(row) {
  if (!row) return null;
  const total = row.total_bytes == null || row.total_bytes === "" ? null : Number(row.total_bytes);
  return {
    opened_at: String(row.opened_at),
    closed_at: row.closed_at == null || row.closed_at === "" ? null : String(row.closed_at),
    bytes: Number(row.bytes),
    days: Number(row.days),
    deadline: row.deadline == null || row.deadline === "" ? null : String(row.deadline),
    total_bytes: Number.isFinite(total) ? total : null,
  };
}

/** Deadline for a window that opened at `openedAt`. */
export function backfillClosesAt(openedAt, hours) {
  const opened = Date.parse(openedAt);
  if (!Number.isFinite(opened)) return new Date(0).toISOString();
  return new Date(opened + hours * 3_600_000).toISOString();
}

function rowDeadline(row, limits) {
  if (row.deadline) return row.deadline;
  return backfillClosesAt(row.opened_at, limits.hours);
}

function rowTotal(row, limits) {
  return row.total_bytes == null ? limits.totalBytes : Number(row.total_bytes);
}

/**
 * A missing row is not an open window. `pending` is set by the caller when
 * the database has no stored data yet, so this request may create the row.
 * `bytes_remaining` is 0 once the window is closed.
 */
export function backfillStatus(row, limits, now) {
  if (!row) {
    return { open: false, closes_at: null, bytes_remaining: 0, pending: false };
  }
  const scheduled = rowDeadline(row, limits);
  const total = rowTotal(row, limits);
  const expired = !(now.getTime() < Date.parse(scheduled));
  const full = Number(row.bytes) >= total;
  const open = row.closed_at == null && !expired && !full;
  const closesAt = row.closed_at == null ? scheduled : row.closed_at;
  return {
    open,
    closes_at: closesAt === SEEDED_CLOSE_AT ? null : closesAt,
    bytes_remaining: open ? Math.max(0, total - Number(row.bytes)) : 0,
    pending: false,
  };
}

/** Byte and hourly caps for this request. An open window never tightens them. */
export function activeIngestLimits(row, ctx, now) {
  const limits = backfillLimits(ctx);
  const pending = !row;
  const view = pending
    ? { open: false, closes_at: null, bytes_remaining: 0, pending: true }
    : backfillStatus(row, limits, now);
  const relaxed = view.open || pending;
  const normalBytes = resolveMaxBodyBytes(ctx.ingestMaxBodyBytes);
  const normalRate = resolveRatePerHour(ctx.ingestRatePerHour);
  return {
    limits,
    view,
    pending,
    admitRemaining: view.open ? view.bytes_remaining : (pending ? limits.totalBytes : 0),
    byteLimit: relaxed ? Math.max(normalBytes, limits.maxBytes) : normalBytes,
    rateLimit: relaxed ? (normalRate === 0 ? limits.perHour : Math.max(normalRate, limits.perHour)) : normalRate,
  };
}

/** Calendar-day shift on a YYYY-MM-DD string. */
export function shiftIsoDate(isoDate, days) {
  const [year, month, day] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function hourWindowStart(now) {
  return Math.floor(now.getTime() / 3_600_000) * 3_600_000;
}

export function secondsUntilNextHour(now) {
  const next = hourWindowStart(now) + 3_600_000;
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

export function payloadTooLargeBody(limit, { closed = false, duringBackfill = false, maxBytes } = {}) {
  if (duringBackfill) {
    return {
      error: "payload_too_large",
      message: `Body exceeds ${limit} bytes. ${shorterDateRange(maxBytes)}`,
    };
  }
  const tail = closed
    ? `${INITIAL_IMPORT_CLOSED} Send a shorter range, such as today and yesterday.`
    : "Send a shorter range, such as today and yesterday.";
  return {
    error: "payload_too_large",
    message: `Body exceeds ${limit} bytes. ${tail}`,
  };
}

export function rateLimitedBody(limit, { closed = false } = {}) {
  const base = `Too many ingest posts for this token. The limit is ${limit} per hour.`;
  return {
    error: "rate_limited",
    message: closed ? `${base} ${INITIAL_IMPORT_CLOSED}` : base,
  };
}

export function outsideWindowBody() {
  return {
    error: "outside_window",
    message: `${INITIAL_IMPORT_CLOSED} Send today and yesterday.`,
  };
}

export function backfillTotalBody(maxBytes) {
  return {
    error: "payload_too_large",
    message: `This chunk would pass the initial import total. ${shorterDateRange(maxBytes)}`,
  };
}

export function tooManyDatesBody(maxBytes) {
  return {
    error: "payload_too_large",
    message: `This request covers more than ${MAX_INGEST_DATES} dates. Send it in chunks of ${MAX_INGEST_DATES} dates or fewer. ${chunkHint(maxBytes)}`,
  };
}

export function tooManyStatementsBody(maxBytes, { apple = false } = {}) {
  if (apple) {
    return {
      error: "payload_too_large",
      message: `This export has too many days for one request. Run ${APPLE_CHUNK_COMMAND}.`,
    };
  }
  return {
    error: "payload_too_large",
    message: `This request would use too many statements. Split the import with POST /import/apple-health/chunk. ${chunkHint(maxBytes)}`,
  };
}

export function beforeMinDateBody(minDate) {
  return {
    error: "outside_window",
    message: `Dates before ${minDate} are not accepted.`,
  };
}

/**
 * Keep points and workouts from today minus `maxAgeDays` through today plus
 * `FUTURE_SKEW_DAYS`. `dropped_stale` and `dropped_future` count dated samples
 * and workouts left out on each side.
 */
function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || "");
}

export function filterRecent(points, workouts, { now, timeZone, maxAgeDays, keepPast = false, minDate = DEFAULT_INGEST_MIN_DATE }) {
  const today = localDate(now.toISOString(), timeZone);
  const cutoff = keepPast ? today : shiftIsoDate(today, -maxAgeDays);
  const future = shiftIsoDate(today, FUTURE_SKEW_DAYS);
  const earliest = isIsoDate(minDate) ? minDate : DEFAULT_INGEST_MIN_DATE;
  if ((!keepPast && !isIsoDate(cutoff)) || !isIsoDate(future)) {
    return {
      points: points || [],
      workouts: workouts || [],
      dropped_stale: 0,
      dropped_future: 0,
      dropped_early: 0,
      cutoff,
      today,
    };
  }
  const keptPoints = [];
  const keptWorkouts = [];
  let droppedStale = 0;
  let droppedFuture = 0;
  let droppedEarly = 0;
  for (const point of points || []) {
    if (point.date < earliest) droppedEarly += 1;
    else if (point.date > future) droppedFuture += 1;
    else if (!keepPast && point.date < cutoff) droppedStale += 1;
    else keptPoints.push(point);
  }
  for (const workout of workouts || []) {
    if (workout.date < earliest) droppedEarly += 1;
    else if (workout.date > future) droppedFuture += 1;
    else if (!keepPast && workout.date < cutoff) droppedStale += 1;
    else keptWorkouts.push(workout);
  }
  return {
    points: keptPoints,
    workouts: keptWorkouts,
    dropped_stale: droppedStale,
    dropped_future: droppedFuture,
    dropped_early: droppedEarly,
    cutoff,
    today,
  };
}

function numEq(left, right) {
  if (left == null && right == null) return true;
  if (left == null || right == null) return false;
  const a = Number(left);
  const b = Number(right);
  return Number.isFinite(a) && a === b;
}

function samePoint(prev, next) {
  return numEq(prev.sum_qty, next.sum_qty)
    && numEq(prev.last_qty, next.last_qty)
    && String(prev.last_ts ?? "") === String(next.last_ts ?? "")
    && (prev.units ?? null) === (next.units ?? null)
    && Number(prev.n) === Number(next.n);
}

function sameWorkout(prev, next) {
  const dateOk = prev.date == null || prev.date === next.date;
  return dateOk
    && String(prev.name) === String(next.name)
    && String(prev.start) === String(next.start)
    && numEq(prev.duration_min, next.duration_min)
    && numEq(prev.kcal, next.kcal);
}

/**
 * Rows to write versus rows already stored with the same values.
 * A lower `n` without `replace` is not written and is not counted as unchanged.
 */
export function partitionIngest(points, workouts, stored) {
  const pointMap = new Map((stored?.points || []).map((point) => [`${point.date}\0${point.metric}`, point]));
  const workoutMap = new Map((stored?.workouts || []).map((workout) => [`${workout.name}\0${workout.start}`, workout]));
  const writePoints = [];
  const writeWorkouts = [];
  let unchanged = 0;

  for (const point of points || []) {
    const prev = pointMap.get(`${point.date}\0${point.metric}`);
    if (!prev) {
      writePoints.push(point);
      continue;
    }
    if (!point.replace && !(Number(point.n) >= Number(prev.n))) continue;
    if (samePoint(prev, point)) {
      unchanged += 1;
      continue;
    }
    writePoints.push(point);
  }

  for (const workout of workouts || []) {
    const prev = workoutMap.get(`${workout.name}\0${workout.start}`);
    if (!prev) {
      writeWorkouts.push(workout);
      continue;
    }
    if (workout.insertOnly || sameWorkout(prev, workout)) {
      if (sameWorkout(prev, workout)) unchanged += 1;
      continue;
    }
    writeWorkouts.push(workout);
  }

  return {
    points: writePoints,
    workouts: writeWorkouts,
    written: writePoints.length + writeWorkouts.length,
    unchanged,
  };
}

/** Distinct dates in this batch that are not already stored. */
export function countNewDays(points, workouts, stored) {
  const existing = new Set();
  for (const row of stored?.points || []) if (row?.date) existing.add(row.date);
  for (const row of stored?.workouts || []) if (row?.date) existing.add(row.date);
  const seen = new Set();
  let count = 0;
  for (const row of [...(points || []), ...(workouts || [])]) {
    const date = row?.date;
    if (!date || seen.has(date) || existing.has(date)) continue;
    seen.add(date);
    count += 1;
  }
  return count;
}

/** `desired` undefined leaves the hint, null clears it, a string sets it. */
export function hintAction(current, desired) {
  if (desired === undefined) return "skip";
  if (desired == null) return current == null ? "skip" : "clear";
  return current === desired ? "skip" : "set";
}

export function withExportHint(summary, hint) {
  if (hint == null || hint === "") return summary;
  return { ...summary, export_hint: hint };
}
