import { durationMinutesFromSeconds, hkWorkoutName, quantitySample, toKcal } from "./hk.js";
import { DEFAULT_TIME_ZONE } from "./metrics.js";
import { localDate } from "./parse.js";

/** SyncFit snake_case identifiers that differ from the names this service stores. */
const METRIC_MAP = Object.freeze({
  step_count: "step_count",
  active_energy: "active_energy",
  basal_energy: "basal_energy_burned",
  basal_energy_burned: "basal_energy_burned",
  body_mass: "weight_body_mass",
  weight_body_mass: "weight_body_mass",
  body_fat_percentage: "body_fat_percentage",
  dietary_energy: "dietary_energy",
  dietary_energy_consumed: "dietary_energy",
  dietary_protein: "protein",
  dietary_carbohydrates: "carbohydrates",
  dietary_fat_total: "total_fat",
  protein: "protein",
  carbohydrates: "carbohydrates",
  total_fat: "total_fat",
});

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/** SyncFit native JSON is `schemaVersion: 1` plus a `samples` array. */
export function isSyncFit(body) {
  return isPlainObject(body) && body.schemaVersion === 1 && Array.isArray(body.samples);
}

/** Null when `body` is a schemaVersion 1 document. Otherwise "invalid_payload". */
export function syncFitError(body) {
  if (!isSyncFit(body)) return "invalid_payload";
  for (const sample of body.samples) {
    if (!isPlainObject(sample)) return "invalid_payload";
    if (typeof sample.metric !== "string" || !sample.metric) return "invalid_payload";
    if (sample.id != null && typeof sample.id !== "string") return "invalid_payload";
    if (typeof sample.start !== "string" || !sample.start) return "invalid_payload";
    if (typeof sample.value !== "number" || !Number.isFinite(sample.value)) return "invalid_payload";
    if (sample.unit != null && typeof sample.unit !== "string") return "invalid_payload";
    if (sample.details != null && !isPlainObject(sample.details)) return "invalid_payload";
    if (sample.aggregation != null && typeof sample.aggregation !== "string") return "invalid_payload";
  }
  return null;
}

function storedMetric(name) {
  if (METRIC_MAP[name]) return METRIC_MAP[name];
  return /^[a-z0-9_]+$/.test(name) ? name : null;
}

/**
 * Map SyncFit schemaVersion 1 samples onto points and workouts.
 * `workout` samples use `value` as duration in seconds and
 * `details.activityType` as the HealthKit activity integer.
 * Routes and other detail payloads are ignored. Samples collapse later
 * by metric and timestamp, which is this service's upsert key.
 * @param {unknown} body
 * @param {{ timeZone?: string }} [options]
 */
export function parseSyncFit(body, options = {}) {
  const timeZone = options.timeZone || DEFAULT_TIME_ZONE;
  const points = [];
  const workouts = [];

  for (const sample of body?.samples || []) {
    if (!isPlainObject(sample) || typeof sample.start !== "string") continue;
    const date = localDate(sample.start, timeZone);
    if (!date) continue;
    if (sample.metric === "workout") {
      const details = isPlainObject(sample.details) ? sample.details : {};
      let kcal = typeof details.totalEnergy === "number"
        ? details.totalEnergy
        : (typeof details.totalEnergyBurned === "number" ? details.totalEnergyBurned : null);
      if (kcal != null) kcal = Math.round(toKcal(kcal, details.totalEnergyUnit || details.totalEnergyBurnedUnit || "kcal"));
      workouts.push({
        name: hkWorkoutName(details.activityType ?? details.workoutActivityType ?? ""),
        start: sample.start,
        date,
        duration_min: durationMinutesFromSeconds(sample.value),
        kcal,
      });
      continue;
    }
    const metric = storedMetric(sample.metric);
    const converted = metric ? quantitySample(metric, sample.value, sample.unit) : null;
    if (!metric || !converted) continue;
    points.push({ metric, ts: sample.start, date, units: converted.units, qty: converted.qty });
  }

  return { points, workouts };
}
