import { localDate } from "./parse.js";
import { MAX_PAYLOAD_CHARS } from "./metrics.js";

/** Today and yesterday in the configured timezone. */
export const DEFAULT_INGEST_MAX_AGE_DAYS = 1;

/** JSON ingest bodies larger than this are rejected. Apple Health import is separate. */
export const DEFAULT_INGEST_MAX_BODY_BYTES = 1_000_000;

/** Accepted posts per token per UTC hour. Zero disables the limit. */
export const DEFAULT_INGEST_RATE_PER_HOUR = 6;

/** A payload that drops at least this many dated records looks like a full history. */
export const STALE_HINT_AT = 50;

/** Dates after today plus this many days are dropped. Covers timezone and device skew. */
export const FUTURE_SKEW_DAYS = 1;

export const EXPORT_HINT =
  "This export looks misconfigured: it sent a full history or it is posting too often. Follow Recommended export settings in the README (JSON version 2, one total per day, today and yesterday, a few times a day).";

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
  return parsed;
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

export function payloadTooLargeBody(limit) {
  return {
    error: "payload_too_large",
    message: `Body exceeds ${limit} bytes. Send a shorter range, such as today and yesterday.`,
  };
}

export function rateLimitedBody(limit) {
  return {
    error: "rate_limited",
    message: `Too many ingest posts for this token. The limit is ${limit} per hour.`,
  };
}

/**
 * Keep points and workouts from today minus `maxAgeDays` through today plus
 * `FUTURE_SKEW_DAYS`. `dropped_stale` and `dropped_future` count dated samples
 * and workouts left out on each side.
 */
export function filterRecent(points, workouts, { now, timeZone, maxAgeDays }) {
  const today = localDate(now.toISOString(), timeZone);
  const cutoff = shiftIsoDate(today, -maxAgeDays);
  const future = shiftIsoDate(today, FUTURE_SKEW_DAYS);
  const keptPoints = [];
  const keptWorkouts = [];
  let droppedStale = 0;
  let droppedFuture = 0;
  for (const point of points || []) {
    if (point.date > future) droppedFuture += 1;
    else if (point.date < cutoff) droppedStale += 1;
    else keptPoints.push(point);
  }
  for (const workout of workouts || []) {
    if (workout.date > future) droppedFuture += 1;
    else if (workout.date < cutoff) droppedStale += 1;
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
