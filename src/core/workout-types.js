/**
 * Match-only type map. Stored names are never rewritten.
 * `functional_strength_training` is unverified against a real export.
 * Indoor and outdoor are not part of the key.
 */
const MATCH_KEYS = new Map([
  ["traditional_strength_training", "strength_training"],
  ["strength_training", "strength_training"],
  ["functional_strength_training", "strength_training"],
  ["running", "running"],
  ["running_treadmill", "running"],
  ["walking", "walking"],
]);

export function workoutMatchKey(name) {
  const key = String(name ?? "").toLowerCase().replace(/[\s-]+/g, "_");
  return MATCH_KEYS.get(key) || key;
}
