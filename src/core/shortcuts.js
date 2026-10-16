import { aggregateDays } from "./aggregate.js";
import { zoneOffsetMs } from "./datetime.js";
import { durationMinutesFromSeconds, toKcal } from "./hk.js";
import {
  BODY_FAT_PCT_RANGE,
  canonicalStart,
  clockOptions,
  dateInWindow,
  datedSample,
  ENERGY_KCAL_RANGE,
  exerciseName,
  inRange,
  isPlainObject,
  STEP_RANGE,
  WEIGHT_KG_RANGE,
} from "./health-connect.js";
import { ENERGY_METRICS, LATEST_METRICS } from "./metrics.js";

/** Most entries one request may carry. A daily Shortcut sends far fewer. */
export const MAX_SHORTCUT_SAMPLES = 100_000;
/** Longest workout accepted, in seconds (two days). */
const MAX_WORKOUT_SECONDS = 2 * 24 * 60 * 60;
const GRAMS_RANGE = [0, 100_000];
const MAX_SOURCE_CHARS = 200;

/** Default raw-mode source order: a source whose name contains "watch" wins, then "iphone". */
export const DEFAULT_SHORTCUTS_SOURCE_PRIORITY = Object.freeze(["watch", "iphone"]);

function nullProto(entries) {
  return Object.freeze(Object.assign(Object.create(null), entries));
}

/**
 * Names a Shortcut may send in `type`, after lowercasing and turning spaces
 * and hyphens into underscores. Health app display names and this service's
 * stored names are both accepted. Other `[a-z0-9_]` names pass through and
 * are kept only when `HEALTH_METRIC_ALLOWLIST` lists them.
 */
const TYPE_MAP = nullProto({
  steps: "step_count",
  step_count: "step_count",
  active_energy: "active_energy",
  active_calories: "active_energy",
  resting_energy: "basal_energy_burned",
  basal_energy: "basal_energy_burned",
  basal_energy_burned: "basal_energy_burned",
  weight: "weight_body_mass",
  body_mass: "weight_body_mass",
  weight_body_mass: "weight_body_mass",
  body_fat: "body_fat_percentage",
  body_fat_percentage: "body_fat_percentage",
  dietary_energy: "dietary_energy",
  dietary_calories: "dietary_energy",
  protein: "protein",
  carbohydrates: "carbohydrates",
  carbs: "carbohydrates",
  total_fat: "total_fat",
  fat: "total_fat",
});

const ENERGY_UNITS = new Set(["kcal", "cal", "kj"]);
const MASS_TO_KG = nullProto({ kg: 1, g: 0.001, lb: 0.45359237, lbs: 0.45359237, st: 6.35029318 });
const GRAM_METRICS = new Set(["protein", "carbohydrates", "total_fat"]);

function typeKey(value) {
  return String(value).trim().toLowerCase().replace(/[\s-]+/g, "_");
}

/** Stored metric name for a Shortcut `type`, or null when it cannot be one. */
export function shortcutMetric(type) {
  if (typeof type !== "string" || !type.trim()) return null;
  const key = typeKey(type);
  if (Object.hasOwn(TYPE_MAP, key)) return TYPE_MAP[key];
  if (key in Object.prototype || key.startsWith("__")) return null;
  return /^[a-z0-9_]+$/.test(key) ? key : null;
}

/**
 * A finite number from a JSON number or a numeric string such as "8123",
 * " 72.5 ", or "72,5". Grouped strings such as "1,234" or "1 234" are
 * rejected because the decimal mark cannot be told apart from a separator.
 */
export function shortcutNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
  if (/^-?\d+,\d+$/.test(text) && !/^-?\d{1,3},\d{3}$/.test(text)) return Number(text.replace(",", "."));
  return null;
}

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** Epoch ms for a wall-clock time in `timeZone`, independent of the host zone. */
function wallClockInstant(fields, timeZone) {
  const guess = Date.UTC(fields[0], fields[1] - 1, fields[2], fields[3], fields[4], fields[5]);
  const first = guess - zoneOffsetMs(guess, timeZone);
  const second = guess - zoneOffsetMs(first, timeZone);
  // A wall-clock time skipped by a DST jump does not exist; reject it.
  if (second + zoneOffsetMs(second, timeZone) !== guess) return null;
  return second;
}

/**
 * ISO 8601 date or date-time. `2026-10-14T09:00:00-07:00` and `...-0700`
 * keep the written day. `...Z` takes its day from `HEALTH_TIMEZONE`. With
 * no offset (or date only), the time is read in `HEALTH_TIMEZONE`, so the
 * written day is the day. Locale strings such as "Oct 14, 2026 at 9:00 AM"
 * are rejected. Returns `{ ts, date, ms }` or null.
 */
export function shortcutTime(value, ctx) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  const match = ISO_RE.exec(text);
  if (!match) return null;
  const offset = match[7];
  const fields = [1, 2, 3, 4, 5, 6].map((index) => Number(match[index] || 0));
  if (fields[3] > 23 || fields[4] > 59 || fields[5] > 59) return null;
  if (!offset) {
    const date = text.slice(0, 10);
    if (!dateInWindow(date, ctx.now, ctx.timeZone)) return null;
    const ms = wallClockInstant(fields, ctx.timeZone);
    if (ms == null) return null;
    const pad = (n) => String(n).padStart(2, "0");
    return { ts: `${date}T${pad(fields[3])}:${pad(fields[4])}:${pad(fields[5])}`, date, ms };
  }
  const normalized = text.replace(" ", "T").replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const ms = Date.parse(normalized);
  if (!Number.isFinite(ms)) return null;
  const stamp = datedSample(normalized, ctx.timeZone, null, ctx.now);
  return stamp ? { ...stamp, ms } : null;
}

function unitKey(unit) {
  return unit == null ? "" : String(unit).trim().toLowerCase();
}

/** The checked quantity in this service's units, or null when out of range or in an unknown unit. */
function normalizedQuantity(metric, qty, unit) {
  const key = unitKey(unit);
  if (metric === "step_count") return inRange(qty, ...STEP_RANGE) ? { qty, units: "count" } : null;
  if (ENERGY_METRICS.has(metric)) {
    if (key && !ENERGY_UNITS.has(key)) return null;
    const kcal = toKcal(qty, key === "kj" ? "kJ" : "kcal");
    return inRange(kcal, ...ENERGY_KCAL_RANGE) ? { qty: kcal, units: "kcal" } : null;
  }
  if (metric === "weight_body_mass") {
    const unitName = key || "kg";
    const factor = Object.hasOwn(MASS_TO_KG, unitName) ? MASS_TO_KG[unitName] : null;
    if (!factor || !inRange(qty * factor, ...WEIGHT_KG_RANGE)) return null;
    return { qty: qty * factor, units: "kg" };
  }
  if (metric === "body_fat_percentage") {
    if (key && key !== "%") return null;
    return inRange(qty, ...BODY_FAT_PCT_RANGE) ? { qty, units: "%" } : null;
  }
  if (GRAM_METRICS.has(metric)) {
    if (key && key !== "g") return null;
    return inRange(qty, ...GRAMS_RANGE) ? { qty, units: "g" } : null;
  }
  if (qty < 0 || qty > 1_000_000_000) return null;
  return { qty, units: key ? String(unit).trim() : null };
}

function fail(field) {
  return { field };
}

/** `{ row }` or `{ field }` naming the first bad field. Never carries the input value in an error. */
function checkSample(sample, ctx) {
  if (!isPlainObject(sample)) return fail(null);
  if (sample.kind != null && sample.kind !== "daily" && sample.kind !== "sample") return fail("kind");
  const daily = sample.kind === "daily";
  const metric = shortcutMetric(sample.type);
  if (!metric) return fail("type");
  const qty = shortcutNumber(sample.value);
  if (qty == null) return fail("value");
  if (sample.unit != null && typeof sample.unit !== "string") return fail("unit");
  if (sample.source != null && (typeof sample.source !== "string" || sample.source.length > MAX_SOURCE_CHARS)) return fail("source");
  const startField = sample.start != null ? "start" : "date";
  const start = shortcutTime(sample.start ?? sample.date, ctx);
  if (!start) return fail(startField);
  let end = null;
  if (sample.end != null) {
    end = shortcutTime(sample.end, ctx);
    if (!end || end.ms < start.ms) return fail("end");
  }
  const quantity = normalizedQuantity(metric, qty, sample.unit);
  if (!quantity) return fail(Number.isFinite(qty) && sample.unit != null ? "unit_or_value" : "value");
  const ts = end && end.ts !== start.ts ? `${start.ts}/${end.ts}` : start.ts;
  return {
    row: {
      metric,
      ts,
      date: start.date,
      units: quantity.units,
      qty: quantity.qty,
      daily,
      source: typeof sample.source === "string" ? sample.source.trim().toLowerCase() : "",
    },
  };
}

function checkWorkout(workout, ctx) {
  if (!isPlainObject(workout)) return fail(null);
  if (workout.type != null && typeof workout.type !== "string") return fail("type");
  const start = shortcutTime(workout.start, ctx);
  if (!start) return { drop: true };
  let seconds = null;
  if (workout.duration != null) {
    seconds = shortcutNumber(workout.duration);
    if (seconds == null) return fail("duration");
  }
  if (workout.end != null) {
    const end = shortcutTime(workout.end, ctx);
    if (!end || end.ms < start.ms) return fail("end");
    if (seconds == null) seconds = (end.ms - start.ms) / 1000;
  }
  if (seconds != null && !inRange(seconds, 0, MAX_WORKOUT_SECONDS)) return fail(workout.duration != null ? "duration" : "end");
  let kcal = null;
  if (workout.energy != null) {
    const energy = shortcutNumber(workout.energy);
    if (energy == null) return fail("energy");
    const unit = unitKey(workout.energyUnit);
    if (unit && !ENERGY_UNITS.has(unit)) return fail("energyUnit");
    kcal = toKcal(energy, unit === "kj" ? "kJ" : "kcal");
    if (!inRange(kcal, ...ENERGY_KCAL_RANGE)) return fail("energy");
    kcal = Math.round(kcal);
  }
  return {
    row: {
      name: exerciseName(workout.type ?? ""),
      // UTC, so the same instant written in different formats is one upsert key.
      start: canonicalStart(workout.start, ctx.timeZone) || new Date(start.ms).toISOString(),
      date: start.date,
      duration_min: durationMinutesFromSeconds(seconds),
      kcal,
    },
  };
}

/** A Shortcuts body is an object with a `samples` and/or `workouts` array. */
export function isShortcuts(body) {
  return isPlainObject(body) && (Array.isArray(body.samples) || Array.isArray(body.workouts));
}

function invalid(at, field) {
  const error = { error: "invalid_payload" };
  if (at) error.at = at;
  if (at && field) error.field = field;
  return error;
}

/**
 * Null when the body is valid. Otherwise `{ error: "invalid_payload", at, field }`
 * where `at` is like `samples[12]` and `field` is a field name. Input values
 * are never echoed. One bad entry rejects the request.
 * @param {unknown} body
 * @param {{ timeZone?: string, now?: Date }} [options]
 */
export function shortcutsError(body, options = {}) {
  if (!isShortcuts(body)) return invalid();
  for (const key of ["samples", "workouts"]) {
    if (body[key] != null && !Array.isArray(body[key])) return invalid(key);
  }
  const samples = body.samples || [];
  const workouts = body.workouts || [];
  if (samples.length + workouts.length > MAX_SHORTCUT_SAMPLES) return invalid();
  const ctx = clockOptions(options);
  const dailyKeys = new Set();
  const rawKeys = new Set();
  for (let index = 0; index < samples.length; index++) {
    const result = checkSample(samples[index], ctx);
    if (!result.row) return invalid(`samples[${index}]`, result.field);
    const key = `${result.row.metric}\0${result.row.date}`;
    if (result.row.daily) {
      if (dailyKeys.has(key)) return invalid(`samples[${index}]`, "start");
      if (rawKeys.has(key)) return invalid(`samples[${index}]`, "kind");
      dailyKeys.add(key);
    } else {
      if (dailyKeys.has(key)) return invalid(`samples[${index}]`, "kind");
      rawKeys.add(key);
    }
  }
  for (let index = 0; index < workouts.length; index++) {
    const result = checkWorkout(workouts[index], ctx);
    if (result.drop) continue;
    if (!result.row) return invalid(`workouts[${index}]`, result.field);
  }
  return null;
}

/**
 * Sample rows (with `daily` and `source`) and workouts. Energy is in kcal and
 * weight in kg. Call `shortcutDays` to turn the rows into stored day rows.
 * @param {unknown} body
 * @param {{ timeZone?: string, now?: Date }} [options]
 */
export function parseShortcuts(body, options = {}) {
  const ctx = clockOptions(options);
  const points = [];
  const workouts = [];
  let droppedWorkouts = 0;
  for (const sample of body?.samples || []) {
    const result = checkSample(sample, ctx);
    if (result.row) points.push(result.row);
  }
  for (const workout of body?.workouts || []) {
    const result = checkWorkout(workout, ctx);
    if (result.drop) {
      droppedWorkouts += 1;
      continue;
    }
    if (result.row) workouts.push(result.row);
  }
  return { points, workouts, droppedWorkouts };
}

/** `HEALTH_SHORTCUTS_SOURCE_PRIORITY`: comma-separated, case-insensitive name fragments. */
export function shortcutsSourcePriority(value) {
  const list = (Array.isArray(value) ? value : String(value ?? "").split(","))
    .map((name) => String(name).trim().toLowerCase())
    .filter(Boolean);
  return list.length ? list : [...DEFAULT_SHORTCUTS_SOURCE_PRIORITY];
}

function pickSource(groups, metric, priority) {
  for (const fragment of priority) {
    const matches = groups.filter((group) => group.source.includes(fragment));
    if (matches.length) return largest(matches, metric);
  }
  return largest(groups, metric);
}

function largest(groups, metric) {
  const latest = Object.hasOwn(LATEST_METRICS, metric);
  return groups.reduce((best, group) => {
    if (!best) return group;
    if (latest) return group.lastTs > best.lastTs || (group.lastTs === best.lastTs && group.source < best.source) ? group : best;
    if (group.sum > best.sum || (group.sum === best.sum && group.source < best.source)) return group;
    return best;
  }, null);
}

/**
 * One stored row per metric per day, marked `replace` so a re-send replaces
 * the stored day instead of being compared by sample count.
 * - A `kind: "daily"` entry is the day total (or the day's reading) as is.
 * - Otherwise samples are grouped by `source`, one source wins per
 *   metric-day by `priority` (first fragment contained in the source name),
 *   then by largest total (newest reading for weight and body fat), and only
 *   that source's samples are summed.
 */
export function shortcutDays(points, priority = DEFAULT_SHORTCUTS_SOURCE_PRIORITY) {
  const byDay = new Map();
  for (const point of points) {
    const key = `${point.metric}\0${point.date}`;
    let day = byDay.get(key);
    if (!day) byDay.set(key, (day = { daily: null, raw: [] }));
    if (point.daily) day.daily = point;
    else day.raw.push(point);
  }
  const rows = [];
  for (const day of byDay.values()) {
    if (day.daily) {
      const point = day.daily;
      rows.push({ metric: point.metric, date: point.date, sum_qty: point.qty, last_qty: point.qty, last_ts: String(point.ts), units: point.units, n: 1, replace: true });
      continue;
    }
    const groups = new Map();
    for (const point of day.raw) {
      let group = groups.get(point.source);
      if (!group) groups.set(point.source, (group = { source: point.source, samples: [], sum: 0, lastTs: "" }));
      group.samples.push(point);
      group.sum += point.qty;
      if (String(point.ts) > group.lastTs) group.lastTs = String(point.ts);
    }
    const chosen = pickSource([...groups.values()], day.raw[0].metric, priority);
    for (const row of aggregateDays(chosen.samples, null)) rows.push({ ...row, replace: true });
  }
  return rows;
}
