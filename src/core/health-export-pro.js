import { durationMinutesFromSeconds, hkQuantityMetric, hkWorkoutName, quantitySample, toKcal } from "./hk.js";
import { DEFAULT_TIME_ZONE } from "./metrics.js";
import { localDate } from "./parse.js";

const SKIPPED_DATA_KEYS = new Set(["workouts", "medicationDoseEvents", "medications"]);

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Health Export Pro's published payload: exportDate, startDate, endDate,
 * syncSource, and data keyed by HealthKit type id. A Health Auto Export
 * body keeps metrics as an array, so it does not match.
 */
export function isHealthExportPro(body) {
  if (!isPlainObject(body)) return false;
  if (typeof body.exportDate !== "string" || !body.exportDate) return false;
  if (typeof body.startDate !== "string" || !body.startDate) return false;
  if (typeof body.endDate !== "string" || !body.endDate) return false;
  if (typeof body.syncSource !== "string" || !body.syncSource) return false;
  if (!isPlainObject(body.data)) return false;
  if (Array.isArray(body.data.metrics)) return false;
  return true;
}

/** Null when `body` matches the Health Export Pro document. Otherwise "invalid_payload". */
export function healthExportProError(body) {
  if (!isHealthExportPro(body)) return "invalid_payload";
  if (body.workoutRoutes != null && !isPlainObject(body.workoutRoutes)) return "invalid_payload";
  if (body.characteristics != null && !isPlainObject(body.characteristics)) return "invalid_payload";
  for (const value of Object.values(body.data)) {
    if (!Array.isArray(value)) return "invalid_payload";
    for (const sample of value) {
      if (!isPlainObject(sample)) return "invalid_payload";
    }
  }
  return null;
}

/**
 * Map a Health Export Pro body onto samples and workouts.
 * Quantity types use the same metric names as an Apple Health export.
 * Medication sections and workoutRoutes are ignored.
 * @param {unknown} body
 * @param {{ timeZone?: string }} [options]
 */
export function parseHealthExportPro(body, options = {}) {
  const timeZone = options.timeZone || DEFAULT_TIME_ZONE;
  const data = isPlainObject(body?.data) ? body.data : {};
  const points = [];
  const workouts = [];

  for (const [key, samples] of Object.entries(data)) {
    if (!Array.isArray(samples)) continue;
    if (key === "workouts") {
      for (const sample of samples) {
        if (!isPlainObject(sample) || !sample.startDate) continue;
        const date = localDate(sample.startDate, timeZone);
        if (!date) continue;
        const seconds = typeof sample.durationSeconds === "number" ? sample.durationSeconds : null;
        let kcal = typeof sample.totalEnergyBurned === "number" ? sample.totalEnergyBurned : null;
        if (kcal != null) kcal = Math.round(toKcal(kcal, sample.totalEnergyBurnedUnit || "kcal"));
        workouts.push({
          name: hkWorkoutName(sample.workoutActivityType ?? ""),
          start: String(sample.startDate),
          date,
          duration_min: durationMinutesFromSeconds(seconds),
          kcal,
        });
      }
      continue;
    }
    if (SKIPPED_DATA_KEYS.has(key)) continue;
    const metric = hkQuantityMetric(key);
    if (!metric) continue;
    for (const sample of samples) {
      if (!isPlainObject(sample)) continue;
      const ts = sample.startDate || sample.endDate;
      const converted = quantitySample(metric, typeof sample.value === "number" ? sample.value : Number.NaN, sample.unit);
      if (!ts || !converted) continue;
      const date = localDate(ts, timeZone);
      if (!date) continue;
      points.push({ metric, ts: String(ts), date, units: converted.units, qty: converted.qty });
    }
  }

  return {
    points: points.filter((point) => point.date),
    workouts: workouts.filter((workout) => workout.date),
  };
}
