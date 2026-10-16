import { LATEST_METRICS, SUM_METRICS } from "./metrics.js";

function round1(value) {
  return Math.round(value * 10) / 10;
}

function asNumber(value) {
  if (value == null || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function readPoint(point) {
  if (Object.hasOwn(point, "sum_qty") || Object.hasOwn(point, "last_qty")) {
    return {
      sum: asNumber(point.sum_qty),
      latest: asNumber(point.last_qty),
      ts: String(point.last_ts ?? ""),
      units: point.units ?? null,
    };
  }
  const qty = asNumber(point.qty);
  return { sum: qty, latest: qty, ts: String(point.ts ?? ""), units: point.units ?? null };
}

/**
 * Build the GET /summary object for one day.
 * `points` are daily rows (`sum_qty`, `last_qty`, `last_ts`, `units`) or raw samples.
 * Summed metrics use `sum_qty` (rounded to one decimal; steps then to an integer).
 * Weight is the latest sample. Body fat at or below 1 is treated as a fraction.
 */
export function summarizeDay(date, points, workouts) {
  const out = {
    date,
    dietary_kcal: null,
    protein_g: null,
    carbs_g: null,
    fat_g: null,
    active_kcal: null,
    basal_kcal: null,
    steps: null,
    weight: null,
    body_fat_pct: null,
    workouts: [],
  };

  const sums = new Map();
  const latest = new Map();
  for (const point of points || []) {
    const part = readPoint(point);
    if (Object.hasOwn(SUM_METRICS, point.metric) && part.sum != null) {
      sums.set(point.metric, (sums.get(point.metric) ?? 0) + part.sum);
    }
    if (Object.hasOwn(LATEST_METRICS, point.metric) && part.latest != null) {
      const prev = latest.get(point.metric);
      if (!prev || part.ts > prev.ts) latest.set(point.metric, { qty: part.latest, ts: part.ts, units: part.units });
    }
  }

  for (const [metric, field] of Object.entries(SUM_METRICS)) {
    if (sums.has(metric)) out[field] = round1(sums.get(metric));
  }
  for (const [metric, field] of Object.entries(LATEST_METRICS)) {
    const row = latest.get(metric);
    if (!row) continue;
    if (field === "weight") out.weight = { value: round1(row.qty), units: row.units ?? null };
    else out[field] = round1(row.qty <= 1 ? row.qty * 100 : row.qty);
  }
  if (out.steps != null) out.steps = Math.round(out.steps);

  out.workouts = (workouts || [])
    .map((workout) => ({
      name: workout.name,
      start: workout.start,
      duration_min: asNumber(workout.duration_min),
      kcal: asNumber(workout.kcal),
    }))
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));

  return out;
}
