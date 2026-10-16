CREATE TABLE IF NOT EXISTS raw_payloads (id TEXT PRIMARY KEY, date TEXT NOT NULL, received_at TEXT NOT NULL, bytes INTEGER NOT NULL, payload TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS raw_by_date ON raw_payloads(date);
CREATE TABLE IF NOT EXISTS points (metric TEXT NOT NULL, ts TEXT NOT NULL, date TEXT NOT NULL, units TEXT, qty REAL, PRIMARY KEY (metric, ts));
CREATE INDEX IF NOT EXISTS points_by_date ON points(date);
CREATE TABLE IF NOT EXISTS workouts (name TEXT NOT NULL, start TEXT NOT NULL, date TEXT NOT NULL, duration_min REAL, kcal REAL, PRIMARY KEY (name, start));
CREATE INDEX IF NOT EXISTS workouts_by_date ON workouts(date);
