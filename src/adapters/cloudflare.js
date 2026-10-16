import { handleRequest } from "../core/http.js";
import { D1Storage } from "./d1.js";

export default {
  async fetch(request, env) {
    return handleRequest(request, {
      token: env?.HEALTH_INGEST_TOKEN,
      urlToken: env?.HEALTH_INGEST_URL_TOKEN,
      timeZone: env?.HEALTH_TIMEZONE,
      storeRaw: env?.HEALTH_STORE_RAW,
      metricAllowlist: env?.HEALTH_METRIC_ALLOWLIST,
      sourcePriority: env?.HEALTH_SOURCE_PRIORITY,
      mcpAllowedOrigins: env?.MCP_ALLOWED_ORIGINS,
      storage: new D1Storage(env?.DB),
    });
  },
};
