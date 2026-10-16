-- One row per metric and calendar day. The legacy per-sample `points` table is
-- left in place: deleting it would count as a row write for every old sample.
-- New reads and writes use `points_daily`. Drop `points` later, after the
-- daily write budget has room.
CREATE TABLE IF NOT EXISTS points_daily (
  date TEXT NOT NULL,
  metric TEXT NOT NULL,
  sum_qty REAL NOT NULL,
  last_qty REAL,
  last_ts TEXT,
  units TEXT,
  n INTEGER NOT NULL,
  PRIMARY KEY (date, metric)
);

INSERT INTO points_daily (date, metric, sum_qty, last_qty, last_ts, units, n)
SELECT s.date,
       s.metric,
       SUM(s.qty),
       (SELECT s2.qty FROM points s2 WHERE s2.metric = s.metric AND s2.date = s.date ORDER BY s2.ts DESC LIMIT 1),
       (SELECT s2.ts FROM points s2 WHERE s2.metric = s.metric AND s2.date = s.date ORDER BY s2.ts DESC LIMIT 1),
       MAX(s.units),
       COUNT(*)
FROM points s
WHERE NOT EXISTS (
  SELECT 1 FROM points_daily d WHERE d.date = s.date AND d.metric = s.metric
)
GROUP BY s.metric, s.date;
