import { shouldStoreRaw } from "./aggregate.js";
import { summarizeDay } from "./summary.js";

/**
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
 * Workouts stay one row per (name, start). Raw bodies are stored only when
 * `shouldStoreRaw` allows it.
 */
export class MemoryStorage {
  constructor() {
    this.payloads = [];
    this.points = new Map();
    this.workouts = new Map();
  }

  async insertIngest(batch) {
    if (shouldStoreRaw(batch)) {
      this.payloads.push({
        id: batch.id,
        date: batch.date,
        received_at: batch.receivedAt,
        bytes: batch.bytes,
        payload: batch.payload,
      });
    }
    for (const point of batch.points) {
      const key = `${point.date}\0${point.metric}`;
      const prev = this.points.get(key);
      if (prev && !point.replace && !(point.n >= prev.n)) continue;
      const { replace, ...stored } = point;
      this.points.set(key, stored);
    }
    for (const workout of batch.workouts) {
      this.workouts.set(`${workout.name}\0${workout.start}`, { ...workout });
    }
  }

  async queryDaySummary(date) {
    const points = [...this.points.values()].filter((point) => point.date === date);
    const workouts = [...this.workouts.values()].filter((workout) => workout.date === date);
    return summarizeDay(date, points, workouts);
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
