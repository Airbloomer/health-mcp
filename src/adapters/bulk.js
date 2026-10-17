export { ingestWriteChunks, jsonChunks, pointJson, workoutJson } from "../core/bulk.js";

export function dateSpan(dates) {
  if (!dates.length) return null;
  let start = dates[0];
  let end = dates[0];
  for (const date of dates) {
    if (date < start) start = date;
    if (date > end) end = date;
  }
  return [start, end];
}
