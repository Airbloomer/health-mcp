import { activeUrlToken } from "../core/auth.js";
import { noteWorkerCpu, onWorkersRuntime } from "../core/free-tier.js";
import { handleRequest } from "../core/http.js";
import { D1Storage } from "./d1.js";

export default {
  async fetch(request, env) {
    const started = typeof performance !== "undefined" ? performance.now() : 0;
    try {
      return await handleRequest(request, {
        token: env?.HEALTH_INGEST_TOKEN,
        urlToken: activeUrlToken(env?.HEALTH_INGEST_URL_TOKEN, env?.HEALTH_INGEST_TOKEN),
        timeZone: env?.HEALTH_TIMEZONE,
        storeRaw: env?.HEALTH_STORE_RAW,
        metricAllowlist: env?.HEALTH_METRIC_ALLOWLIST,
        sourcePriority: env?.HEALTH_SOURCE_PRIORITY,
        shortcutsSourcePriority: env?.HEALTH_SHORTCUTS_SOURCE_PRIORITY,
        mcpAllowedOrigins: env?.MCP_ALLOWED_ORIGINS,
        storage: new D1Storage(env?.DB),
      });
    } finally {
      if (onWorkersRuntime()) noteWorkerCpu(performance.now() - started);
    }
  },
};
