import { activeUrlToken } from "../core/auth.js";
import { dailyLimitResponse } from "../core/free-tier.js";
import { handleRequest } from "../core/http.js";
import { D1Storage } from "./d1.js";

/** Map Worker bindings onto the platform-free request context. */
export function contextFromEnv(env) {
  return {
    token: env?.HEALTH_INGEST_TOKEN,
    urlToken: activeUrlToken(env?.HEALTH_INGEST_URL_TOKEN, env?.HEALTH_INGEST_TOKEN),
    timeZone: env?.HEALTH_TIMEZONE,
    storeRaw: env?.HEALTH_STORE_RAW,
    metricAllowlist: env?.HEALTH_METRIC_ALLOWLIST,
    sourcePriority: env?.HEALTH_SOURCE_PRIORITY,
    shortcutsSourcePriority: env?.HEALTH_SHORTCUTS_SOURCE_PRIORITY,
    mcpAllowedOrigins: env?.MCP_ALLOWED_ORIGINS,
    ingestMaxAgeDays: env?.INGEST_MAX_AGE_DAYS,
    ingestMaxBodyBytes: env?.INGEST_MAX_BODY_BYTES,
    ingestRatePerHour: env?.INGEST_RATE_LIMIT_PER_HOUR,
    ingestBackfillMaxBytes: env?.INGEST_BACKFILL_MAX_BYTES,
    ingestBackfillPerHour: env?.INGEST_BACKFILL_MAX_PER_HOUR,
    ingestBackfillTotalBytes: env?.INGEST_BACKFILL_MAX_TOTAL_BYTES,
    ingestBackfillHours: env?.INGEST_BACKFILL_HOURS,
    ingestMinDate: env?.INGEST_MIN_DATE,
    ingestMaxStatements: env?.INGEST_MAX_STATEMENTS,
    storage: new D1Storage(env?.DB),
  };
}

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, contextFromEnv(env));
    } catch (error) {
      if (error?.code === "D1_DAILY_LIMIT") return dailyLimitResponse(error.limit);
      throw error;
    }
  },
};
