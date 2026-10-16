import { activeUrlToken } from "../core/auth.js";
import { dailyLimitResponse } from "../core/free-tier.js";
import { handleRequest, json } from "../core/http.js";
import { resolveLimitsProfile } from "../core/limits.js";
import { D1Storage } from "./d1.js";

let loggedNodeProfile = false;

export function resetCloudflareProfileLog() {
  loggedNodeProfile = false;
}

export function cloudflareMisconfigured() {
  console.error(JSON.stringify({ limit_profile_invalid: true }));
  return json({ error: "misconfigured" }, 503);
}

export default {
  async fetch(request, env) {
    const resolved = resolveLimitsProfile(env?.HEALTH_LIMITS_PROFILE, "cloudflare");
    if (resolved.invalid) return cloudflareMisconfigured();
    if (resolved.explicitNode && !loggedNodeProfile) {
      loggedNodeProfile = true;
      console.log(JSON.stringify({ limit_profile: "node" }));
    }
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
        limitsProfile: resolved.profile,
        adapter: "cloudflare",
        storage: new D1Storage(env?.DB, { timeZone: env?.HEALTH_TIMEZONE }),
      });
    } catch (error) {
      if (error?.code === "D1_DAILY_LIMIT") return dailyLimitResponse(error.limit);
      throw error;
    }
  },
};
