/**
 * Plan: free tier; upgrade when a real limit is hit.
 * D1's free daily row limits reset at 00:00 UTC. This module does not count
 * writes in the isolate and does not sample CPU. Workers timers do not measure CPU.
 *
 * Documented errors (Cloudflare D1, "Debug D1" and the 2026-09-01 changelog):
 * - Your account has exceeded D1's free tier daily row write limit.
 * - Your account has exceeded D1's free tier daily row read limit.
 * https://developers.cloudflare.com/d1/observability/debug-d1/
 * https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/
 */

export const FREE_TIER_PLAN = "free tier; upgrade when a real limit is hit";

const WRITE_LIMIT = "exceeded D1's free tier daily row write limit";
const READ_LIMIT = "exceeded D1's free tier daily row read limit";

export function d1DailyLimitKind(error) {
  const parts = [];
  let current = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (typeof current === "string") parts.push(current);
    else if (current.message) parts.push(String(current.message));
    current = current.cause;
  }
  const message = parts.join("\n");
  if (message.includes(WRITE_LIMIT)) return "d1_rows_written";
  if (message.includes(READ_LIMIT)) return "d1_rows_read";
  return null;
}

export class D1DailyLimitError extends Error {
  constructor(limit) {
    super("d1 daily limit");
    this.name = "D1DailyLimitError";
    this.code = "D1_DAILY_LIMIT";
    this.limit = limit;
  }
}

/** Whole seconds until the next 00:00 UTC. The value does not depend on the host zone. */
export function secondsUntilNextUtcMidnight(now = new Date()) {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

export function limitNearRecord(names) {
  return { limit_near: names, plan: FREE_TIER_PLAN };
}

export function limitHitRecord(limit) {
  return { limit_hit: limit, plan: FREE_TIER_PLAN };
}

export function dailyLimitResponse(limit, now = new Date(), log = (line) => console.log(line)) {
  const record = limitHitRecord(limit);
  log(JSON.stringify(record));
  return new Response(JSON.stringify({ error: "daily_limit", limit_hit: limit }), {
    status: 429,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "retry-after": String(secondsUntilNextUtcMidnight(now)),
    },
  });
}
