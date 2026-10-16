import { DEFAULT_TIME_ZONE } from "./metrics.js";
import {
  addQuantity,
  BODY_FAT_PCT_RANGE,
  clockOptions,
  datedSample,
  DISTANCE_M_RANGE,
  ENERGY_KCAL_RANGE,
  finiteNumber,
  intervalKey,
  isPlainObject,
  MASS_G_RANGE,
  rangesOk,
  STEP_RANGE,
  timesInWindow,
  WEIGHT_KG_RANGE,
  workoutFromSession,
} from "./health-connect.js";

/** Arrays HC Webhook emits from Health Connect. Unknown arrays are ignored. */
const RECORD_KEYS = [
  "steps",
  "sleep",
  "heart_rate",
  "heart_rate_variability",
  "distance",
  "active_calories",
  "total_calories",
  "weight",
  "height",
  "blood_pressure",
  "blood_glucose",
  "oxygen_saturation",
  "body_temperature",
  "skin_temperature",
  "respiratory_rate",
  "resting_heart_rate",
  "exercise",
  "hydration",
  "nutrition",
  "basal_metabolic_rate",
  "body_fat",
  "lean_body_mass",
  "body_water_mass",
  "bmi",
  "vo2_max",
  "bone_mass",
  "menstruation_flow",
  "menstruation_period",
  "intermenstrual_bleeding",
  "ovulation_test",
  "cervical_mucus",
  "sexual_activity",
  "basal_body_temperature",
];

const NUTRITION_FIELDS = [
  ["calories", "dietary_energy", "kcal"],
  ["protein_grams", "protein", "g"],
  ["carbs_grams", "carbohydrates", "g"],
  ["fat_grams", "total_fat", "g"],
  ["sugar_grams", "sugar", "g"],
  ["sodium_grams", "sodium", "g"],
  ["dietary_fiber_grams", "dietary_fiber", "g"],
];

/**
 * HC Webhook JSON: `timestamp`, `app_version`, and snake_case record arrays.
 * Life Dashboard payloads carry `source` and are not this format.
 */
export function isHcWebhook(body) {
  if (!isPlainObject(body)) return false;
  if (typeof body.timestamp !== "string" || !body.timestamp) return false;
  if (typeof body.app_version !== "string" || !body.app_version) return false;
  if (body.source != null || body.schemaVersion != null || body.exportDate != null || body.syncSource != null) return false;
  if (isPlainObject(body.data) || Array.isArray(body.metrics) || Array.isArray(body.workouts)) return false;
  return true;
}

function recordsOk(value) {
  if (!Array.isArray(value)) return false;
  return value.every((item) => isPlainObject(item));
}

function numberField(record, key, required) {
  if (!Object.hasOwn(record, key)) return !required;
  return finiteNumber(record[key]);
}

function stringField(record, key, required) {
  if (!Object.hasOwn(record, key)) return !required;
  return typeof record[key] === "string" && record[key].length > 0;
}

/** Null when `body` is an HC Webhook document. Otherwise "invalid_payload". */
export function hcWebhookError(body, options = {}) {
  if (!isHcWebhook(body)) return "invalid_payload";
  const ctx = clockOptions(options);
  for (const key of RECORD_KEYS) {
    if (body[key] != null && !recordsOk(body[key])) return "invalid_payload";
  }
  if (!arrayFieldsOk(body.steps, ["count"], ["start_time", "end_time"])) return "invalid_payload";
  if (!arrayFieldsOk(body.distance, ["meters"], ["start_time", "end_time"])) return "invalid_payload";
  if (!arrayFieldsOk(body.active_calories, ["calories"], ["start_time", "end_time"])) return "invalid_payload";
  if (!arrayFieldsOk(body.total_calories, ["calories"], ["start_time", "end_time"])) return "invalid_payload";
  if (!arrayFieldsOk(body.hydration, ["liters"], ["start_time", "end_time"])) return "invalid_payload";
  if (!arrayFieldsOk(body.weight, ["kilograms"], ["time"])) return "invalid_payload";
  if (!arrayFieldsOk(body.height, ["meters"], ["time"])) return "invalid_payload";
  if (!arrayFieldsOk(body.body_fat, ["percentage"], ["time"])) return "invalid_payload";
  if (!arrayFieldsOk(body.lean_body_mass, ["kilograms"], ["time"])) return "invalid_payload";
  if (!arrayFieldsOk(body.bone_mass, ["kilograms"], ["time"])) return "invalid_payload";
  if (!arrayFieldsOk(body.body_water_mass, ["kilograms"], ["time"])) return "invalid_payload";
  if (!arrayFieldsOk(body.bmi, ["value"], ["time"])) return "invalid_payload";
  if (!arrayFieldsOk(body.vo2_max, ["ml_per_kg_per_min"], ["time"])) return "invalid_payload";
  if (!arrayFieldsOk(body.basal_metabolic_rate, ["watts"], ["time"])) return "invalid_payload";
  if (!arrayFieldsOk(body.resting_heart_rate, ["bpm"], ["time"])) return "invalid_payload";
  if (!arrayFieldsOk(body.body_temperature, ["celsius"], ["time"])) return "invalid_payload";
  if (!arrayFieldsOk(body.basal_body_temperature, ["celsius"], ["time"])) return "invalid_payload";
  if (!arrayFieldsOk(body.blood_glucose, ["mmol_per_liter"], ["time"])) return "invalid_payload";
  if (!seriesOk(body.heart_rate, "bpm")) return "invalid_payload";
  if (!seriesOk(body.heart_rate_variability, "rmssd_millis")) return "invalid_payload";
  if (!seriesOk(body.oxygen_saturation, "percentage")) return "invalid_payload";
  if (!seriesOk(body.respiratory_rate, "rate")) return "invalid_payload";
  if (!skinOk(body.skin_temperature)) return "invalid_payload";
  if (!bloodPressureOk(body.blood_pressure)) return "invalid_payload";
  if (!sleepOk(body.sleep)) return "invalid_payload";
  if (!exerciseOk(body.exercise)) return "invalid_payload";
  if (!nutritionOk(body.nutrition)) return "invalid_payload";
  if (!integerFieldOk(body.menstruation_flow, "flow")) return "invalid_payload";
  if (!integerFieldOk(body.ovulation_test, "result")) return "invalid_payload";
  if (!integerFieldOk(body.cervical_mucus, "appearance")) return "invalid_payload";
  if (!integerFieldOk(body.sexual_activity, "protection_used")) return "invalid_payload";
  if (!recordsInWindow(body, ctx)) return "invalid_payload";
  if (!rangesOk(body.steps, { count: STEP_RANGE })) return "invalid_payload";
  if (!rangesOk(body.distance, { meters: DISTANCE_M_RANGE })) return "invalid_payload";
  if (!rangesOk(body.active_calories, { calories: ENERGY_KCAL_RANGE })) return "invalid_payload";
  if (!rangesOk(body.total_calories, { calories: ENERGY_KCAL_RANGE })) return "invalid_payload";
  if (!rangesOk(body.weight, { kilograms: WEIGHT_KG_RANGE })) return "invalid_payload";
  if (!rangesOk(body.body_fat, { percentage: BODY_FAT_PCT_RANGE })) return "invalid_payload";
  if (!nutritionRangesOk(body.nutrition)) return "invalid_payload";
  return null;
}

function recordsInWindow(body, ctx) {
  for (const key of RECORD_KEYS) {
    if (!Array.isArray(body[key])) continue;
    if (body[key].some((record) => !timesInWindow(record, ctx))) return false;
  }
  return true;
}

function nutritionRangesOk(records) {
  if (records == null) return true;
  return records.every((record) => NUTRITION_FIELDS.every(([key, , units]) => {
    if (record[key] == null) return true;
    const bounds = units === "kcal" ? ENERGY_KCAL_RANGE : MASS_G_RANGE;
    return finiteNumber(record[key]) && record[key] >= bounds[0] && record[key] <= bounds[1];
  }));
}

function arrayFieldsOk(records, numbers, strings) {
  if (records == null) return true;
  for (const record of records) {
    if (numbers.some((key) => !numberField(record, key, true))) return false;
    if (strings.some((key) => !stringField(record, key, true))) return false;
    if (!metadataOk(record)) return false;
  }
  return true;
}

function metadataOk(record) {
  return record.metadata == null || isPlainObject(record.metadata);
}

function seriesOk(records, sampleKey) {
  if (records == null) return true;
  for (const record of records) {
    if (!stringField(record, "time", true) || !metadataOk(record)) return false;
    const aggregate = Object.hasOwn(record, "avg");
    if (aggregate) {
      if (!numberField(record, "avg", true) || !numberField(record, "min", true) || !numberField(record, "max", true)) return false;
    }
    if (!aggregate && !numberField(record, sampleKey, true)) return false;
    if (Object.hasOwn(record, sampleKey) && !numberField(record, sampleKey, true)) return false;
  }
  return true;
}

function skinOk(records) {
  if (records == null) return true;
  for (const record of records) {
    if (!stringField(record, "time", true) || !metadataOk(record)) return false;
    if (!numberField(record, "measurement_location", true)) return false;
    const aggregate = Object.hasOwn(record, "avg_delta_celsius");
    if (aggregate) {
      if (!["avg_delta_celsius", "min_delta_celsius", "max_delta_celsius", "delta_celsius"].every((key) => numberField(record, key, true))) {
        return false;
      }
    } else if (!numberField(record, "delta_celsius", true)) return false;
    if (record.baseline_celsius != null && !finiteNumber(record.baseline_celsius)) return false;
  }
  return true;
}

function bloodPressureOk(records) {
  if (records == null) return true;
  return records.every((record) => numberField(record, "systolic", true) && numberField(record, "diastolic", true) && stringField(record, "time", true) && metadataOk(record));
}

function sleepOk(records) {
  if (records == null) return true;
  for (const record of records) {
    if (!stringField(record, "session_end_time", true) || !numberField(record, "duration_seconds", true) || !metadataOk(record)) return false;
    if (record.stages != null && !recordsOk(record.stages)) return false;
  }
  return true;
}

function exerciseOk(records) {
  if (records == null) return true;
  for (const record of records) {
    if (typeof record.type !== "string" || !record.type) return false;
    if (!stringField(record, "start_time", true) || !stringField(record, "end_time", true)) return false;
    if (!numberField(record, "duration_seconds", true) || !metadataOk(record)) return false;
    for (const key of ["distance_meters", "steps", "avg_cadence_spm", "max_cadence_spm", "stride_length_m"]) {
      if (record[key] != null && !finiteNumber(record[key])) return false;
    }
    if (record.title != null && typeof record.title !== "string") return false;
  }
  return true;
}

function nutritionOk(records) {
  if (records == null) return true;
  for (const record of records) {
    if (!stringField(record, "start_time", true) || !stringField(record, "end_time", true) || !metadataOk(record)) return false;
    if (record.name != null && typeof record.name !== "string") return false;
    for (const [key] of NUTRITION_FIELDS) {
      if (record[key] != null && !finiteNumber(record[key])) return false;
    }
  }
  return true;
}

function integerFieldOk(records, key) {
  if (records == null) return true;
  return records.every((record) => numberField(record, key, true) && stringField(record, "time", true) && metadataOk(record));
}

function stampInterval(record, timeZone, now) {
  const start = datedSample(record.start_time, timeZone, null, now);
  if (!start) return null;
  const end = typeof record.end_time === "string" ? datedSample(record.end_time, timeZone, null, now) : null;
  return { ts: intervalKey(start.ts, end?.ts), date: start.date };
}

function stampInstant(record, timeZone, now) {
  return datedSample(record.time, timeZone, null, now);
}

/**
 * Map an HC Webhook body onto the shared metric and workout model.
 * Exercise sessions have no energy field in this payload, so `kcal` is null.
 * `bmi` is emitted by the app when weight and height are both present.
 * @param {unknown} body
 * @param {{ timeZone?: string }} [options]
 */
export function parseHcWebhook(body, options = {}) {
  const { timeZone, now } = clockOptions(options);
  const points = [];
  const workouts = [];
  if (!isPlainObject(body)) return { points, workouts };

  for (const record of body.steps || []) addQuantity(points, "step_count", record.count, "count", stampInterval(record, timeZone, now));
  for (const record of body.distance || []) addQuantity(points, "distance", record.meters, "m", stampInterval(record, timeZone, now));
  for (const record of body.active_calories || []) addQuantity(points, "active_energy", record.calories, "kcal", stampInterval(record, timeZone, now));
  for (const record of body.total_calories || []) addQuantity(points, "total_calories", record.calories, "kcal", stampInterval(record, timeZone, now));
  for (const record of body.hydration || []) addQuantity(points, "dietary_water", record.liters, "L", stampInterval(record, timeZone, now));
  for (const record of body.weight || []) addQuantity(points, "weight_body_mass", record.kilograms, "kg", stampInstant(record, timeZone, now));
  for (const record of body.height || []) addQuantity(points, "height", record.meters, "m", stampInstant(record, timeZone, now));
  for (const record of body.body_fat || []) addQuantity(points, "body_fat_percentage", record.percentage, "%", stampInstant(record, timeZone, now));
  for (const record of body.lean_body_mass || []) addQuantity(points, "lean_body_mass", record.kilograms, "kg", stampInstant(record, timeZone, now));
  for (const record of body.bone_mass || []) addQuantity(points, "bone_mass", record.kilograms, "kg", stampInstant(record, timeZone, now));
  for (const record of body.body_water_mass || []) addQuantity(points, "body_water_mass", record.kilograms, "kg", stampInstant(record, timeZone, now));
  for (const record of body.bmi || []) addQuantity(points, "body_mass_index", record.value, "kg/m2", stampInstant(record, timeZone, now));
  for (const record of body.vo2_max || []) addQuantity(points, "vo2_max", record.ml_per_kg_per_min, "mL/kg/min", stampInstant(record, timeZone, now));
  for (const record of body.basal_metabolic_rate || []) addQuantity(points, "basal_metabolic_rate", record.watts, "W", stampInstant(record, timeZone, now));
  for (const record of body.resting_heart_rate || []) addQuantity(points, "resting_heart_rate", record.bpm, "count/min", stampInstant(record, timeZone, now));
  for (const record of body.body_temperature || []) addQuantity(points, "body_temperature", record.celsius, "degC", stampInstant(record, timeZone, now));
  for (const record of body.basal_body_temperature || []) addQuantity(points, "basal_body_temperature", record.celsius, "degC", stampInstant(record, timeZone, now));
  for (const record of body.blood_glucose || []) addQuantity(points, "blood_glucose", record.mmol_per_liter, "mmol/L", stampInstant(record, timeZone, now));
  pushSeries(points, body.heart_rate, "heart_rate", "bpm", "count/min", timeZone, now);
  pushSeries(points, body.heart_rate_variability, "heart_rate_variability", "rmssd_millis", "ms", timeZone, now);
  pushSeries(points, body.oxygen_saturation, "oxygen_saturation", "percentage", "%", timeZone, now);
  pushSeries(points, body.respiratory_rate, "respiratory_rate", "rate", "count/min", timeZone, now);
  for (const record of body.skin_temperature || []) {
    const qty = finiteNumber(record.avg_delta_celsius) ? record.avg_delta_celsius : record.delta_celsius;
    addQuantity(points, "skin_temperature", qty, "degC", stampInstant(record, timeZone, now));
  }
  for (const record of body.blood_pressure || []) {
    const stamp = stampInstant(record, timeZone, now);
    addQuantity(points, "blood_pressure_systolic", record.systolic, "mmHg", stamp);
    addQuantity(points, "blood_pressure_diastolic", record.diastolic, "mmHg", stamp);
  }
  for (const record of body.sleep || []) {
    addQuantity(points, "sleep_analysis", record.duration_seconds, "s", datedSample(record.session_end_time, timeZone, null, now));
  }
  for (const record of body.exercise || []) {
    const workout = workoutFromSession(record, timeZone, null, now);
    if (workout) workouts.push(workout);
  }
  for (const record of body.nutrition || []) {
    const stamp = stampInterval(record, timeZone, now);
    for (const [key, metric, units] of NUTRITION_FIELDS) {
      if (finiteNumber(record[key])) addQuantity(points, metric, record[key], units, stamp);
    }
  }
  for (const [key, field] of [
    ["menstruation_flow", "flow"],
    ["ovulation_test", "result"],
    ["cervical_mucus", "appearance"],
    ["sexual_activity", "protection_used"],
  ]) {
    for (const record of body[key] || []) addQuantity(points, key, record[field], null, stampInstant(record, timeZone, now));
  }

  return {
    points: points.filter((point) => point.date),
    workouts: workouts.filter((workout) => workout.date),
  };
}

function pushSeries(points, records, metric, sampleKey, units, timeZone, now) {
  for (const record of records || []) {
    const qty = finiteNumber(record.avg) ? record.avg : record[sampleKey];
    addQuantity(points, metric, qty, units, stampInstant(record, timeZone, now));
  }
}
