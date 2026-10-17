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

export const POINTS_BETWEEN =
  "SELECT date, metric, sum_qty, last_qty, last_ts, units, n FROM points_daily WHERE date >= ? AND date <= ?";

/** Points for an explicit date list. `?` is a JSON array of YYYY-MM-DD strings. */
export const POINTS_ON_DATES =
  "SELECT date, metric, sum_qty, last_qty, last_ts, units, n FROM points_daily " +
  "WHERE date IN (SELECT value FROM json_each(?))";

/** Workouts for an explicit date list. `?` is a JSON array of YYYY-MM-DD strings. */
export const WORKOUTS_ON_DATES =
  "SELECT name, start, date, duration_min, kcal FROM workouts " +
  "WHERE date IN (SELECT value FROM json_each(?))";

/** One statement for many guarded point rows. `?` is a JSON array. */
export const UPSERT_POINTS_JSON =
  "INSERT INTO points_daily (date, metric, sum_qty, last_qty, last_ts, units, n) " +
  "SELECT json_extract(value, '$.d'), json_extract(value, '$.m'), json_extract(value, '$.s'), " +
  "json_extract(value, '$.q'), json_extract(value, '$.t'), json_extract(value, '$.u'), json_extract(value, '$.n') " +
  "FROM json_each(?) WHERE true " +
  "ON CONFLICT(date, metric) DO UPDATE SET sum_qty = excluded.sum_qty, last_qty = excluded.last_qty, " +
  "last_ts = excluded.last_ts, units = excluded.units, n = excluded.n " +
  "WHERE excluded.n >= points_daily.n";

/** One statement for many whole-day replacements. */
export const REPLACE_POINTS_JSON =
  "INSERT INTO points_daily (date, metric, sum_qty, last_qty, last_ts, units, n) " +
  "SELECT json_extract(value, '$.d'), json_extract(value, '$.m'), json_extract(value, '$.s'), " +
  "json_extract(value, '$.q'), json_extract(value, '$.t'), json_extract(value, '$.u'), json_extract(value, '$.n') " +
  "FROM json_each(?) WHERE true " +
  "ON CONFLICT(date, metric) DO UPDATE SET sum_qty = excluded.sum_qty, last_qty = excluded.last_qty, " +
  "last_ts = excluded.last_ts, units = excluded.units, n = excluded.n";

export const UPSERT_WORKOUTS_JSON =
  "INSERT INTO workouts (name, start, date, duration_min, kcal) " +
  "SELECT json_extract(value, '$.n'), json_extract(value, '$.s'), json_extract(value, '$.d'), " +
  "json_extract(value, '$.m'), json_extract(value, '$.k') " +
  "FROM json_each(?) WHERE true " +
  "ON CONFLICT(name, start) DO UPDATE SET date = excluded.date, duration_min = excluded.duration_min, kcal = excluded.kcal";

export const INSERT_WORKOUTS_JSON =
  "INSERT INTO workouts (name, start, date, duration_min, kcal) " +
  "SELECT json_extract(value, '$.n'), json_extract(value, '$.s'), json_extract(value, '$.d'), " +
  "json_extract(value, '$.m'), json_extract(value, '$.k') " +
  "FROM json_each(?) WHERE true " +
  "ON CONFLICT(name, start) DO NOTHING";

export const HAS_STORED_DATA =
  "SELECT 1 AS ok FROM points_daily UNION ALL SELECT 1 FROM workouts UNION ALL SELECT 1 FROM raw_payloads LIMIT 1";

export const WORKOUTS_FOR_DATE =
  "SELECT name, start, date, duration_min, kcal FROM workouts WHERE date = ? ORDER BY start";

export const METRIC_RANGE =
  "SELECT date, metric, sum_qty, last_qty, last_ts, units, n FROM points_daily WHERE metric = ? AND date >= ? AND date <= ? ORDER BY date";

export const LIST_METRICS =
  "SELECT metric FROM points_daily GROUP BY metric ORDER BY metric";

export const WORKOUTS_RANGE =
  "SELECT name, start, date, duration_min, kcal FROM workouts WHERE date >= ? AND date <= ? ORDER BY date, start, name";

/** Increment the hour only while it is still under the limit, and return the new count. */
export const CLAIM_QUOTA =
  "INSERT INTO ingest_quota (token_key, window_start, hits) VALUES (?, ?, 1) " +
  "ON CONFLICT(token_key, window_start) DO UPDATE SET hits = ingest_quota.hits + 1 " +
  "WHERE ingest_quota.hits < ? " +
  "RETURNING hits";

export const READ_HINT = "SELECT hint FROM export_hint WHERE id = 1";

export const UPSERT_HINT =
  "INSERT INTO export_hint (id, hint) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET hint = excluded.hint";

export const DELETE_HINT = "DELETE FROM export_hint WHERE id = 1";

export const READ_BACKFILL =
  "SELECT opened_at, closed_at, bytes, days, deadline, total_bytes FROM ingest_backfill WHERE id = 1";

/**
 * Insert the window or add bytes, and only while it is still open, under its
 * stored total, and before its stored deadline. `closed_at` is set in this
 * statement when the caller closes it or the stored total is reached.
 * A failed WHERE returns no row.
 */
export const RESERVE_BACKFILL =
  "INSERT INTO ingest_backfill (id, opened_at, closed_at, bytes, days, deadline, total_bytes) " +
  "VALUES (1, ?, ?, ?, ?, ?, ?) " +
  "ON CONFLICT(id) DO UPDATE SET " +
  "bytes = ingest_backfill.bytes + excluded.bytes, " +
  "days = ingest_backfill.days + excluded.days, " +
  "deadline = COALESCE(ingest_backfill.deadline, excluded.deadline), " +
  "total_bytes = COALESCE(ingest_backfill.total_bytes, excluded.total_bytes), " +
  "closed_at = CASE " +
  "WHEN excluded.closed_at IS NOT NULL THEN excluded.closed_at " +
  "WHEN ingest_backfill.bytes + excluded.bytes >= COALESCE(ingest_backfill.total_bytes, excluded.total_bytes) THEN ? " +
  "ELSE ingest_backfill.closed_at END " +
  "WHERE ingest_backfill.closed_at IS NULL " +
  "AND ingest_backfill.bytes + excluded.bytes <= COALESCE(ingest_backfill.total_bytes, excluded.total_bytes) " +
  "AND ? < COALESCE(ingest_backfill.deadline, excluded.deadline) " +
  "RETURNING opened_at, closed_at, bytes, days, deadline, total_bytes";

/**
 * Subtract the bytes and days for groups that were never stored.
 * This never clears `closed_at`. A failed write that filled the window
 * leaves the window closed, which is safer than reopening it.
 */
export const RELEASE_BACKFILL =
  "UPDATE ingest_backfill SET " +
  "bytes = bytes - ?, " +
  "days = CASE WHEN days >= ? THEN days - ? ELSE 0 END " +
  "WHERE id = 1 AND bytes >= ?";

/**
 * Drop a window that this failed request created and then fully released.
 * A closed row is kept, including a close this request caused.
 */
export const DELETE_EMPTY_BACKFILL =
  "DELETE FROM ingest_backfill WHERE id = 1 AND bytes = 0 AND days = 0 AND closed_at IS NULL";

/**
 * Create a closed window when stored rows exist and no row does.
 * A row that appeared in the meantime is left as it is, including an open one.
 */
export const SEAL_BACKFILL_IF_MISSING =
  "INSERT INTO ingest_backfill (id, opened_at, closed_at, bytes, days, deadline, total_bytes) " +
  "VALUES (1, ?, ?, ?, ?, ?, ?) " +
  "ON CONFLICT(id) DO NOTHING";

/** Close the window, creating a closed row when none exists. Already closed is unchanged. */
export const FINISH_BACKFILL =
  "INSERT INTO ingest_backfill (id, opened_at, closed_at, bytes, days, deadline, total_bytes) " +
  "VALUES (1, ?, ?, ?, ?, ?, ?) " +
  "ON CONFLICT(id) DO UPDATE SET " +
  "bytes = ingest_backfill.bytes + excluded.bytes, " +
  "days = ingest_backfill.days + excluded.days, " +
  "closed_at = COALESCE(ingest_backfill.closed_at, excluded.closed_at) " +
  "WHERE ingest_backfill.closed_at IS NULL " +
  "RETURNING opened_at, closed_at, bytes, days, deadline, total_bytes";

/** Mark the window closed. A row that is already closed is left as it is. */
export const CLOSE_BACKFILL =
  "UPDATE ingest_backfill SET closed_at = ? WHERE id = 1 AND closed_at IS NULL " +
  "RETURNING opened_at, closed_at, bytes, days, deadline, total_bytes";

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
