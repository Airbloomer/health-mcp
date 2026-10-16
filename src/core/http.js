import { aggregateDays, shouldStoreRaw, storedMetricSet } from "./aggregate.js";
import { appleChunkError, parseAppleExport } from "./apple-export.js";
import { authed } from "./auth.js";
import { hcWebhookError, parseHcWebhook } from "./hc-webhook.js";
import { declaredContentLength, handleMcp, MCP_SERVER_NAME } from "./mcp.js";
import { DEFAULT_TIME_ZONE, MAX_APPLE_EXPORT_BYTES, MAX_PAYLOAD_CHARS } from "./metrics.js";
import { localDate } from "./parse.js";
import { parseShortcuts, shortcutDays, shortcutsError, shortcutsSourcePriority } from "./shortcuts.js";

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function ingestKind(pathname) {
  if (pathname === "/ingest/hc-webhook" || /^\/ingest\/hc-webhook\/[^/]+$/.test(pathname)) return "hc-webhook";
  if (pathname === "/ingest/shortcuts" || /^\/ingest\/shortcuts\/[^/]+$/.test(pathname)) return "shortcuts";
  return null;
}

function resolveTimeZone(value) {
  const zone = typeof value === "string" ? value.trim() : "";
  return zone || DEFAULT_TIME_ZONE;
}

function adapterOptions(ctx) {
  return {
    timeZone: resolveTimeZone(ctx.timeZone),
    now: ctx.now instanceof Date ? ctx.now : new Date(),
  };
}

/**
 * @param {Request} req
 * @param {{ token?: string, urlToken?: string, timeZone?: string, storeRaw?: boolean | string, shortcutsSourcePriority?: string, metricAllowlist?: string | string[], mcpAllowedOrigins?: string | string[], storage: { insertIngest: Function, queryDaySummary: Function, queryMetricRange: Function, listMetrics: Function, listWorkouts: Function }, now?: Date }} ctx
 */
export async function handleRequest(req, ctx) {
  const url = new URL(req.url);
  if (!authed(req, { HEALTH_INGEST_TOKEN: ctx.token, HEALTH_INGEST_URL_TOKEN: ctx.urlToken })) {
    const response = json({ error: "unauthorized" }, 401);
    if (url.pathname === "/mcp") response.headers.set("www-authenticate", `Bearer realm="${MCP_SERVER_NAME}"`);
    return response;
  }
  if (url.pathname === "/import/apple-health" && req.method === "POST") return importApple(req, ctx);
  if (url.pathname === "/import/apple-health/chunk" && req.method === "POST") return importAppleChunk(req, ctx);
  if (ingestKind(url.pathname) === "hc-webhook" && req.method === "POST") return ingestHcWebhook(req, ctx);
  if (ingestKind(url.pathname) === "shortcuts" && req.method === "POST") return ingestShortcuts(req, ctx);
  if (url.pathname === "/summary" && req.method === "GET") return summary(url, ctx.storage);
  if (url.pathname === "/mcp") return handleMcp(req, ctx);
  return json({ error: "not_found" }, 404);
}

async function storeIngest(ctx, { points, workouts, samples, bytes, payload, extra }) {
  const timeZone = resolveTimeZone(ctx.timeZone);
  const now = ctx.now instanceof Date ? ctx.now : new Date();
  const dates = [...new Set([...points.map((point) => point.date), ...workouts.map((workout) => workout.date)])].sort();
  const key = dates.length ? dates[dates.length - 1] : localDate(now.toISOString(), timeZone);
  const id = `${key}/${now.toISOString()}/${crypto.randomUUID().slice(0, 8)}`;
  const raw = { storeRaw: ctx.storeRaw, payload };
  const storeRaw = shouldStoreRaw(raw);
  await ctx.storage.insertIngest({
    id,
    date: key,
    receivedAt: now.toISOString(),
    bytes,
    payload: storeRaw ? payload : null,
    storeRaw,
    points,
    workouts,
  });
  return json({ ok: true, id, dates, points: samples, workouts: workouts.length, ...extra });
}

async function* limitBytes(stream, limit) {
  const reader = stream.getReader();
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      size += value.byteLength;
      if (size > limit) {
        const error = new Error("payload_too_large");
        error.code = "PAYLOAD_TOO_LARGE";
        await reader.cancel().catch(() => {});
        throw error;
      }
      yield value;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // cancel() already released the lock
    }
  }
}

async function acceptAppleExport(source, ctx) {
  try {
    const parsed = await parseAppleExport(source, {
      timeZone: resolveTimeZone(ctx.timeZone),
      allow: storedMetricSet(ctx.metricAllowlist),
      sourcePriority: ctx.sourcePriority,
    });
    return storeIngest(ctx, {
      points: parsed.points,
      workouts: parsed.workouts,
      samples: parsed.samples,
      bytes: parsed.bytes,
      payload: null,
    });
  } catch (error) {
    if (error?.code === "PAYLOAD_TOO_LARGE") return json({ error: "payload_too_large" }, 413);
    if (error?.code === "INVALID_EXPORT" || error?.code === "INVALID_ZIP" || error?.code === "UNSUPPORTED_ZIP") {
      return json({ error: "invalid_payload" }, 400);
    }
    throw error;
  }
}

async function ingestHcWebhook(req, ctx) {
  const text = await req.text();
  if (text.length > MAX_PAYLOAD_CHARS) return json({ error: "payload_too_large" }, 413);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const healthConnect = adapterOptions(ctx);
  if (hcWebhookError(body, healthConnect)) return json({ error: "invalid_payload" }, 400);
  return storeParsed(ctx, parseHcWebhook(body, healthConnect), text);
}

async function ingestShortcuts(req, ctx) {
  const declared = declaredContentLength(req.headers.get("content-length"));
  if (declared != null && declared > MAX_PAYLOAD_CHARS) return json({ error: "payload_too_large" }, 413);
  const text = await req.text();
  if (text.length > MAX_PAYLOAD_CHARS) return json({ error: "payload_too_large" }, 413);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const options = adapterOptions(ctx);
  const error = shortcutsError(body, options);
  if (error) return json(error, 400);
  const parsed = parseShortcuts(body, options);
  const allow = storedMetricSet(ctx.metricAllowlist);
  const kept = parsed.points.filter((point) => allow.has(point.metric));
  const rows = shortcutDays(kept, shortcutsSourcePriority(ctx.shortcutsSourcePriority));
  // Only the main Bearer token may replace a stored day. `authed` already
  // passed, so a request with an Authorization header used HEALTH_INGEST_TOKEN.
  // URL-token rows go through the guarded upsert with n = 0: they can create a
  // day or update a day the URL token itself wrote, never lower a day with n >= 1.
  // URL-token workouts are insert-only and never change an existing workout.
  const bearer = Boolean(req.headers.get("authorization"));
  const points = bearer ? rows : rows.map(({ replace, ...row }) => ({ ...row, n: 0 }));
  return storeIngest(ctx, {
    points,
    workouts: bearer ? parsed.workouts : parsed.workouts.map((workout) => ({ ...workout, insertOnly: true })),
    samples: kept.length,
    bytes: text.length,
    payload: text,
    extra: { dropped: parsed.points.length - kept.length },
  });
}

async function storeParsed(ctx, parsed, text) {
  const allow = storedMetricSet(ctx.metricAllowlist);
  const kept = parsed.points.filter((point) => allow.has(point.metric));
  return storeIngest(ctx, {
    points: aggregateDays(kept, allow),
    workouts: parsed.workouts,
    samples: kept.length,
    bytes: text.length,
    payload: text,
  });
}

async function importApple(req, ctx) {
  const declared = declaredContentLength(req.headers.get("content-length"));
  if (declared != null && declared > MAX_APPLE_EXPORT_BYTES) return json({ error: "payload_too_large" }, 413);
  if (!req.body) return json({ error: "invalid_payload" }, 400);
  return acceptAppleExport(limitBytes(req.body, MAX_APPLE_EXPORT_BYTES), ctx);
}

async function importAppleChunk(req, ctx) {
  const text = await req.text();
  if (text.length > MAX_PAYLOAD_CHARS) return json({ error: "payload_too_large" }, 413);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (appleChunkError(body)) return json({ error: "invalid_payload" }, 400);
  const allow = storedMetricSet(ctx.metricAllowlist);
  const points = (body.points || []).filter((point) => allow.has(point.metric));
  const workouts = body.workouts || [];
  const samples = points.reduce((sum, point) => sum + point.n, 0);
  return storeIngest(ctx, { points, workouts, samples, bytes: text.length, payload: null });
}

async function summary(url, storage) {
  const date = url.searchParams.get("date");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) return json({ error: "date=YYYY-MM-DD required" }, 400);
  return json(await storage.queryDaySummary(date));
}
