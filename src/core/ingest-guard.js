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
export const DEFAULT_INGEST_BACKFILL_MAX_BYTES = 25_000_000;

/** Upper bound for a malformed per-request import cap. */
export const MAX_INGEST_BACKFILL_MAX_BYTES = 100_000_000;

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

export const INITIAL_IMPORT_CLOSED = "The initial import window is closed.";

export const SHORTER_DATE_RANGE = "Send a shorter date range.";

/** A payload that drops at least this many dated records looks like a full history. */
export const STALE_HINT_AT = 50;

/** Dates after today plus this many days are dropped. Covers timezone and device skew. */
export const FUTURE_SKEW_DAYS = 1;

export const EXPORT_HINT =
  "This export looks misconfigured: it sent too much history or it is posting too often. Follow Recommended export settings in the README.";

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
  return {
    opened_at: String(row.opened_at),
    closed_at: row.closed_at == null || row.closed_at === "" ? null : String(row.closed_at),
    bytes: Number(row.bytes),
    days: Number(row.days),
  };
}

/** Deadline for a window that opened at `openedAt`. */
export function backfillClosesAt(openedAt, hours) {
  const opened = Date.parse(openedAt);
  if (!Number.isFinite(opened)) return new Date(0).toISOString();
  return new Date(opened + hours * 3_600_000).toISOString();
}

/**
 * `open` is true when no row exists yet, or the row is still inside its
 * time and byte budget. `closes_at` is the deadline while open, or the
 * time it actually closed.
 */
export function backfillStatus(row, limits, now) {
  if (!row) {
    return { open: true, closes_at: null, bytes_remaining: limits.totalBytes };
  }
  const scheduled = backfillClosesAt(row.opened_at, limits.hours);
  const expired = !(now.getTime() < Date.parse(scheduled));
  const full = Number(row.bytes) >= limits.totalBytes;
  const open = row.closed_at == null && !expired && !full;
  return {
    open,
    closes_at: row.closed_at || scheduled,
    bytes_remaining: Math.max(0, limits.totalBytes - Number(row.bytes)),
  };
}

/** Byte and hourly caps for this request. An open window never tightens them. */
export function activeIngestLimits(row, ctx, now) {
  const limits = backfillLimits(ctx);
  const view = backfillStatus(row, limits, now);
  const normalBytes = resolveMaxBodyBytes(ctx.ingestMaxBodyBytes);
  const normalRate = resolveRatePerHour(ctx.ingestRatePerHour);
  return {
    limits,
    view,
    byteLimit: view.open ? Math.max(normalBytes, limits.maxBytes) : normalBytes,
    rateLimit: view.open ? (normalRate === 0 ? limits.perHour : Math.max(normalRate, limits.perHour)) : normalRate,
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

export function payloadTooLargeBody(limit, { closed = false, duringBackfill = false } = {}) {
  if (duringBackfill) {
    return {
      error: "payload_too_large",
      message: `Body exceeds ${limit} bytes. ${SHORTER_DATE_RANGE}`,
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

export function backfillTotalBody() {
  return {
    error: "payload_too_large",
    message: `This chunk would pass the initial import total. ${SHORTER_DATE_RANGE}`,
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

export function filterRecent(points, workouts, { now, timeZone, maxAgeDays, keepPast = false }) {
  const today = localDate(now.toISOString(), timeZone);
  const cutoff = keepPast ? today : shiftIsoDate(today, -maxAgeDays);
  const future = shiftIsoDate(today, FUTURE_SKEW_DAYS);
  if ((!keepPast && !isIsoDate(cutoff)) || !isIsoDate(future)) {
    return { points: points || [], workouts: workouts || [], dropped_stale: 0, dropped_future: 0, cutoff, today };
  }
  const keptPoints = [];
  const keptWorkouts = [];
  let droppedStale = 0;
  let droppedFuture = 0;
  for (const point of points || []) {
    if (point.date > future) droppedFuture += 1;
    else if (!keepPast && point.date < cutoff) droppedStale += 1;
    else keptPoints.push(point);
  }
  for (const workout of workouts || []) {
    if (workout.date > future) droppedFuture += 1;
    else if (!keepPast && workout.date < cutoff) droppedStale += 1;
    else keptWorkouts.push(workout);
  }
  return {
    points: keptPoints,
    workouts: keptWorkouts,
    dropped_stale: droppedStale,
    dropped_future: droppedFuture,
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
