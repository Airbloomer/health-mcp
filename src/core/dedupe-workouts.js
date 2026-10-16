import { canonicalStart } from "./health-connect.js";
import { DEFAULT_TIME_ZONE } from "./metrics.js";
import { workoutMatchKey } from "./workout-types.js";

function num(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function durationSeconds(row) {
  const minutes = num(row.duration_min);
  return minutes == null ? null : minutes * 60;
}

export function isCanonicalStart(start, timeZone) {
  const canonical = canonicalStart(start, timeZone);
  return canonical != null && String(start) === canonical;
}

/** Non-URL first, then canonical, then longest, then highest kcal, then smallest start string. */
export function compareWorkoutWinner(a, b, timeZone = DEFAULT_TIME_ZONE) {
  const aUrl = a.writer === "url" ? 1 : 0;
  const bUrl = b.writer === "url" ? 1 : 0;
  if (aUrl !== bUrl) return aUrl - bUrl;
  const aCanon = isCanonicalStart(a.start, timeZone) ? 0 : 1;
  const bCanon = isCanonicalStart(b.start, timeZone) ? 0 : 1;
  if (aCanon !== bCanon) return aCanon - bCanon;
  const aDur = num(a.duration_min);
  const bDur = num(b.duration_min);
  if (aDur !== bDur) return (bDur ?? -Infinity) - (aDur ?? -Infinity);
  const aKcal = num(a.kcal);
  const bKcal = num(b.kcal);
  if (aKcal !== bKcal) return (bKcal ?? -Infinity) - (aKcal ?? -Infinity);
  const aStart = String(a.start ?? "");
  const bStart = String(b.start ?? "");
  if (aStart < bStart) return -1;
  if (aStart > bStart) return 1;
  return 0;
}

function matchesAnchor(anchor, row, timeZone) {
  if (workoutMatchKey(anchor.name) !== workoutMatchKey(row.name)) return false;
  if (anchor.writer === "url" && row.writer !== "url") return false;
  const aIso = canonicalStart(anchor.start, timeZone);
  const bIso = canonicalStart(row.start, timeZone);
  if (!aIso || !bIso) return false;
  const aDur = durationSeconds(anchor);
  const bDur = durationSeconds(row);
  if (aDur == null || bDur == null) return false;
  const shorter = Math.min(aDur, bDur);
  const longer = Math.max(aDur, bDur);
  const startDelta = Math.abs(Date.parse(aIso) - Date.parse(bIso)) / 1000;
  const durationDelta = Math.abs(aDur - bDur);
  if (startDelta > Math.min(120, 0.5 * shorter)) return false;
  if (durationDelta > Math.max(60, Math.min(0.02 * longer, 300))) return false;
  return true;
}

function mergedKcal(cluster) {
  const winner = cluster[0];
  const winnerKcal = num(winner.kcal);
  if (winnerKcal != null) return winnerKcal;
  for (const row of cluster.slice(1)) {
    if (row.writer === "url") continue;
    const kcal = num(row.kcal);
    if (kcal != null) return kcal;
  }
  return null;
}

function publicRow(cluster) {
  const winner = cluster[0];
  return {
    name: winner.name,
    start: winner.start,
    date: winner.date,
    duration_min: num(winner.duration_min),
    kcal: mergedKcal(cluster),
  };
}

/**
 * Anchor clustering. Rows are compared only with the anchor, never with each other.
 * Reads do not modify the input rows.
 */
export function dedupeWorkouts(rows, timeZone = DEFAULT_TIME_ZONE) {
  const sorted = [...(rows || [])].sort((a, b) => compareWorkoutWinner(a, b, timeZone));
  const assigned = new Set();
  const output = [];
  for (let index = 0; index < sorted.length; index += 1) {
    if (assigned.has(index)) continue;
    const anchor = sorted[index];
    const anchorIso = canonicalStart(anchor.start, timeZone);
    const cluster = [anchor];
    assigned.add(index);
    if (anchorIso) {
      for (let other = index + 1; other < sorted.length; other += 1) {
        if (assigned.has(other)) continue;
        if (!matchesAnchor(anchor, sorted[other], timeZone)) continue;
        cluster.push(sorted[other]);
        assigned.add(other);
      }
    }
    output.push(publicRow(cluster));
  }
  return output;
}

export function shiftIsoDate(iso, days) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  if (!match) return iso;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days));
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

export function workoutsForRange(rows, startDate, endDate, timeZone = DEFAULT_TIME_ZONE) {
  return dedupeWorkouts(rows, timeZone).filter((row) => row.date >= startDate && row.date <= endDate);
}
