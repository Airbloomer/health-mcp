/** Split row arrays into JSON texts small enough for one statement. */
const JSON_CHUNK_CHARS = 60_000;

export function jsonChunks(rows) {
  const chunks = [];
  let batch = [];
  let size = 2;
  for (const row of rows) {
    const encoded = JSON.stringify(row);
    const next = size + encoded.length + (batch.length ? 1 : 0);
    if (batch.length && next > JSON_CHUNK_CHARS) {
      chunks.push(JSON.stringify(batch));
      batch = [];
      size = 2;
    }
    batch.push(row);
    size += encoded.length + (batch.length > 1 ? 1 : 0);
  }
  if (batch.length) chunks.push(JSON.stringify(batch));
  return chunks;
}

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

export function pointJson(point) {
  return {
    d: point.date,
    m: point.metric,
    s: point.sum_qty,
    q: point.last_qty,
    t: point.last_ts,
    u: point.units,
    n: point.n,
  };
}

export function workoutJson(workout) {
  return {
    n: workout.name,
    s: workout.start,
    d: workout.date,
    m: workout.duration_min,
    k: workout.kcal,
  };
}
