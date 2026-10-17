import { aggregateDays, shouldStoreRaw, storedMetricSet } from "./aggregate.js";
import { appleChunkError, looksLikeAppleExport, parseAppleExport } from "./apple-export.js";
import { authed } from "./auth.js";
import { hcWebhookError, isHcWebhook, parseHcWebhook } from "./hc-webhook.js";
import { healthExportProError, parseHealthExportPro } from "./health-export-pro.js";
import {
  EXPORT_HINT,
  filterRecent,
  hourWindowStart,
  payloadTooLargeBody,
  rateLimitedBody,
  resolveMaxAgeDays,
  resolveMaxBodyBytes,
  resolveRatePerHour,
  secondsUntilNextHour,
  STALE_HINT_AT,
} from "./ingest-guard.js";
import { isLifeDashboard, lifeDashboardError, parseLifeDashboard } from "./life-dashboard.js";
import { declaredContentLength, handleMcp, MCP_SERVER_NAME } from "./mcp.js";
import { DEFAULT_TIME_ZONE, MAX_APPLE_EXPORT_BYTES, MAX_PAYLOAD_CHARS } from "./metrics.js";
import { localDate, parse, payloadError } from "./parse.js";
import { parseShortcuts, shortcutDays, shortcutsError, shortcutsSourcePriority } from "./shortcuts.js";
import { parseSyncFit, syncFitError } from "./syncfit.js";

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function ingestKind(pathname) {
  if (pathname === "/ingest/hc-webhook" || /^\/ingest\/hc-webhook\/[^/]+$/.test(pathname)) return "hc-webhook";
  if (pathname === "/ingest/life-dashboard" || /^\/ingest\/life-dashboard\/[^/]+$/.test(pathname)) return "life-dashboard";
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
    now: requestNow(ctx),
  };
}

function requestNow(ctx) {
  return ctx.now instanceof Date ? ctx.now : new Date();
}

function tooLarge(limit) {
  return json(payloadTooLargeBody(limit), 413);
}

function rateLimited(limit, now) {
  const response = json(rateLimitedBody(limit), 429);
  response.headers.set("retry-after", String(secondsUntilNextHour(now)));
  return response;
}

/** One label per auth path. The credential itself is never stored. */
function rateKey(req) {
  return req.headers.get("authorization") ? "bearer" : "url";
}

/**
 * Read the current hour's counter. Over the limit, answer 429 and do not
 * increment. The hint row is written only when its text changes, so a run of
 * rejected posts writes at most once. An accepted post records the hit later,
 * as one statement beside the data writes.
 *
 * The read and the increment are separate, so two overlapping posts can both
 * pass the read and land one past the limit. That small overshoot is accepted.
 * Old hour rows are not deleted here, so the accepted post stays one extra write.
 */
async function claimQuota(req, ctx) {
  const limit = resolveRatePerHour(ctx.ingestRatePerHour);
  if (limit === 0) return { ticket: null };
  const now = requestNow(ctx);
  const tokenKey = rateKey(req);
  const windowStart = hourWindowStart(now);
  const hits = await ctx.storage.readIngestQuota(tokenKey, windowStart);
  if (hits >= limit) {
    await ctx.storage.setExportHint(EXPORT_HINT);
    return { response: rateLimited(limit, now) };
  }
  return { ticket: { tokenKey, windowStart } };
}

function jsonByteLimit(ctx) {
  return resolveMaxBodyBytes(ctx.ingestMaxBodyBytes);
}

function payloadTooLargeError() {
  const error = new Error("payload_too_large");
  error.code = "PAYLOAD_TOO_LARGE";
  return error;
}

async function cancelStream(stream) {
  try {
    await stream?.cancel();
  } catch {
    // The body may already be locked or closed.
  }
}

function concatBytes(chunks, size) {
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * "apple" once the prefix is export XML or a zip local header, "json" once it
 * cannot be either, "unknown" while the prefix is still too short to tell.
 */
function ingestBodyKind(bytes) {
  if (looksLikeAppleExport(bytes)) return "apple";
  let index = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) index = 3;
  else if (bytes.length > 0 && bytes[0] === 0xef) return "unknown";
  while (index < bytes.length && (bytes[index] === 0x20 || bytes[index] === 0x09 || bytes[index] === 0x0a || bytes[index] === 0x0d)) {
    index += 1;
  }
  if (index >= bytes.length) return "unknown";
  if (bytes[index] === 0x3c) return "apple";
  if (bytes[index] === 0x50 && bytes.length - index < 4) return "unknown";
  return "json";
}

/**
 * Read a body up to `limit` bytes.
 * A Content-Length over the limit is rejected before the stream is read.
 * A missing or smaller Content-Length is cancelled as soon as the next chunk
 * would pass the limit, and that chunk is not kept.
 */
export async function readCapped(req, limit) {
  const declared = declaredContentLength(req.headers.get("content-length"));
  if (declared != null && declared > limit) {
    await cancelStream(req.body);
    throw payloadTooLargeError();
  }
  if (req.body == null) return new Uint8Array(0);
  return readLimited(req.body.getReader(), limit);
}

async function readLimited(reader, limit) {
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > limit) {
        await reader.cancel().catch(() => {});
        throw payloadTooLargeError();
      }
      chunks.push(value);
      size += value.byteLength;
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  try {
    reader.releaseLock();
  } catch {
    // cancel() already released the lock
  }
  return concatBytes(chunks, size);
}

/**
 * POST /ingest may be JSON or an Apple export. JSON stops at `jsonLimit`.
 * An Apple export may continue to the larger ingest cap. The kind is decided
 * from the prefix, so a chunked JSON body is cancelled at the JSON cap.
 */
async function readIngestBytes(req, jsonLimit) {
  const declared = declaredContentLength(req.headers.get("content-length"));
  const type = req.headers.get("content-type") || "";
  if (declared != null && declared > MAX_PAYLOAD_CHARS) {
    await cancelStream(req.body);
    const error = payloadTooLargeError();
    error.apple = true;
    throw error;
  }
  if (declared != null && declared > jsonLimit && type.includes("json")) {
    await cancelStream(req.body);
    throw payloadTooLargeError();
  }
  if (req.body == null) return new Uint8Array(0);
  if (declared != null && declared <= jsonLimit) return readCapped(req, jsonLimit);
  return readPrefixedIngest(req.body.getReader(), jsonLimit);
}

async function readPrefixedIngest(reader, jsonLimit) {
  const chunks = [];
  const prefix = [];
  let size = 0;
  let prefixSize = 0;
  let kind = "unknown";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (kind === "unknown") {
        prefix.push(value);
        prefixSize += value.byteLength;
        kind = ingestBodyKind(concatBytes(prefix, prefixSize));
      }
      const limit = kind === "apple" ? MAX_PAYLOAD_CHARS : jsonLimit;
      if (size + value.byteLength > limit) {
        await reader.cancel().catch(() => {});
        const error = payloadTooLargeError();
        if (kind === "apple") error.apple = true;
        throw error;
      }
      chunks.push(value);
      size += value.byteLength;
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  try {
    reader.releaseLock();
  } catch {
    // cancel() already released the lock
  }
  if (kind !== "apple" && size > jsonLimit) throw payloadTooLargeError();
  return concatBytes(chunks, size);
}

/** JSON text, or a 413 response when the body passes the configured cap. */
async function readJsonText(req, ctx) {
  const limit = jsonByteLimit(ctx);
  try {
    const bytes = await readCapped(req, limit);
    return { text: new TextDecoder().decode(bytes) };
  } catch (error) {
    if (error?.code === "PAYLOAD_TOO_LARGE") return { response: tooLarge(limit) };
    throw error;
  }
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
  if (url.pathname === "/ingest" && req.method === "POST") return ingest(req, ctx);
  if (url.pathname === "/import/apple-health" && req.method === "POST") return importApple(req, ctx);
  if (url.pathname === "/import/apple-health/chunk" && req.method === "POST") return importAppleChunk(req, ctx);
  if (url.pathname === "/ingest/health-export-pro" && req.method === "POST") return ingestHealthExportPro(req, ctx);
  if (url.pathname === "/ingest/syncfit" && req.method === "POST") return ingestSyncFit(req, ctx);
  if (ingestKind(url.pathname) === "hc-webhook" && req.method === "POST") return ingestHcWebhook(req, ctx);
  if (ingestKind(url.pathname) === "life-dashboard" && req.method === "POST") return ingestLifeDashboard(req, ctx);
  if (ingestKind(url.pathname) === "shortcuts" && req.method === "POST") return ingestShortcuts(req, ctx);
  if (url.pathname === "/summary" && req.method === "GET") return summary(url, ctx.storage);
  if (url.pathname === "/mcp") return handleMcp(req, ctx);
  return json({ error: "not_found" }, 404);
}

async function storeIngest(ctx, { points, workouts, samples, bytes, payload, extra, quota, hint }) {
  const timeZone = resolveTimeZone(ctx.timeZone);
  const now = requestNow(ctx);
  const dates = [...new Set([...points.map((point) => point.date), ...workouts.map((workout) => workout.date)])].sort();
  const key = dates.length ? dates[dates.length - 1] : localDate(now.toISOString(), timeZone);
  const id = `${key}/${now.toISOString()}/${crypto.randomUUID().slice(0, 8)}`;
  const raw = { storeRaw: ctx.storeRaw, payload };
  const storeRaw = shouldStoreRaw(raw);
  const counts = await ctx.storage.insertIngest({
    id,
    date: key,
    receivedAt: now.toISOString(),
    bytes,
    payload: storeRaw ? payload : null,
    storeRaw,
    points,
    workouts,
  }, { quota, hint });
  return json({
    ok: true,
    id,
    dates,
    points: samples,
    workouts: workouts.length,
    written: counts?.written ?? 0,
    unchanged: counts?.unchanged ?? 0,
    ...extra,
  });
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

async function acceptAppleExport(source, ctx, quota = null) {
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
      quota,
    });
  } catch (error) {
    if (error?.code === "PAYLOAD_TOO_LARGE") return json({ error: "payload_too_large" }, 413);
    if (error?.code === "INVALID_EXPORT" || error?.code === "INVALID_ZIP" || error?.code === "UNSUPPORTED_ZIP") {
      return json({ error: "invalid_payload" }, 400);
    }
    throw error;
  }
}

async function ingest(req, ctx) {
  const limit = jsonByteLimit(ctx);
  let bytes;
  try {
    bytes = await readIngestBytes(req, limit);
  } catch (error) {
    if (error?.code === "PAYLOAD_TOO_LARGE") {
      return error.apple ? json({ error: "payload_too_large" }, 413) : tooLarge(limit);
    }
    throw error;
  }
  if (looksLikeAppleExport(bytes)) {
    const quota = await claimQuota(req, ctx);
    if (quota.response) return quota.response;
    return acceptAppleExport(bytes, ctx, quota.ticket);
  }
  const text = new TextDecoder().decode(bytes);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const timeZone = resolveTimeZone(ctx.timeZone);
  const healthConnect = adapterOptions(ctx);
  if (!healthExportProError(body)) return storeParsed(req, ctx, parseHealthExportPro(body, { timeZone }), text);
  if (body?.data == null && !syncFitError(body)) return storeParsed(req, ctx, parseSyncFit(body, { timeZone }), text);
  if (!lifeDashboardError(body, healthConnect)) return storeParsed(req, ctx, parseLifeDashboard(body, healthConnect), text);
  if (isLifeDashboard(body)) return json({ error: "invalid_payload" }, 400);
  if (!hcWebhookError(body, healthConnect)) return storeParsed(req, ctx, parseHcWebhook(body, healthConnect), text);
  if (isHcWebhook(body)) return json({ error: "invalid_payload" }, 400);
  if (payloadError(body)) return json({ error: "invalid_payload" }, 400);
  return storeParsed(req, ctx, parse(body, { timeZone }), text, { recency: true });
}

async function ingestHealthExportPro(req, ctx) {
  const read = await readJsonText(req, ctx);
  if (read.response) return read.response;
  const text = read.text;
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (healthExportProError(body)) return json({ error: "invalid_payload" }, 400);
  return storeParsed(req, ctx, parseHealthExportPro(body, { timeZone: resolveTimeZone(ctx.timeZone) }), text);
}

async function ingestHcWebhook(req, ctx) {
  const read = await readJsonText(req, ctx);
  if (read.response) return read.response;
  const text = read.text;
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const healthConnect = adapterOptions(ctx);
  if (hcWebhookError(body, healthConnect)) return json({ error: "invalid_payload" }, 400);
  return storeParsed(req, ctx, parseHcWebhook(body, healthConnect), text);
}

async function ingestLifeDashboard(req, ctx) {
  const read = await readJsonText(req, ctx);
  if (read.response) return read.response;
  const text = read.text;
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const healthConnect = adapterOptions(ctx);
  if (lifeDashboardError(body, healthConnect)) return json({ error: "invalid_payload" }, 400);
  return storeParsed(req, ctx, parseLifeDashboard(body, healthConnect), text);
}

async function ingestSyncFit(req, ctx) {
  const read = await readJsonText(req, ctx);
  if (read.response) return read.response;
  const text = read.text;
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (syncFitError(body)) return json({ error: "invalid_payload" }, 400);
  return storeParsed(req, ctx, parseSyncFit(body, { timeZone: resolveTimeZone(ctx.timeZone) }), text);
}

async function ingestShortcuts(req, ctx) {
  const read = await readJsonText(req, ctx);
  if (read.response) return read.response;
  const text = read.text;
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
  const quota = await claimQuota(req, ctx);
  if (quota.response) return quota.response;
  return storeIngest(ctx, {
    points,
    workouts: bearer ? parsed.workouts : parsed.workouts.map((workout) => ({ ...workout, insertOnly: true })),
    samples: kept.length,
    bytes: text.length,
    payload: text,
    extra: { dropped: parsed.points.length - kept.length },
    quota: quota.ticket,
  });
}

async function storeParsed(req, ctx, parsed, text, { recency = false } = {}) {
  let points = parsed.points;
  let workouts = parsed.workouts;
  let extra;
  let hint;
  if (recency) {
    const filtered = filterRecent(points, workouts, {
      now: requestNow(ctx),
      timeZone: resolveTimeZone(ctx.timeZone),
      maxAgeDays: resolveMaxAgeDays(ctx.ingestMaxAgeDays),
    });
    points = filtered.points;
    workouts = filtered.workouts;
    extra = { dropped_stale: filtered.dropped_stale, dropped_future: filtered.dropped_future };
    hint = filtered.dropped_stale >= STALE_HINT_AT ? EXPORT_HINT : null;
  }
  const quota = await claimQuota(req, ctx);
  if (quota.response) return quota.response;
  const allow = storedMetricSet(ctx.metricAllowlist);
  const kept = points.filter((point) => allow.has(point.metric));
  return storeIngest(ctx, {
    points: aggregateDays(kept, allow),
    workouts,
    samples: kept.length,
    bytes: text.length,
    payload: text,
    extra,
    quota: quota.ticket,
    hint,
  });
}

async function importApple(req, ctx) {
  const declared = declaredContentLength(req.headers.get("content-length"));
  if (declared != null && declared > MAX_APPLE_EXPORT_BYTES) return json({ error: "payload_too_large" }, 413);
  if (!req.body) return json({ error: "invalid_payload" }, 400);
  return acceptAppleExport(limitBytes(req.body, MAX_APPLE_EXPORT_BYTES), ctx);
}

async function importAppleChunk(req, ctx) {
  let text;
  try {
    text = new TextDecoder().decode(await readCapped(req, MAX_PAYLOAD_CHARS));
  } catch (error) {
    if (error?.code === "PAYLOAD_TOO_LARGE") return json({ error: "payload_too_large" }, 413);
    throw error;
  }
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
