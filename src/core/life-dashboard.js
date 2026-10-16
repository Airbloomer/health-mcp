import { DEFAULT_TIME_ZONE } from "./metrics.js";
import {
  addQuantity,
  datedSample,
  finiteNumber,
  intervalKey,
  isPlainObject,
  recordOffset,
  unitsFromKey,
  workoutFromSession,
} from "./health-connect.js";

const RECORD_KEYS = [
  "steps",
  "distance",
  "active_calories",
  "total_calories",
  "exercise",
  "weight",
  "height",
  "body_temperature",
  "body_fat",
  "lean_body_mass",
  "bone_mass",
  "body_water_mass",
  "heart_rate",
  "resting_heart_rate",
  "heart_rate_variability",
  "blood_pressure",
  "blood_glucose",
  "oxygen_saturation",
  "respiratory_rate",
  "sleep",
  "mindfulness",
  "hydration",
  "nutrition",
  "menstruation_flow",
  "menstruation_period",
  "intermenstrual_bleeding",
  "ovulation_test",
  "cervical_mucus",
  "sexual_activity",
  "basal_body_temperature",
  "basal_metabolic_rate",
  "vo2_max",
  "skin_temperature",
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const SUMMARY_NUTRITION = new Map([
  ["calories", ["dietary_energy", "kcal"]],
  ["protein_grams", ["protein", "g"]],
  ["carbs_grams", ["carbohydrates", "g"]],
  ["fat_grams", ["total_fat", "g"]],
]);

/**
 * Life Dashboard Companion health payload. `source` is `health_connect` on
 * Android and `healthkit_ios` from the iPhone app, which publishes the same
 * shape. Screen-time bodies use `source: "screen_time"` and are recognized
 * so they can be rejected instead of parsed as another format.
 */
export function isLifeDashboard(body) {
  if (!isPlainObject(body)) return false;
  if (body.source !== "health_connect" && body.source !== "healthkit_ios" && body.source !== "screen_time") return false;
  if (body.test === true) return true;
  return typeof body.timestamp === "string" && body.timestamp.length > 0;
}

function recordsOk(value) {
  return Array.isArray(value) && value.every((item) => isPlainObject(item));
}

function numberField(record, key, required) {
  if (!Object.hasOwn(record, key)) return !required;
  return finiteNumber(record[key]);
}

function stringField(record, key, required) {
  if (!Object.hasOwn(record, key)) return !required;
  return typeof record[key] === "string" && record[key].length > 0;
}

function metadataOk(record) {
  return record.metadata == null || isPlainObject(record.metadata);
}

/** Null when `body` is a health payload or a test ping. Otherwise "invalid_payload". */
export function lifeDashboardError(body) {
  if (!isLifeDashboard(body)) return "invalid_payload";
  if (body.timestamp != null && typeof body.timestamp !== "string") return "invalid_payload";
  if (body.app_version != null && typeof body.app_version !== "string") return "invalid_payload";
  if (body.test === true) return body.timestamp ? null : "invalid_payload";
  if (body.source === "screen_time") return "invalid_payload";
  if (typeof body.app_version !== "string" || !body.app_version) return "invalid_payload";
  if (body.sequence != null && !Number.isInteger(body.sequence)) return "invalid_payload";
  if (body.daily_totals != null && !dailyTotalsOk(body.daily_totals)) return "invalid_payload";
  if (body.deleted_records != null && !recordsOk(body.deleted_records)) return "invalid_payload";
  if (body._resolutions != null && !isPlainObject(body._resolutions)) return "invalid_payload";
  if (body._diagnostics != null && !isPlainObject(body._diagnostics)) return "invalid_payload";
  if (body.writeback != null && !isPlainObject(body.writeback)) return "invalid_payload";
  for (const key of RECORD_KEYS) {
    if (body[key] != null && !recordsOk(body[key])) return "invalid_payload";
  }
  if (!intervalsOk(body.steps, "count")) return "invalid_payload";
  if (!intervalsOk(body.distance, "meters")) return "invalid_payload";
  if (!intervalsOk(body.active_calories, "calories")) return "invalid_payload";
  if (!intervalsOk(body.total_calories, "calories")) return "invalid_payload";
  if (!intervalsOk(body.hydration, "liters")) return "invalid_payload";
  if (!instantsOk(body.weight, ["kilograms"])) return "invalid_payload";
  if (!instantsOk(body.height, ["meters"])) return "invalid_payload";
  if (!instantsOk(body.body_temperature, ["celsius"])) return "invalid_payload";
  if (!instantsOk(body.body_fat, ["percentage"])) return "invalid_payload";
  if (!instantsOk(body.lean_body_mass, ["kilograms"])) return "invalid_payload";
  if (!instantsOk(body.bone_mass, ["kilograms"])) return "invalid_payload";
  if (!instantsOk(body.body_water_mass, ["kilograms"])) return "invalid_payload";
  if (!instantsOk(body.resting_heart_rate, ["bpm"])) return "invalid_payload";
  if (!instantsOk(body.blood_glucose, ["mmol_per_liter"])) return "invalid_payload";
  if (!instantsOk(body.basal_body_temperature, ["celsius"])) return "invalid_payload";
  if (!instantsOk(body.basal_metabolic_rate, ["kilocalories_per_day"])) return "invalid_payload";
  if (!instantsOk(body.vo2_max, ["vo2_ml_per_min_per_kg"])) return "invalid_payload";
  if (!heartRateOk(body.heart_rate)) return "invalid_payload";
  if (!hrvOk(body.heart_rate_variability)) return "invalid_payload";
  if (!measuredOk(body.oxygen_saturation, "percentage")) return "invalid_payload";
  if (!measuredOk(body.respiratory_rate, "rate")) return "invalid_payload";
  if (!skinOk(body.skin_temperature)) return "invalid_payload";
  if (!bloodPressureOk(body.blood_pressure)) return "invalid_payload";
  if (!sleepOk(body.sleep)) return "invalid_payload";
  if (!exerciseOk(body.exercise)) return "invalid_payload";
  if (!mindfulnessOk(body.mindfulness)) return "invalid_payload";
  if (!nutritionOk(body.nutrition)) return "invalid_payload";
  return null;
}

function dailyTotalsOk(rows) {
  if (!Array.isArray(rows)) return false;
  for (const row of rows) {
    if (!isPlainObject(row) || typeof row.date !== "string" || !DATE_RE.test(row.date)) return false;
    for (const key of ["steps", "distance_meters", "active_calories", "total_calories"]) {
      if (row[key] != null && !finiteNumber(row[key])) return false;
    }
  }
  return true;
}

function intervalsOk(records, valueKey) {
  if (records == null) return true;
  for (const record of records) {
    if (!metadataOk(record)) return false;
    if (Object.hasOwn(record, "bucket_start")) {
      if (!stringField(record, "bucket_start", true) || !numberField(record, "total", true)) return false;
      if (record.bucket_end != null && typeof record.bucket_end !== "string") return false;
      if (record.sample_count != null && !finiteNumber(record.sample_count)) return false;
      continue;
    }
    if (!numberField(record, valueKey, true) || !stringField(record, "start_time", true) || !stringField(record, "end_time", true)) return false;
  }
  return true;
}

function instantsOk(records, numbers) {
  if (records == null) return true;
  return records.every((record) => metadataOk(record) && stringField(record, "time", true) && numbers.every((key) => numberField(record, key, true)));
}

function heartRateOk(records) {
  if (records == null) return true;
  for (const record of records) {
    if (!metadataOk(record)) return false;
    if (Object.hasOwn(record, "bucket_start")) {
      if (!stringField(record, "bucket_start", true) || !numberField(record, "avg", true)) return false;
      continue;
    }
    if (!stringField(record, "time", true) || !numberField(record, "bpm", true)) return false;
  }
  return true;
}

function hrvOk(records) {
  return measuredOk(records, "heart_rate_variability_millis");
}

function measuredOk(records, sampleKey) {
  if (records == null) return true;
  for (const record of records) {
    if (!metadataOk(record)) return false;
    if (Object.hasOwn(record, "bucket_start")) {
      if (!stringField(record, "bucket_start", true) || !numberField(record, "avg", true)) return false;
      continue;
    }
    if (!stringField(record, "time", true) || !numberField(record, sampleKey, true)) return false;
  }
  return true;
}

function skinOk(records) {
  if (records == null) return true;
  for (const record of records) {
    if (!metadataOk(record)) return false;
    if (record.baseline_celsius != null && !finiteNumber(record.baseline_celsius)) return false;
    if (Object.hasOwn(record, "bucket_start")) {
      if (!stringField(record, "bucket_start", true) || !numberField(record, "avg", true)) return false;
      continue;
    }
    if (!stringField(record, "time", true) || !numberField(record, "delta_celsius", true)) return false;
  }
  return true;
}

function bloodPressureOk(records) {
  if (records == null) return true;
  return records.every((record) => metadataOk(record) && stringField(record, "time", true) && numberField(record, "systolic", true) && numberField(record, "diastolic", true));
}

function sleepOk(records) {
  if (records == null) return true;
  for (const record of records) {
    if (!metadataOk(record) || !stringField(record, "session_end_time", true) || !numberField(record, "duration_seconds", true)) return false;
    if (record.stages != null && !recordsOk(record.stages)) return false;
  }
  return true;
}

function exerciseOk(records) {
  if (records == null) return true;
  for (const record of records) {
    if (!metadataOk(record) || typeof record.type !== "string" || !record.type) return false;
    if (!stringField(record, "start_time", true) || !stringField(record, "end_time", true)) return false;
    if (!numberField(record, "duration_seconds", true)) return false;
    if (record.segments != null && !recordsOk(record.segments)) return false;
    if (record.laps != null && !recordsOk(record.laps)) return false;
  }
  return true;
}

function mindfulnessOk(records) {
  if (records == null) return true;
  return records.every((record) => metadataOk(record) && stringField(record, "start_time", true) && stringField(record, "end_time", true) && numberField(record, "duration_seconds", true) && (record.title == null || typeof record.title === "string"));
}

function nutritionOk(records) {
  if (records == null) return true;
  for (const record of records) {
    if (!metadataOk(record) || !stringField(record, "start_time", true) || !stringField(record, "end_time", true)) return false;
    if (record.name != null && typeof record.name !== "string") return false;
    if (record.meal_type != null && typeof record.meal_type !== "string") return false;
    for (const [key, value] of Object.entries(record)) {
      if (key === "name" || key === "meal_type" || key === "start_time" || key === "end_time" || key === "uuid" || key === "source" || key === "metadata") continue;
      if (value != null && !finiteNumber(value) && !isPlainObject(value)) return false;
    }
  }
  return true;
}

function stampInterval(record, timeZone) {
  const offset = recordOffset(record, "start");
  if (typeof record.bucket_start === "string") {
    const start = datedSample(record.bucket_start, timeZone, offset);
    if (!start) return null;
    const end = typeof record.bucket_end === "string" ? datedSample(record.bucket_end, timeZone, offset) : null;
    return { ts: intervalKey(start.ts, end?.ts), date: start.date };
  }
  const start = datedSample(record.start_time, timeZone, offset);
  if (!start) return null;
  const end = typeof record.end_time === "string" ? datedSample(record.end_time, timeZone, recordOffset(record, "end")) : null;
  return { ts: intervalKey(start.ts, end?.ts), date: start.date };
}

function stampInstant(record, timeZone) {
  const iso = record.time || record.bucket_start;
  return datedSample(iso, timeZone, recordOffset(record, "start"));
}

/**
 * Map a Life Dashboard health payload onto points and workouts.
 * `daily_totals` supplies steps, distance, and calories for the dates it
 * names. Raw copies of those metrics on the same dates are not added.
 * Deletions, diagnostics, and screen time are not stored.
 * @param {unknown} body
 * @param {{ timeZone?: string }} [options]
 */
export function parseLifeDashboard(body, options = {}) {
  const timeZone = options.timeZone || DEFAULT_TIME_ZONE;
  const points = [];
  const workouts = [];
  if (!isPlainObject(body) || body.test === true || body.source === "screen_time") return { points, workouts };

  const covered = {
    step_count: new Set(),
    distance: new Set(),
    active_energy: new Set(),
    total_calories: new Set(),
  };
  for (const row of body.daily_totals || []) {
    if (!DATE_RE.test(row.date || "")) continue;
    const stamp = { ts: `${row.date}T00:00:00`, date: row.date };
    if (finiteNumber(row.steps)) {
      addQuantity(points, "step_count", row.steps, "count", stamp);
      covered.step_count.add(row.date);
    }
    if (finiteNumber(row.distance_meters)) {
      addQuantity(points, "distance", row.distance_meters, "m", stamp);
      covered.distance.add(row.date);
    }
    if (finiteNumber(row.active_calories)) {
      addQuantity(points, "active_energy", row.active_calories, "kcal", stamp);
      covered.active_energy.add(row.date);
    }
    if (finiteNumber(row.total_calories)) {
      addQuantity(points, "total_calories", row.total_calories, "kcal", stamp);
      covered.total_calories.add(row.date);
    }
  }

  pushIntervals(points, body.steps, "step_count", "count", "count", timeZone, covered.step_count);
  pushIntervals(points, body.distance, "distance", "meters", "m", timeZone, covered.distance);
  pushIntervals(points, body.active_calories, "active_energy", "calories", "kcal", timeZone, covered.active_energy);
  pushIntervals(points, body.total_calories, "total_calories", "calories", "kcal", timeZone, covered.total_calories);
  pushIntervals(points, body.hydration, "dietary_water", "liters", "L", timeZone);

  for (const record of body.weight || []) addQuantity(points, "weight_body_mass", record.kilograms, "kg", stampInstant(record, timeZone));
  for (const record of body.height || []) addQuantity(points, "height", record.meters, "m", stampInstant(record, timeZone));
  for (const record of body.body_temperature || []) addQuantity(points, "body_temperature", record.celsius, "degC", stampInstant(record, timeZone));
  for (const record of body.body_fat || []) addQuantity(points, "body_fat_percentage", record.percentage, "%", stampInstant(record, timeZone));
  for (const record of body.lean_body_mass || []) addQuantity(points, "lean_body_mass", record.kilograms, "kg", stampInstant(record, timeZone));
  for (const record of body.bone_mass || []) addQuantity(points, "bone_mass", record.kilograms, "kg", stampInstant(record, timeZone));
  for (const record of body.body_water_mass || []) addQuantity(points, "body_water_mass", record.kilograms, "kg", stampInstant(record, timeZone));
  for (const record of body.resting_heart_rate || []) addQuantity(points, "resting_heart_rate", record.bpm, "count/min", stampInstant(record, timeZone));
  for (const record of body.blood_glucose || []) addQuantity(points, "blood_glucose", record.mmol_per_liter, "mmol/L", stampInstant(record, timeZone));
  for (const record of body.basal_body_temperature || []) addQuantity(points, "basal_body_temperature", record.celsius, "degC", stampInstant(record, timeZone));
  for (const record of body.basal_metabolic_rate || []) addQuantity(points, "basal_energy_burned", record.kilocalories_per_day, "kcal", stampInstant(record, timeZone));
  for (const record of body.vo2_max || []) addQuantity(points, "vo2_max", record.vo2_ml_per_min_per_kg, "mL/kg/min", stampInstant(record, timeZone));
  pushMeasured(points, body.heart_rate, "heart_rate", "bpm", "count/min", timeZone);
  pushMeasured(points, body.heart_rate_variability, "heart_rate_variability", "heart_rate_variability_millis", "ms", timeZone);
  pushMeasured(points, body.oxygen_saturation, "oxygen_saturation", "percentage", "%", timeZone);
  pushMeasured(points, body.respiratory_rate, "respiratory_rate", "rate", "count/min", timeZone);
  pushMeasured(points, body.skin_temperature, "skin_temperature", "delta_celsius", "degC", timeZone);
  for (const record of body.blood_pressure || []) {
    const stamp = stampInstant(record, timeZone);
    addQuantity(points, "blood_pressure_systolic", record.systolic, "mmHg", stamp);
    addQuantity(points, "blood_pressure_diastolic", record.diastolic, "mmHg", stamp);
  }
  for (const record of body.sleep || []) {
    addQuantity(points, "sleep_analysis", record.duration_seconds, "s", datedSample(record.session_end_time, timeZone, recordOffset(record, "end")));
  }
  for (const record of body.mindfulness || []) {
    addQuantity(points, "mindfulness", record.duration_seconds, "s", stampInterval(record, timeZone));
  }
  for (const record of body.exercise || []) {
    const workout = workoutFromSession(record, timeZone, recordOffset(record, "start"));
    if (workout) workouts.push(workout);
  }
  for (const record of body.nutrition || []) {
    const stamp = stampInterval(record, timeZone);
    for (const [key, value] of Object.entries(record)) {
      if (!finiteNumber(value)) continue;
      const mapped = SUMMARY_NUTRITION.get(key);
      if (mapped) addQuantity(points, mapped[0], value, mapped[1], stamp);
      else if (unitsFromKey(key)) addQuantity(points, key, value, unitsFromKey(key), stamp);
    }
  }

  return {
    points: points.filter((point) => point.date),
    workouts: workouts.filter((workout) => workout.date),
  };
}

function pushIntervals(points, records, metric, valueKey, units, timeZone, skipDates) {
  for (const record of records || []) {
    const stamp = stampInterval(record, timeZone);
    if (!stamp || skipDates?.has(stamp.date)) continue;
    const qty = Object.hasOwn(record, "bucket_start") ? record.total : record[valueKey];
    addQuantity(points, metric, qty, units, stamp);
  }
}

function pushMeasured(points, records, metric, sampleKey, units, timeZone) {
  for (const record of records || []) {
    const qty = Object.hasOwn(record, "bucket_start") ? record.avg : record[sampleKey];
    addQuantity(points, metric, qty, units, stampInstant(record, timeZone));
  }
}
