/** Stored metric names, and the summary fields they fill. */

export const DEFAULT_TIME_ZONE = "UTC";

/**
 * Legacy character cap. Ingest paths use byte limits from `limits.js`.
 * Kept so older callers fail closed if they still import it.
 */
export const MAX_PAYLOAD_CHARS = 20_000_000;

/**
 * Stored only when HEALTH_METRIC_ALLOWLIST names the metric exactly.
 * Security can extend this list. It does not filter points by itself.
 */
export const SENSITIVE_METRICS = [
  "menstruation_flow",
  "menstruation_period",
  "intermenstrual_bleeding",
  "ovulation_test",
  "cervical_mucus",
  "sexual_activity",
  "blood_glucose",
  "sleep_stage",
  "body_temperature",
  "skin_temperature",
  "basal_body_temperature",
];

/** Byte limit for a streamed Apple Health export (XML or zip). */
export const MAX_APPLE_EXPORT_BYTES = 2_000_000_000;

/** Raw bodies above this are not stored. D1 rejects a row larger than 2MB. */
export const MAX_RAW_BYTES = 1_500_000;

/** Summed across the calendar day. Energy metrics are stored as kcal. */
export const SUM_METRICS = {
  dietary_energy: "dietary_kcal",
  protein: "protein_g",
  carbohydrates: "carbs_g",
  total_fat: "fat_g",
  active_energy: "active_kcal",
  basal_energy_burned: "basal_kcal",
  step_count: "steps",
};

/** Latest sample on that calendar day wins. */
export const LATEST_METRICS = {
  weight_body_mass: "weight",
  body_fat_percentage: "body_fat_pct",
};

export const ENERGY_METRICS = new Set([
  "dietary_energy",
  "active_energy",
  "basal_energy_burned",
]);

export const SUMMARY_FIELDS = [
  "date",
  "dietary_kcal",
  "protein_g",
  "carbs_g",
  "fat_g",
  "active_kcal",
  "basal_kcal",
  "steps",
  "weight",
  "body_fat_pct",
  "workouts",
];
