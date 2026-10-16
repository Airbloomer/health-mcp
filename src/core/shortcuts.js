import { durationMinutesFromSeconds, toKcal } from "./hk.js";
import {
  BODY_FAT_PCT_RANGE,
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
import { ENERGY_METRICS } from "./metrics.js";

/** Most samples one request may carry. A daily Shortcut sends far fewer. */
export const MAX_SHORTCUT_SAMPLES = 100_000;
/** Longest workout accepted, in seconds (two days). */
const MAX_WORKOUT_SECONDS = 2 * 24 * 60 * 60;
const GRAMS_RANGE = [0, 100_000];

/**
 * Names a Shortcut may send in `type`, after lowercasing and turning spaces
 * and hyphens into underscores. Health app display names and this service's
 * stored names are both accepted. Other `[a-z0-9_]` names pass through and
 * are kept only when `HEALTH_METRIC_ALLOWLIST` lists them.
 */
const TYPE_MAP = Object.freeze(Object.assign(Object.create(null), {
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
}));

const ENERGY_UNITS = new Set(["kcal", "cal", "kj"]);
const MASS_TO_KG = Object.freeze(Object.assign(Object.create(null), { kg: 1, g: 0.001, lb: 0.45359237, lbs: 0.45359237, st: 6.35029318 }));
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

/**
 * ISO 8601 date-time: `2026-10-14T09:00:00-07:00`, `...Z`, or no offset
 * (the written calendar day is used as is). `Z` times take their day from `HEALTH_TIMEZONE`. A space may replace the `T`. Locale strings
 * such as "Oct 14, 2026 at 9:00 AM" are rejected.
 */
const ISO_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

function stamp(value, ctx) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!ISO_RE.test(text)) return null;
  const iso = text.length === 10 ? `${text}T00:00:00` : text.replace(" ", "T");
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(iso)) {
    // No offset: the phone wrote its own wall-clock time, so the written day is the day.
    const date = iso.slice(0, 10);
    return dateInWindow(date, ctx.now, ctx.timeZone) ? { ts: iso, date } : null;
  }
  const normalized = /[+-]\d{4}$/.test(iso) ? iso.replace(/([+-]\d{2})(\d{2})$/, "$1:$2") : iso;
  if (Number.isNaN(new Date(normalized).getTime())) return null;
  return datedSample(normalized, ctx.timeZone, null, ctx.now);
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
    const factor = Object.hasOwn(MASS_TO_KG, key || "kg") ? MASS_TO_KG[key || "kg"] : null;
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

function sampleRow(sample, ctx) {
  if (!isPlainObject(sample)) return null;
  const metric = shortcutMetric(sample.type);
  if (!metric) return null;
  const qty = shortcutNumber(sample.value);
  if (qty == null) return null;
  if (sample.unit != null && typeof sample.unit !== "string") return null;
  const start = stamp(sample.start ?? sample.date, ctx);
  if (!start) return null;
  if (sample.end != null && !stamp(sample.end, ctx)) return null;
  const quantity = normalizedQuantity(metric, qty, sample.unit);
  if (!quantity) return null;
  const end = typeof sample.end === "string" ? sample.end.trim() : "";
  const ts = end && end !== start.ts ? `${start.ts}/${end}` : start.ts;
  return { metric, ts, date: start.date, units: quantity.units, qty: quantity.qty };
}

function workoutRow(workout, ctx) {
  if (!isPlainObject(workout)) return null;
  if (workout.type != null && typeof workout.type !== "string") return null;
  const start = stamp(workout.start, ctx);
  if (!start) return null;
  let seconds = workout.duration == null ? null : shortcutNumber(workout.duration);
  if (workout.duration != null && seconds == null) return null;
  if (workout.end != null) {
    const end = stamp(workout.end, ctx);
    if (!end) return null;
    if (seconds == null) {
      const startMs = Date.parse(start.ts);
      const endMs = Date.parse(end.ts);
      if (Number.isFinite(startMs) && Number.isFinite(endMs)) seconds = (endMs - startMs) / 1000;
    }
  }
  if (seconds != null && !inRange(seconds, 0, MAX_WORKOUT_SECONDS)) return null;
  let kcal = null;
  if (workout.energy != null) {
    const energy = shortcutNumber(workout.energy);
    const unit = unitKey(workout.energyUnit);
    if (energy == null || (unit && !ENERGY_UNITS.has(unit))) return null;
    kcal = toKcal(energy, unit === "kj" ? "kJ" : "kcal");
    if (!inRange(kcal, ...ENERGY_KCAL_RANGE)) return null;
    kcal = Math.round(kcal);
  }
  return {
    name: exerciseName(workout.type ?? ""),
    start: start.ts,
    date: start.date,
    duration_min: durationMinutesFromSeconds(seconds),
    kcal,
  };
}

/** A Shortcuts body is an object with a `samples` and/or `workouts` array. */
export function isShortcuts(body) {
  return isPlainObject(body) && (Array.isArray(body.samples) || Array.isArray(body.workouts));
}

/**
 * Null when every sample and workout is valid. Otherwise "invalid_payload".
 * One bad entry rejects the request so a Shortcut that formats dates or
 * numbers wrongly fails loudly instead of storing a partial day.
 * @param {unknown} body
 * @param {{ timeZone?: string, now?: Date }} [options]
 */
export function shortcutsError(body, options = {}) {
  if (!isShortcuts(body)) return "invalid_payload";
  for (const key of ["samples", "workouts"]) {
    if (body[key] != null && !Array.isArray(body[key])) return "invalid_payload";
  }
  const samples = body.samples || [];
  const workouts = body.workouts || [];
  if (samples.length + workouts.length > MAX_SHORTCUT_SAMPLES) return "invalid_payload";
  const ctx = clockOptions(options);
  if (!samples.every((sample) => sampleRow(sample, ctx))) return "invalid_payload";
  if (!workouts.every((workout) => workoutRow(workout, ctx))) return "invalid_payload";
  return null;
}

/**
 * Points (one per sample, collapsed later into one row per metric per day)
 * and workouts. Energy is stored in kcal and weight in kg.
 * @param {unknown} body
 * @param {{ timeZone?: string, now?: Date }} [options]
 */
export function parseShortcuts(body, options = {}) {
  const ctx = clockOptions(options);
  const points = [];
  const workouts = [];
  for (const sample of body?.samples || []) {
    const row = sampleRow(sample, ctx);
    if (row) points.push(row);
  }
  for (const workout of body?.workouts || []) {
    const row = workoutRow(workout, ctx);
    if (row) workouts.push(row);
  }
  return { points, workouts };
}
