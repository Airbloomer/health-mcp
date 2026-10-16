export const summaryDate = "2026-10-14";

/** One already-aggregated day, posted to POST /import/apple-health/chunk. */
export const summaryChunk = {
  points: [
    { metric: "dietary_energy", date: summaryDate, sum_qty: 1200.5, last_qty: 700.5, last_ts: "2026-10-14 13:00:00 -0700", units: "kcal", n: 1 },
    { metric: "protein", date: summaryDate, sum_qty: 40, last_qty: 40, last_ts: "2026-10-14 08:00:00 -0700", units: "g", n: 1 },
    { metric: "carbohydrates", date: summaryDate, sum_qty: 120, last_qty: 120, last_ts: "2026-10-14 08:00:00 -0700", units: "g", n: 1 },
    { metric: "total_fat", date: summaryDate, sum_qty: 35, last_qty: 35, last_ts: "2026-10-14 08:00:00 -0700", units: "g", n: 1 },
    { metric: "active_energy", date: summaryDate, sum_qty: 500, last_qty: 500, last_ts: "2026-10-14 10:00:00 -0700", units: "kcal", n: 1 },
    { metric: "basal_energy_burned", date: summaryDate, sum_qty: 1750, last_qty: 1750, last_ts: "2026-10-14 00:00:00 -0700", units: "kcal", n: 1 },
    { metric: "step_count", date: summaryDate, sum_qty: 9321, last_qty: 5321, last_ts: "2026-10-14 18:00:00 -0700", units: "count", n: 2 },
    { metric: "weight_body_mass", date: summaryDate, sum_qty: 180.2, last_qty: 180.2, last_ts: "2026-10-14 07:00:00 -0700", units: "lb", n: 1 },
    { metric: "body_fat_percentage", date: summaryDate, sum_qty: 18.4, last_qty: 18.4, last_ts: "2026-10-14 07:00:00 -0700", units: "%", n: 1 },
  ],
  workouts: [
    {
      name: "Traditional Strength Training",
      start: "2026-10-15T00:30:00.000Z",
      date: summaryDate,
      duration_min: 45,
      kcal: 310,
    },
  ],
};

export const expectedSummary = {
  date: summaryDate,
  dietary_kcal: 1200.5,
  protein_g: 40,
  carbs_g: 120,
  fat_g: 35,
  active_kcal: 500,
  basal_kcal: 1750,
  steps: 9321,
  weight: { value: 180.2, units: "lb" },
  body_fat_pct: 18.4,
  workouts: [
    {
      name: "Traditional Strength Training",
      start: "2026-10-15T00:30:00.000Z",
      duration_min: 45,
      kcal: 310,
    },
  ],
};
