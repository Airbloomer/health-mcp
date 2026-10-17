/** Portable SQL shared by D1, SQLite, and Postgres. `?` placeholders; Postgres rewrites them. */

export const INSERT_RAW =
  "INSERT INTO raw_payloads (id, date, received_at, bytes, payload) VALUES (?, ?, ?, ?, ?)";

export const UPSERT_POINT =
  "INSERT INTO points_daily (date, metric, sum_qty, last_qty, last_ts, units, n) VALUES (?, ?, ?, ?, ?, ?, ?) " +
  "ON CONFLICT(date, metric) DO UPDATE SET sum_qty = excluded.sum_qty, last_qty = excluded.last_qty, " +
  "last_ts = excluded.last_ts, units = excluded.units, n = excluded.n " +
  "WHERE excluded.n >= points_daily.n";

/** Unconditional day replace, used by sources that send whole-day values (iOS Shortcuts). */
export const REPLACE_POINT =
  "INSERT INTO points_daily (date, metric, sum_qty, last_qty, last_ts, units, n) VALUES (?, ?, ?, ?, ?, ?, ?) " +
  "ON CONFLICT(date, metric) DO UPDATE SET sum_qty = excluded.sum_qty, last_qty = excluded.last_qty, " +
  "last_ts = excluded.last_ts, units = excluded.units, n = excluded.n";

/** Insert-only workout, used for URL-token requests: an existing workout is never changed. */
export const INSERT_WORKOUT_IF_NEW =
  "INSERT INTO workouts (name, start, date, duration_min, kcal) VALUES (?, ?, ?, ?, ?) " +
  "ON CONFLICT(name, start) DO NOTHING";

export const UPSERT_WORKOUT =
  "INSERT INTO workouts (name, start, date, duration_min, kcal) VALUES (?, ?, ?, ?, ?) " +
  "ON CONFLICT(name, start) DO UPDATE SET date = excluded.date, duration_min = excluded.duration_min, kcal = excluded.kcal";

export const POINTS_FOR_DATE =
  "SELECT date, metric, sum_qty, last_qty, last_ts, units, n FROM points_daily WHERE date = ?";

export const WORKOUTS_FOR_DATE =
  "SELECT name, start, date, duration_min, kcal FROM workouts WHERE date = ? ORDER BY start";

export const METRIC_RANGE =
  "SELECT date, metric, sum_qty, last_qty, last_ts, units, n FROM points_daily WHERE metric = ? AND date >= ? AND date <= ? ORDER BY date";

export const LIST_METRICS =
  "SELECT metric FROM points_daily GROUP BY metric ORDER BY metric";

export const WORKOUTS_RANGE =
  "SELECT name, start, date, duration_min, kcal FROM workouts WHERE date >= ? AND date <= ? ORDER BY date, start, name";

export const READ_QUOTA =
  "SELECT hits FROM ingest_quota WHERE token_key = ? AND window_start = ?";

export const UPSERT_QUOTA =
  "INSERT INTO ingest_quota (token_key, window_start, hits) VALUES (?, ?, 1) " +
  "ON CONFLICT(token_key, window_start) DO UPDATE SET hits = hits + 1";

export const READ_HINT = "SELECT hint FROM export_hint WHERE id = 1";

export const UPSERT_HINT =
  "INSERT INTO export_hint (id, hint) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET hint = excluded.hint";

export const DELETE_HINT = "DELETE FROM export_hint WHERE id = 1";

/** D1 rejects batches larger than this. */
export const D1_BATCH_LIMIT = 500;

export function splitStatements(sql) {
  return sql
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.replace(/--[^\n]*/g, "").trim().length > 0);
}

/** Rewrite `?` placeholders to `$1`, `$2`, ... for node-postgres. */
export function toPostgres(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}
