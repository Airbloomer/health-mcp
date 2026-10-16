import { durationMinutesFromSeconds, quantitySample, wordsFromIdentifier } from "./hk.js";
import { DEFAULT_TIME_ZONE } from "./metrics.js";
import { localDate } from "./parse.js";

/**
 * Health Connect exercise type constants from ExerciseSessionRecord.
 * The string keys match AndroidX EXERCISE_TYPE_STRING_TO_INT_MAP, and the
 * last name written for an id is the one toString()-style reverse map keeps
 * (`calisthenics`, `high_intensity_interval_training`, `strength_training`).
 * HC Webhook sends `exerciseType.toString()` (the decimal). Life Dashboard
 * Companion sends that decimal as a string; its iOS app sends the name.
 */
const EXERCISE_TYPES = [
  ["back_extension", 13],
  ["badminton", 2],
  ["barbell_shoulder_press", 70],
  ["baseball", 4],
  ["basketball", 5],
  ["bench_press", 70],
  ["bench_sit_up", 13],
  ["biking", 8],
  ["biking_stationary", 9],
  ["boot_camp", 10],
  ["boxing", 11],
  ["burpee", 13],
  ["cricket", 14],
  ["crunch", 13],
  ["dancing", 16],
  ["deadlift", 70],
  ["dumbbell_curl_left_arm", 70],
  ["dumbbell_curl_right_arm", 70],
  ["dumbbell_front_raise", 70],
  ["dumbbell_lateral_raise", 70],
  ["dumbbell_triceps_extension_left_arm", 70],
  ["dumbbell_triceps_extension_right_arm", 70],
  ["dumbbell_triceps_extension_two_arm", 70],
  ["elliptical", 25],
  ["exercise_class", 26],
  ["fencing", 27],
  ["football_american", 28],
  ["football_australian", 29],
  ["forward_twist", 13],
  ["frisbee_disc", 31],
  ["golf", 32],
  ["guided_breathing", 33],
  ["gymnastics", 34],
  ["handball", 35],
  ["hiking", 37],
  ["ice_hockey", 38],
  ["ice_skating", 39],
  ["jumping_jack", 36],
  ["jump_rope", 36],
  ["lat_pull_down", 70],
  ["lunge", 13],
  ["martial_arts", 44],
  ["paddling", 46],
  ["para_gliding", 47],
  ["pilates", 48],
  ["plank", 13],
  ["racquetball", 50],
  ["rock_climbing", 51],
  ["roller_hockey", 52],
  ["rowing", 53],
  ["rowing_machine", 54],
  ["rugby", 55],
  ["running", 56],
  ["running_treadmill", 57],
  ["sailing", 58],
  ["scuba_diving", 59],
  ["skating", 60],
  ["skiing", 61],
  ["snowboarding", 62],
  ["snowshoeing", 63],
  ["soccer", 64],
  ["softball", 65],
  ["squash", 66],
  ["squat", 13],
  ["stair_climbing", 68],
  ["stair_climbing_machine", 69],
  ["stretching", 71],
  ["surfing", 72],
  ["swimming_open_water", 73],
  ["swimming_pool", 74],
  ["table_tennis", 75],
  ["tennis", 76],
  ["upper_twist", 13],
  ["volleyball", 78],
  ["walking", 79],
  ["water_polo", 80],
  ["weightlifting", 81],
  ["wheelchair", 82],
  ["workout", 0],
  ["yoga", 83],
  ["calisthenics", 13],
  ["high_intensity_interval_training", 36],
  ["strength_training", 70],
];

const EXERCISE_BY_NAME = new Map(EXERCISE_TYPES);
const EXERCISE_BY_INT = new Map();
for (const [name, id] of EXERCISE_TYPES) EXERCISE_BY_INT.set(id, name);

export function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

export function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/** Inclusive bounds for values these adapters store. */
export const STEP_RANGE = [0, 1_000_000];
export const ENERGY_KCAL_RANGE = [0, 100_000];
export const WEIGHT_KG_RANGE = [0.5, 500];
export const BODY_FAT_PCT_RANGE = [0, 100];
export const DISTANCE_M_RANGE = [0, 1_000_000];
export const MASS_G_RANGE = [0, 100_000];

const CALENDAR_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_MIN = "2000-01-01";
const FUTURE_DAYS = 2;

export function inRange(value, min, max) {
  return finiteNumber(value) && value >= min && value <= max;
}

/** True when `value` is a real `YYYY-MM-DD` calendar date, not merely four-two-two digits. */
export function realCalendarDate(value) {
  if (typeof value !== "string") return false;
  const match = CALENDAR_RE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Latest calendar day that may be stored: two days after `now`, in `timeZone`. */
export function latestStoredDate(now = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  const end = new Date(now.getTime() + FUTURE_DAYS * 24 * 60 * 60 * 1000);
  return localDate(end.toISOString(), timeZone || DEFAULT_TIME_ZONE);
}

/** Real calendar dates from 2000-01-01 through two days after `now`. */
export function dateInWindow(value, now = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  if (!realCalendarDate(value)) return false;
  if (value < DATE_MIN) return false;
  const latest = latestStoredDate(now, timeZone);
  return realCalendarDate(latest) && value <= latest;
}

export function clockOptions(options = {}) {
  return {
    timeZone: options.timeZone || DEFAULT_TIME_ZONE,
    now: options.now instanceof Date && !Number.isNaN(options.now.getTime()) ? options.now : new Date(),
  };
}

export function rangesOk(records, ranges) {
  if (records == null) return true;
  if (!Array.isArray(records)) return false;
  return records.every((record) => isPlainObject(record) && Object.entries(ranges).every(([key, bounds]) => {
    if (record[key] == null) return true;
    return inRange(record[key], bounds[0], bounds[1]);
  }));
}

/** Top-level timestamp and `date` fields must fall in the storage window. */
export function timesInWindow(record, ctx, offsetFor) {
  if (!isPlainObject(record)) return false;
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== "string") continue;
    if (key === "date") {
      if (!dateInWindow(value, ctx.now, ctx.timeZone)) return false;
      continue;
    }
    if (key !== "bucket_start" && key !== "bucket_end" && !key.endsWith("time")) continue;
    const offset = offsetFor ? offsetFor(record, key) : null;
    if (!datedSample(value, ctx.timeZone, offset, ctx.now)) return false;
  }
  return true;
}

export function exerciseName(type) {
  if (typeof type === "number" && Number.isInteger(type)) {
    const name = EXERCISE_BY_INT.get(type);
    return name ? titleFromSnake(name) : `Workout ${type}`;
  }
  const text = String(type ?? "").trim();
  if (!text) return "Workout";
  if (/^\d+$/.test(text)) return exerciseName(Number(text));
  const key = text.toLowerCase().replace(/[\s-]+/g, "_");
  if (EXERCISE_BY_NAME.has(key)) return titleFromSnake(EXERCISE_BY_INT.get(EXERCISE_BY_NAME.get(key)));
  if (/^[a-z0-9_]+$/.test(key)) return titleFromSnake(key);
  return wordsFromIdentifier(text) || "Workout";
}

function titleFromSnake(name) {
  return String(name)
    .split("_")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** `+HH:MM` / `-HH:MM` as stored on Life Dashboard record metadata. */
function offsetTimestamp(iso, offset) {
  if (typeof offset !== "string" || !/^[+-](?:0\d|1[0-4]):[0-5]\d$/.test(offset)) return null;
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return null;
  const sign = offset.startsWith("-") ? -1 : 1;
  const minutes = sign * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6)));
  const shifted = new Date(instant.getTime() + minutes * 60000);
  const pad = (value) => String(value).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}${offset}`;
}

/**
 * Calendar day for a Health Connect instant.
 * A numeric offset already in the timestamp wins, matching the other adapters.
 * Otherwise a Life Dashboard zone offset is applied, then `HEALTH_TIMEZONE`.
 */
export function datedSample(iso, timeZone = DEFAULT_TIME_ZONE, offset = null, now = new Date()) {
  if (typeof iso !== "string" || !iso) return null;
  const written = /^(\d{4}-\d{2}-\d{2})/.exec(iso.trim());
  if (!written || !realCalendarDate(written[1])) return null;
  const hasOffset = /[+-]\d{2}:?\d{2}$/.test(iso);
  const ts = !hasOffset && offset ? offsetTimestamp(iso, offset) || iso : iso;
  const date = localDate(ts, timeZone || DEFAULT_TIME_ZONE);
  if (!dateInWindow(date, now, timeZone || DEFAULT_TIME_ZONE)) return null;
  return { ts, date };
}

export function recordOffset(record, which = "start") {
  const meta = record?.metadata;
  if (!isPlainObject(meta)) return null;
  const value = which === "end"
    ? meta.end_zone_offset || meta.start_zone_offset || meta.zone_offset
    : meta.zone_offset || meta.start_zone_offset || meta.end_zone_offset;
  return typeof value === "string" ? value : null;
}

export function addQuantity(points, metric, qty, units, stamp) {
  const converted = quantitySample(metric, qty, units);
  if (!stamp || !converted) return;
  points.push({ metric, ts: stamp.ts, date: stamp.date, units: converted.units, qty: converted.qty });
}

export function workoutFromSession(record, timeZone, offset, now = new Date()) {
  if (!isPlainObject(record) || typeof record.start_time !== "string") return null;
  const stamp = datedSample(record.start_time, timeZone, offset, now);
  if (!stamp) return null;
  let seconds = finiteNumber(record.duration_seconds) ? record.duration_seconds : null;
  if (seconds == null && typeof record.end_time === "string") {
    const start = new Date(record.start_time);
    const end = new Date(record.end_time);
    if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) seconds = (end - start) / 1000;
  }
  return {
    name: exerciseName(record.type),
    start: stamp.ts,
    date: stamp.date,
    duration_min: durationMinutesFromSeconds(seconds),
    kcal: null,
  };
}

/** Stable sample key so two intervals that start together both survive the daily collapse. */
export function intervalKey(startTs, endTs) {
  return endTs && endTs !== startTs ? `${startTs}/${endTs}` : startTs;
}

export function unitsFromKey(key) {
  if (key.endsWith("_mcg")) return "mcg";
  if (key.endsWith("_mg")) return "mg";
  if (key.endsWith("_kcal")) return "kcal";
  if (key.endsWith("_g") || key.endsWith("_grams")) return "g";
  return null;
}
