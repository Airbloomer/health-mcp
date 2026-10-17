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

/**
 * The JSON texts `insertIngest` sends for rows that are actually written.
 * One statement per chunk, for each of the four write lists.
 */
export function ingestWriteChunks(points, workouts) {
  const replacePoints = [];
  const guardPoints = [];
  for (const point of points || []) {
    (point.replace ? replacePoints : guardPoints).push(pointJson(point));
  }
  const insertOnly = [];
  const upserts = [];
  for (const workout of workouts || []) {
    (workout.insertOnly ? insertOnly : upserts).push(workoutJson(workout));
  }
  return {
    replacePoints: jsonChunks(replacePoints),
    guardPoints: jsonChunks(guardPoints),
    insertOnly: jsonChunks(insertOnly),
    upserts: jsonChunks(upserts),
  };
}
