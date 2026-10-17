import { shouldStoreRaw } from "./aggregate.js";
import { countNewDays, hintAction, partitionIngest, withExportHint } from "./ingest-guard.js";
import { summarizeDay } from "./summary.js";

/**
 * In-memory storage used by tests and local experiments. It is not persistent:
 * the process keeps the import window, and a new process starts with no row
 * and no stored data. The next stored point can open a window. A restart does
 * not keep a closed window.
 *
 * In-memory storage used by tests and as the reference for the storage interface.
 *
 * insertIngest({ id, date, receivedAt, bytes, payload, storeRaw, points, workouts })
 * queryDaySummary(date) -> the GET /summary object
 * queryMetricRange(metric, startDate, endDate) -> daily rows in that inclusive span
 * listMetrics() -> stored metric names
 * listWorkouts(startDate, endDate) -> workouts in that inclusive span
 *
 * `points` are already one row per (metric, date). A later insert replaces
 * that row only when its `n` is greater than or equal to the stored `n`.
 * A row whose stored values already match is left unwritten.
 * Workouts stay one row per (name, start). Raw bodies are stored only when
 * `shouldStoreRaw` allows it.
 */
export class MemoryStorage {
  constructor() {
    this.payloads = [];
    this.points = new Map();
    this.workouts = new Map();
    this.quota = new Map();
    this.exportHint = null;
    this.backfill = null;
    this.backfillLock = Promise.resolve();
  }

  async withBackfillLock(fn) {
    const previous = this.backfillLock;
    let release;
    this.backfillLock = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  readIngestBackfill() {
    return this.backfill ? { ...this.backfill } : null;
  }

  hasStoredData() {
    return this.points.size > 0 || this.workouts.size > 0 || this.payloads.length > 0;
  }

  _countDays(points, workouts) {
    const stored = {
      points: [...this.points.values()],
      workouts: [...this.workouts.values()],
    };
    return countNewDays(points, workouts, stored);
  }

  _applyReserve({ openedAt, closeAt = null, addBytes = 0, addDays = 0, totalBytes, deadline, nowIso }) {
    if (!this.backfill) {
      if (addBytes > totalBytes) return null;
      const closed = closeAt || (addBytes >= totalBytes ? nowIso : null);
      this.backfill = {
        opened_at: openedAt,
        closed_at: closed,
        bytes: addBytes,
        days: addDays,
        deadline,
        total_bytes: totalBytes,
      };
      return { ...this.backfill };
    }
    if (this.backfill.closed_at) return null;
    if (!(nowIso < this.backfill.deadline)) return null;
    if (this.backfill.bytes + addBytes > this.backfill.total_bytes) return null;
    this.backfill.bytes += addBytes;
    this.backfill.days += addDays;
    if (closeAt) this.backfill.closed_at = closeAt;
    else if (this.backfill.bytes >= this.backfill.total_bytes) this.backfill.closed_at = nowIso;
    return { ...this.backfill };
  }

  async reserveIngestBackfill(args) {
    return this.withBackfillLock(async () => {
      const addDays = this._countDays(args.points, args.workouts);
      const snapshot = this.backfill ? { ...this.backfill } : null;
      const row = this._applyReserve({ ...args, addDays });
      if (!row) return null;
      try {
        if (args.write) await args.write();
      } catch (error) {
        this.backfill = snapshot;
        throw error;
      }
      return { ...this.backfill };
    });
  }

  async finishIngestBackfill({ openedAt, closedAt, addBytes = 0, addDays = 0, deadline, totalBytes = 0 }) {
    return this.withBackfillLock(async () => {
      if (!this.backfill) {
        this.backfill = {
          opened_at: openedAt,
          closed_at: closedAt,
          bytes: addBytes,
          days: addDays,
          deadline: deadline || closedAt,
          total_bytes: totalBytes,
        };
        return { ...this.backfill };
      }
      if (!this.backfill.closed_at) {
        this.backfill.closed_at = closedAt;
        this.backfill.bytes += addBytes;
        this.backfill.days += addDays;
      }
      return { ...this.backfill };
    });
  }

  async closeIngestBackfill(closedAt) {
    return this.withBackfillLock(async () => {
      if (!this.backfill) return null;
      if (!this.backfill.closed_at) this.backfill.closed_at = closedAt;
      return { ...this.backfill };
    });
  }

  async claimIngestQuota(tokenKey, windowStart, limit) {
    const key = `${tokenKey}\0${windowStart}`;
    const hits = this.quota.get(key) ?? 0;
    if (hits >= limit) return null;
    const next = hits + 1;
    this.quota.set(key, next);
    return next;
  }

  async readExportHint() {
    return this.exportHint;
  }

  async setExportHint(hint) {
    const action = hintAction(this.exportHint, hint);
    if (action === "skip") return false;
    this.exportHint = action === "clear" ? null : hint;
    return true;
  }

  async insertIngest(batch, options = {}) {
    if (shouldStoreRaw(batch)) {
      this.payloads.push({
        id: batch.id,
        date: batch.date,
        received_at: batch.receivedAt,
        bytes: batch.bytes,
        payload: batch.payload,
      });
    }
    const stored = {
      points: [...this.points.values()],
      workouts: [...this.workouts.values()],
    };
    const diff = partitionIngest(batch.points, batch.workouts, stored);
    const newDays = countNewDays(batch.points, batch.workouts, stored);
    for (const point of diff.points) {
      const { replace, ...stored } = point;
      this.points.set(`${point.date}\0${point.metric}`, stored);
    }
    for (const workout of diff.workouts) {
      const { insertOnly, ...stored } = workout;
      this.workouts.set(`${workout.name}\0${workout.start}`, stored);
    }
    const action = hintAction(this.exportHint, options.hint);
    if (action === "clear") this.exportHint = null;
    if (action === "set") this.exportHint = options.hint;
    return { written: diff.written, unchanged: diff.unchanged, newDays };
  }

  async queryDaySummary(date) {
    const points = [...this.points.values()].filter((point) => point.date === date);
    const workouts = [...this.workouts.values()].filter((workout) => workout.date === date);
    return withExportHint(summarizeDay(date, points, workouts), this.exportHint);
  }

  async queryMetricRange(metric, startDate, endDate) {
    return [...this.points.values()]
      .filter((point) => point.metric === metric && point.date >= startDate && point.date <= endDate)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
      .map((point) => ({ ...point }));
  }

  async listMetrics() {
    return [...new Set([...this.points.values()].map((point) => point.metric))].sort();
  }

  async listWorkouts(startDate, endDate) {
    return [...this.workouts.values()]
      .filter((workout) => workout.date >= startDate && workout.date <= endDate)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
      .map((workout) => ({ ...workout }));
  }
}
