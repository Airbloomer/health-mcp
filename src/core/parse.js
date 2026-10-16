import { DEFAULT_TIME_ZONE, ENERGY_METRICS } from "./metrics.js";

// "2026-10-15 07:00:00 -0700" or ISO. Offset-bearing Health Auto Export
// timestamps keep the calendar date in the string. Everything else is
// formatted in `timeZone`.
const OFFSET_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\s*([+-]\d{2}):?(\d{2}))?/;

export function localDate(value, timeZone = DEFAULT_TIME_ZONE) {
  if (!value) return null;
  const text = String(value);
  const match = text.match(OFFSET_RE);
  if (match && match[3]) return match[1];
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
  }
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone || DEFAULT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Null when `body` is a Health Auto Export object with a metrics and/or
 * workouts array. Otherwise "invalid_payload".
 */
export function payloadError(body) {
  if (!isPlainObject(body)) return "invalid_payload";
  const data = Object.hasOwn(body, "data") ? body.data : body;
  if (!isPlainObject(data)) return "invalid_payload";
  const hasMetrics = Object.hasOwn(data, "metrics");
  const hasWorkouts = Object.hasOwn(data, "workouts");
  if (!hasMetrics && !hasWorkouts) return "invalid_payload";
  if (hasMetrics && !Array.isArray(data.metrics)) return "invalid_payload";
  if (hasWorkouts && !Array.isArray(data.workouts)) return "invalid_payload";
  if (hasMetrics) {
    for (const metric of data.metrics) {
      if (!isPlainObject(metric)) return "invalid_payload";
      if (metric.data != null && !Array.isArray(metric.data)) return "invalid_payload";
      if (Array.isArray(metric.data)) {
        for (const sample of metric.data) {
          if (!isPlainObject(sample)) return "invalid_payload";
        }
      }
    }
  }
  if (hasWorkouts) {
    for (const workout of data.workouts) {
      if (!isPlainObject(workout)) return "invalid_payload";
    }
  }
  return null;
}

function toKcal(qty, units) {
  return units && /^kj$/i.test(units) ? qty / 4.184 : qty;
}

function num(value) {
  if (typeof value === "number") return value;
  if (value && typeof value.qty === "number") return value.qty;
  return null;
}

/**
 * Parse a Health Auto Export v2 body (`{ data: { metrics, workouts } }`).
 * A body that is already the `data` object is accepted too.
 * @param {unknown} body
 * @param {{ timeZone?: string }} [options]
 */
export function parse(body, options = {}) {
  const timeZone = options.timeZone || DEFAULT_TIME_ZONE;
  const data = body?.data ?? body;
  const points = [];
  const workouts = [];

  for (const metric of data?.metrics || []) {
    if (!isPlainObject(metric)) continue;
    const name = String(metric.name || "").toLowerCase();
    for (const sample of metric.data || []) {
      if (!isPlainObject(sample)) continue;
      const ts = sample.date || sample.startDate;
      let qty = num(sample.qty ?? sample.Avg ?? sample.avg);
      if (!ts || qty == null) continue;
      let units = metric.units || null;
      if (ENERGY_METRICS.has(name)) {
        qty = toKcal(qty, units);
        units = "kcal";
      }
      points.push({ metric: name, ts: String(ts), date: localDate(ts, timeZone), units, qty });
    }
  }

  for (const workout of data?.workouts || []) {
    if (!isPlainObject(workout) || !workout.start) continue;
    let duration = num(workout.duration);
    if (duration == null && workout.end) {
      duration = (new Date(workout.end) - new Date(workout.start)) / 1000;
    }
    const energy = workout.activeEnergyBurned ?? workout.activeEnergy ?? workout.totalEnergy;
    let kcal = Array.isArray(energy)
      ? energy.reduce((sum, sample) => sum + (num(sample) || 0), 0)
      : num(energy);
    if (kcal != null && energy?.units) kcal = toKcal(kcal, energy.units);
    workouts.push({
      name: String(workout.name || "Workout"),
      start: String(workout.start),
      date: localDate(workout.start, timeZone),
      duration_min: duration == null ? null : Math.round(duration / 6) / 10,
      kcal: kcal == null ? null : Math.round(kcal),
    });
  }

  return {
    points: points.filter((point) => point.date),
    workouts: workouts.filter((workout) => workout.date),
  };
}
