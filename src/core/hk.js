import { ENERGY_METRICS } from "./metrics.js";

export const HK_QUANTITY_PREFIX = "HKQuantityTypeIdentifier";
export const HK_WORKOUT_PREFIX = "HKWorkoutActivityType";

/** Summary metrics. Other quantity types use snake_case so an allowlist can name them. */
export const HK_QUANTITY_METRICS = Object.freeze({
  DietaryEnergyConsumed: "dietary_energy",
  DietaryProtein: "protein",
  DietaryCarbohydrates: "carbohydrates",
  DietaryFatTotal: "total_fat",
  ActiveEnergyBurned: "active_energy",
  BasalEnergyBurned: "basal_energy_burned",
  StepCount: "step_count",
  BodyMass: "weight_body_mass",
  BodyFatPercentage: "body_fat_percentage",
});

/**
 * HKWorkoutActivityType raw values. Health Export Pro sends these integers.
 * 81 is unused in HealthKit. Names are the identifier suffix.
 */
export const HK_WORKOUT_ACTIVITY_NAMES = Object.freeze({
  1: "AmericanFootball",
  2: "Archery",
  3: "AustralianFootball",
  4: "Badminton",
  5: "Baseball",
  6: "Basketball",
  7: "Bowling",
  8: "Boxing",
  9: "Climbing",
  10: "Cricket",
  11: "CrossTraining",
  12: "Curling",
  13: "Cycling",
  14: "Dance",
  15: "DanceInspiredTraining",
  16: "Elliptical",
  17: "EquestrianSports",
  18: "Fencing",
  19: "Fishing",
  20: "FunctionalStrengthTraining",
  21: "Golf",
  22: "Gymnastics",
  23: "Handball",
  24: "Hiking",
  25: "Hockey",
  26: "Hunting",
  27: "Lacrosse",
  28: "MartialArts",
  29: "MindAndBody",
  30: "MixedMetabolicCardioTraining",
  31: "PaddleSports",
  32: "Play",
  33: "PreparationAndRecovery",
  34: "Racquetball",
  35: "Rowing",
  36: "Rugby",
  37: "Running",
  38: "Sailing",
  39: "SkatingSports",
  40: "SnowSports",
  41: "Soccer",
  42: "Softball",
  43: "Squash",
  44: "StairClimbing",
  45: "SurfingSports",
  46: "Swimming",
  47: "TableTennis",
  48: "Tennis",
  49: "TrackAndField",
  50: "TraditionalStrengthTraining",
  51: "Volleyball",
  52: "Walking",
  53: "WaterFitness",
  54: "WaterPolo",
  55: "WaterSports",
  56: "Wrestling",
  57: "Yoga",
  58: "Barre",
  59: "CoreTraining",
  60: "CrossCountrySkiing",
  61: "DownhillSkiing",
  62: "Flexibility",
  63: "HighIntensityIntervalTraining",
  64: "JumpRope",
  65: "Kickboxing",
  66: "Pilates",
  67: "Snowboarding",
  68: "Stairs",
  69: "StepTraining",
  70: "WheelchairWalkPace",
  71: "WheelchairRunPace",
  72: "TaiChi",
  73: "MixedCardio",
  74: "HandCycling",
  75: "DiscSports",
  76: "FitnessGaming",
  77: "CardioDance",
  78: "SocialDance",
  79: "Pickleball",
  80: "Cooldown",
  82: "SwimBikeRun",
  83: "Transition",
  84: "UnderwaterDiving",
  3000: "Other",
});

export function snakeCaseIdentifier(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

export function wordsFromIdentifier(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .trim();
}

/** Metric name for an HKQuantityTypeIdentifier, or null when `type` is not one. */
export function hkQuantityMetric(type) {
  const text = String(type || "");
  if (!text.startsWith(HK_QUANTITY_PREFIX)) return null;
  const name = text.slice(HK_QUANTITY_PREFIX.length);
  if (!name) return null;
  return HK_QUANTITY_METRICS[name] || snakeCaseIdentifier(name);
}

/**
 * Display name for a workout activity. Accepts an HKWorkoutActivityType
 * string or the integer raw value Health Export Pro sends.
 */
export function hkWorkoutName(type) {
  if (typeof type === "number" && Number.isFinite(type)) {
    const suffix = HK_WORKOUT_ACTIVITY_NAMES[type];
    return suffix ? wordsFromIdentifier(suffix) : `Workout ${type}`;
  }
  const text = String(type ?? "").trim();
  if (/^\d+$/.test(text)) return hkWorkoutName(Number(text));
  const name = text.startsWith(HK_WORKOUT_PREFIX) ? text.slice(HK_WORKOUT_PREFIX.length) : text;
  return wordsFromIdentifier(name) || "Workout";
}

export function toKcal(qty, units) {
  return units && /^kj$/i.test(String(units).trim()) ? qty / 4.184 : qty;
}

/** Store energy metrics as kcal. `units` is kept for everything else. */
export function quantitySample(metric, qty, units) {
  if (!Number.isFinite(qty)) return null;
  if (ENERGY_METRICS.has(metric)) return { qty: toKcal(qty, units), units: "kcal" };
  return { qty, units: units == null || units === "" ? null : String(units) };
}

/** One decimal minute, matching Health Auto Export duration handling. */
export function durationMinutesFromSeconds(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return null;
  return Math.round(seconds / 6) / 10;
}
