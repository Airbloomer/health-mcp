/**
 * Pilot plan: free tier; upgrade when a real limit is hit.
 * Workers free CPU is 10 ms per invocation. D1 free writes are 100,000 rows per UTC day.
 * A request that would pass the D1 cap is not written. Signals log once per limit per UTC day.
 */

export const FREE_TIER_PLAN = "free tier; upgrade when a real limit is hit";
export const FREE_TIER_CPU_MS = 10;
export const FREE_TIER_D1_WRITES_PER_DAY = 100_000;
export const FREE_TIER_APPROACH_RATIO = 0.8;

export function onWorkersRuntime() {
  return typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";
}

export function limitSignal({ limit, used, cap }) {
  if (!(cap > 0) || !(used >= cap * FREE_TIER_APPROACH_RATIO)) return null;
  return {
    signal: used >= cap ? "limit_reached" : "limit_approaching",
    limit,
    used,
    cap,
    plan: FREE_TIER_PLAN,
  };
}

function utcDay(now) {
  return new Date(now).toISOString().slice(0, 10);
}

export function createFreeTierBudget(options = {}) {
  const d1Cap = options.d1WritesPerDay ?? FREE_TIER_D1_WRITES_PER_DAY;
  const cpuCap = options.cpuMs ?? FREE_TIER_CPU_MS;
  const log = options.log ?? ((line) => console.log(line));
  const now = options.now ?? (() => new Date());
  let day = utcDay(now());
  let writes = 0;
  const logged = new Set();

  function roll() {
    const today = utcDay(now());
    if (today === day) return;
    day = today;
    writes = 0;
    logged.clear();
  }

  function logOnce(signal) {
    const key = `${day}:${signal.limit}:${signal.signal}`;
    if (logged.has(key)) return;
    logged.add(key);
    log(JSON.stringify(signal));
  }

  return {
    allowD1Writes(requested) {
      roll();
      const count = Math.floor(Number(requested));
      if (!Number.isFinite(count) || count <= 0) return 0;
      if (writes + count > d1Cap) {
        logOnce({
          signal: "limit_reached",
          limit: "d1_rows_written",
          used: writes,
          cap: d1Cap,
          plan: FREE_TIER_PLAN,
        });
        return 0;
      }
      writes += count;
      const signal = limitSignal({ limit: "d1_rows_written", used: writes, cap: d1Cap });
      if (signal) logOnce(signal);
      return count;
    },
    noteWorkerCpu(elapsedMs) {
      roll();
      const used = Number(elapsedMs);
      if (!Number.isFinite(used) || used < 0) return;
      const signal = limitSignal({ limit: "worker_cpu_ms", used, cap: cpuCap });
      if (signal) logOnce(signal);
    },
  };
}

const shared = createFreeTierBudget();

export function allowD1Writes(count) {
  return shared.allowD1Writes(count);
}

export function noteWorkerCpu(elapsedMs) {
  shared.noteWorkerCpu(elapsedMs);
}
