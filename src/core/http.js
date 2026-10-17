import { aggregateDays, shouldStoreRaw, storedMetricSet } from "./aggregate.js";
import { appleChunkError, looksLikeAppleExport, parseAppleExport } from "./apple-export.js";
import { authed } from "./auth.js";
import { hcWebhookError, isHcWebhook, parseHcWebhook } from "./hc-webhook.js";
import { healthExportProError, parseHealthExportPro } from "./health-export-pro.js";
import {
  EXPORT_HINT,
  MAX_INGEST_DATES,
  activeIngestLimits,
  backfillClosesAt,
  backfillStatus,
  backfillTotalBody,
  beforeMinDateBody,
  filterRecent,
  hourWindowStart,
  outsideWindowBody,
  payloadTooLargeBody,
  rateLimitedBody,
  resolveBackfillMaxBytes,
  resolveMaxAgeDays,
  resolveMaxBodyBytes,
  resolveMinDate,
  secondsUntilNextHour,
  STALE_HINT_AT,
  tooManyDatesBody,
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

function backfillFields(view) {
  if (!view) return null;
  return {
    open: view.open,
    closes_at: view.closes_at,
    bytes_remaining: view.bytes_remaining,
  };
}

function respond(body, status, view) {
  const fields = backfillFields(view);
  return json(fields ? { ...body, backfill: fields } : body, status);
}

function tooLarge(state) {
  const relaxed = Boolean(state.view.open || state.pending);
  return respond(payloadTooLargeBody(state.byteLimit, {
    closed: !relaxed,
    duringBackfill: relaxed,
  }), 413, clientView(state));
}

function overTotal(view) {
  return respond(backfillTotalBody(), 413, view);
}

function rateLimited(limit, now, view) {
  const response = respond(rateLimitedBody(limit, { closed: view && !view.open }), 429, view);
  response.headers.set("retry-after", String(secondsUntilNextHour(now)));
  return response;
}

function headerDone(req) {
  return (req.headers.get("x-backfill") || "").trim().toLowerCase() === "done";
}

function markDone(state, body) {
  if (body && typeof body === "object" && !Array.isArray(body) && body.backfill === "done") state.done = true;
}

function doneOnly(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) || body.backfill !== "done") return false;
  return Object.keys(body).every((key) => key === "backfill");
}

/** One label per auth path. The credential itself is never stored. */
function rateKey(req) {
  return req.headers.get("authorization") ? "bearer" : "url";
}

/**
 * One upsert increments the hour and returns the new count, and only while the
 * stored count is still under the limit. Over the limit, answer 429 and do not
 * increment. The hint row is written only when its text changes, so a run of
 * rejected posts writes at most once. An accepted post is that one counter write.
 * Old hour rows are not deleted here.
 */
async function claimQuota(req, ctx, state) {
  if (!state || state.claimed) return null;
  const limit = state.rateLimit;
  state.claimed = true;
  if (limit === 0) return null;
  const hits = await ctx.storage.claimIngestQuota(rateKey(req), hourWindowStart(state.now), limit);
  if (hits == null) {
    await ctx.storage.setExportHint(EXPORT_HINT);
    return rateLimited(limit, state.now, clientView(state));
  }
  return null;
}

function clientView(state) {
  if (!state?.view) return null;
  return {
    open: Boolean(state.view.open),
    closes_at: state.view.closes_at ?? null,
    bytes_remaining: state.view.bytes_remaining ?? 0,
  };
}

function utf8ByteLength(text) {
  return new TextEncoder().encode(text).byteLength;
}

/**
 * Read the single import-window row and close it when its time or byte
 * budget is already spent. The row is created later, on the first accept.
 */
export async function syncIngestBackfill(ctx) {
  const now = requestNow(ctx);
  let row = await ctx.storage.readIngestBackfill();
  if (!row && await ctx.storage.hasStoredData()) {
    const closedAt = now.toISOString();
    row = await ctx.storage.finishIngestBackfill({
      openedAt: closedAt,
      closedAt,
      addBytes: 0,
      addDays: 0,
      deadline: closedAt,
      totalBytes: 0,
    });
  }
  const preview = activeIngestLimits(row, ctx, now);
  if (row && row.closed_at == null && !preview.view.open) {
    const deadline = Date.parse(preview.view.closes_at);
    const closedAt = Number.isFinite(deadline) && now.getTime() < deadline
      ? now.toISOString()
      : preview.view.closes_at;
    row = await ctx.storage.closeIngestBackfill(closedAt);
  }
  const active = activeIngestLimits(row, ctx, now);
  return { ...active, now, row, done: false, claimed: false };
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
  return readLimited(req.body.getReader(), limit, declared);
}

async function readLimited(reader, limit, declared = null) {
  let buffer = declared != null && declared > 0 ? new Uint8Array(declared) : new Uint8Array(0);
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const next = size + value.byteLength;
      if (next > limit) {
        await reader.cancel().catch(() => {});
        throw payloadTooLargeError();
      }
      if (next > buffer.length) {
        const grown = new Uint8Array(Math.max(next, Math.min(limit, Math.max(buffer.length * 2, 1024))));
        if (size) grown.set(buffer.subarray(0, size), 0);
        buffer = grown;
      }
      buffer.set(value, size);
      size = next;
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
  return size === buffer.byteLength ? buffer : buffer.subarray(0, size);
}

/**
 * POST /ingest may be JSON or an Apple export. JSON stops at `jsonLimit`.
 * An Apple export may continue to the larger ingest cap. The kind is decided
 * from the prefix, so a chunked JSON body is cancelled at the JSON cap.
 */
async function readIngestBytes(req, jsonLimit) {
  const declared = declaredContentLength(req.headers.get("content-length"));
  const type = req.headers.get("content-type") || "";
  if (declared != null && declared > MAX_PAYLOAD_CHARS && !type.includes("json")) {
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

/** JSON text, or a 413 response when the body passes the active cap. */
async function readJsonText(req, state) {
  const over = await rejectDeclaredTotal(req, state);
  if (over) return { response: over };
  try {
    const bytes = await readCapped(req, state.byteLimit);
    if ((state.view.open || state.pending) && bytes.byteLength > state.admitRemaining) {
      return { response: overTotal(clientView(state)) };
    }
    return { text: new TextDecoder().decode(bytes), bytes: bytes.byteLength };
  } catch (error) {
    if (error?.code === "PAYLOAD_TOO_LARGE") return { response: tooLarge(state) };
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

async function rejectReserve(ctx, state) {
  let row = await ctx.storage.readIngestBackfill();
  let view = backfillStatus(row, state.limits, state.now);
  if (!view.open) {
    if (row && row.closed_at == null) {
      const deadline = Date.parse(view.closes_at);
      const closedAt = Number.isFinite(deadline) && state.now.getTime() < deadline
        ? state.now.toISOString()
        : view.closes_at;
      row = await ctx.storage.closeIngestBackfill(closedAt);
      view = backfillStatus(row, state.limits, state.now);
    }
    return respond(outsideWindowBody(), 422, view);
  }
  return overTotal(view);
}

async function storeIngest(ctx, batch, state = null) {
  const points = batch.points || [];
  const workouts = batch.workouts || [];
  const dates = [...new Set([...points.map((point) => point.date), ...workouts.map((workout) => workout.date)])].sort();
  const willKeep = points.length + workouts.length > 0;
  const relaxed = Boolean(state && (state.view.open || state.pending));
  if (dates.length > MAX_INGEST_DATES) return respond(tooManyDatesBody(), 413, clientView(state));

  const perform = async () => {
    const timeZone = resolveTimeZone(ctx.timeZone);
    const now = state?.now || requestNow(ctx);
    const key = dates.length ? dates[dates.length - 1] : localDate(now.toISOString(), timeZone);
    const id = `${key}/${now.toISOString()}/${crypto.randomUUID().slice(0, 8)}`;
    const raw = { storeRaw: ctx.storeRaw, payload: batch.payload };
    const storeRaw = shouldStoreRaw(raw);
    const counts = await ctx.storage.insertIngest({
      id,
      date: key,
      receivedAt: now.toISOString(),
      bytes: batch.bytes,
      payload: storeRaw ? batch.payload : null,
      storeRaw,
      points,
      workouts,
    }, { hint: batch.hint });
    return {
      ok: true,
      id,
      dates,
      points: batch.samples,
      workouts: workouts.length,
      written: counts?.written ?? 0,
      unchanged: counts?.unchanged ?? 0,
      ...batch.extra,
    };
  };

  if (relaxed && !willKeep && state.done) {
    const nowIso = state.now.toISOString();
    const row = await ctx.storage.finishIngestBackfill({
      openedAt: nowIso,
      closedAt: nowIso,
      addBytes: batch.bytes,
      addDays: 0,
      deadline: backfillClosesAt(nowIso, state.limits.hours),
      totalBytes: state.limits.totalBytes,
    });
    return respond(await perform(), 200, backfillStatus(row, state.limits, state.now));
  }

  if (relaxed && willKeep) {
    if (batch.bytes > state.admitRemaining) return overTotal(clientView(state));
    const nowIso = state.now.toISOString();
    const fillsNewRow = !state.row && batch.bytes >= state.limits.totalBytes;
    const closeAt = state.done || fillsNewRow ? nowIso : null;
    let body;
    const reserved = await ctx.storage.reserveIngestBackfill({
      openedAt: nowIso,
      closeAt,
      addBytes: batch.bytes,
      totalBytes: state.limits.totalBytes,
      deadline: backfillClosesAt(nowIso, state.limits.hours),
      nowIso,
      points,
      workouts,
      write: async () => {
        body = await perform();
      },
    });
    if (!reserved || !body) return rejectReserve(ctx, state);
    return respond(body, 200, backfillStatus(reserved, state.limits, state.now));
  }

  return respond(await perform(), 200, clientView(state));
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

async function acceptAppleExport(source, ctx, hint, state = null) {
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
      hint,
    }, state);
  } catch (error) {
    if (error?.code === "PAYLOAD_TOO_LARGE") {
      return state ? tooLarge(state) : json({ error: "payload_too_large" }, 413);
    }
    if (error?.code === "INVALID_EXPORT" || error?.code === "INVALID_ZIP" || error?.code === "UNSUPPORTED_ZIP") {
      return respond({ error: "invalid_payload" }, 400, state?.view);
    }
    throw error;
  }
}

/**
 * Window state when the storage read finishes without waiting. An async
 * storage returns null here so the caller can load the row and then cancel.
 */
function trySyncBackfill(ctx) {
  const read = ctx.storage.readIngestBackfill();
  if (read && typeof read.then === "function") return null;
  const row = read || null;
  if (!row) {
    const has = ctx.storage.hasStoredData();
    if (has && typeof has.then === "function") return null;
    if (has) return null;
  }
  const now = requestNow(ctx);
  const active = activeIngestLimits(row, ctx, now);
  if (row && row.closed_at == null && !active.view.open) return null;
  return { ...active, now, row, done: false, claimed: false };
}

function declaredOverRemaining(req, state) {
  const declared = declaredContentLength(req.headers.get("content-length"));
  if (declared == null || !state || !(state.view.open || state.pending)) return false;
  const json = (req.headers.get("content-type") || "").includes("json");
  const limit = json ? state.byteLimit : MAX_PAYLOAD_CHARS;
  return declared <= limit && declared > state.admitRemaining;
}

/**
 * Decide whether to cancel before any other wait. A length above every
 * configured cap, or a declared length above the bytes still remaining, is
 * cancelled on the first await so the stream is not pulled.
 */
function ingestGate(req, ctx) {
  const declared = declaredContentLength(req.headers.get("content-length"));
  const json = (req.headers.get("content-type") || "").includes("json");
  const ceiling = Math.max(resolveMaxBodyBytes(ctx.ingestMaxBodyBytes), resolveBackfillMaxBytes(ctx.ingestBackfillMaxBytes));
  const overCeiling = declared != null && (json ? declared > ceiling : declared > MAX_PAYLOAD_CHARS);
  if (overCeiling) return { cancel: "ceiling", json };
  const state = trySyncBackfill(ctx);
  if (state && declaredOverRemaining(req, state)) return { cancel: "remaining", state };
  return { state };
}

async function beginIngest(req, ctx) {
  const gate = ingestGate(req, ctx);
  if (gate.cancel === "remaining") {
    await cancelStream(req.body);
    return { response: overTotal(clientView(gate.state)) };
  }
  if (gate.cancel === "ceiling") {
    await cancelStream(req.body);
    const state = await syncIngestBackfill(ctx);
    if (!gate.json) {
      return {
        response: respond(payloadTooLargeBody(MAX_PAYLOAD_CHARS, {
          closed: !state.view.open && !state.pending,
          duringBackfill: Boolean(state.view.open || state.pending),
        }), 413, clientView(state)),
      };
    }
    return { response: tooLarge(state) };
  }
  const state = gate.state || await syncIngestBackfill(ctx);
  if (!gate.state) {
    const over = await rejectDeclaredTotal(req, state);
    if (over) return { response: over };
  }
  return { state };
}

async function ingest(req, ctx) {
  const opened = await beginIngest(req, ctx);
  if (opened.response) return opened.response;
  const state = opened.state;
  state.done = headerDone(req);
  let size = 0;
  let text = null;
  let appleBytes = null;
  try {
    const bytes = await readIngestBytes(req, state.byteLimit);
    size = bytes.byteLength;
    if ((state.view.open || state.pending) && size > state.admitRemaining) return overTotal(clientView(state));
    if (looksLikeAppleExport(bytes)) appleBytes = bytes;
    else text = new TextDecoder().decode(bytes);
  } catch (error) {
    if (error?.code === "PAYLOAD_TOO_LARGE") {
      if (error.apple) {
        return respond(payloadTooLargeBody(MAX_PAYLOAD_CHARS, {
          closed: !state.view.open && !state.pending,
          duringBackfill: Boolean(state.view.open || state.pending),
        }), 413, clientView(state));
      }
      return tooLarge(state);
    }
    throw error;
  }
  const limited = await claimQuota(req, ctx, state);
  if (limited) return limited;
  if (appleBytes) return acceptAppleExport(appleBytes, ctx, null, state);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return respond({ error: "invalid_json" }, 400, clientView(state));
  }
  markDone(state, body);
  if (doneOnly(body)) return closeDone(req, ctx, state, size);
  const timeZone = resolveTimeZone(ctx.timeZone);
  const healthConnect = adapterOptions(ctx);
  if (!healthExportProError(body)) return storeParsed(req, ctx, parseHealthExportPro(body, { timeZone }), text, state, { bytes: size });
  if (body?.data == null && !syncFitError(body)) return storeParsed(req, ctx, parseSyncFit(body, { timeZone }), text, state, { bytes: size });
  if (!lifeDashboardError(body, healthConnect)) return storeParsed(req, ctx, parseLifeDashboard(body, healthConnect), text, state, { bytes: size });
  if (isLifeDashboard(body)) return respond({ error: "invalid_payload" }, 400, clientView(state));
  if (!hcWebhookError(body, healthConnect)) return storeParsed(req, ctx, parseHcWebhook(body, healthConnect), text, state, { bytes: size });
  if (isHcWebhook(body)) return respond({ error: "invalid_payload" }, 400, clientView(state));
  if (payloadError(body)) return respond({ error: "invalid_payload" }, 400, clientView(state));
  return storeParsed(req, ctx, parse(body, { timeZone }), text, state, { recency: true, bytes: size });
}

async function closeDone(req, ctx, state, bytes) {
  if (!state.view.open && !state.pending) {
    return respond({ ok: true, written: 0, unchanged: 0, points: 0, workouts: 0, dates: [] }, 200, clientView(state));
  }
  const limited = await claimQuota(req, ctx, state);
  if (limited) return limited;
  const nowIso = state.now.toISOString();
  const row = await ctx.storage.finishIngestBackfill({
    openedAt: nowIso,
    closedAt: nowIso,
    addBytes: bytes,
    addDays: 0,
    deadline: state.row?.deadline || backfillClosesAt(state.row?.opened_at || nowIso, state.limits.hours),
    totalBytes: state.row?.total_bytes ?? state.limits.totalBytes,
  });
  return respond({
    ok: true,
    written: 0,
    unchanged: 0,
    points: 0,
    workouts: 0,
    dates: [],
  }, 200, backfillStatus(row, state.limits, state.now));
}

async function rejectDeclaredTotal(req, state) {
  const declared = declaredContentLength(req.headers.get("content-length"));
  if (declared == null || !(state.view.open || state.pending)) return null;
  if (declared <= state.byteLimit && declared > state.admitRemaining) {
    await cancelStream(req.body);
    return overTotal(clientView(state));
  }
  return null;
}

async function ingestHealthExportPro(req, ctx) {
  const opened = await beginIngest(req, ctx);
  if (opened.response) return opened.response;
  const state = opened.state;
  state.done = headerDone(req);
  const read = await readJsonText(req, state);
  if (read.response) return read.response;
  const text = read.text;
  const limited = await claimQuota(req, ctx, state);
  if (limited) return limited;
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return respond({ error: "invalid_json" }, 400, state.view);
  }
  markDone(state, body);
  if (doneOnly(body)) return closeDone(req, ctx, state, read.bytes);
  if (healthExportProError(body)) return respond({ error: "invalid_payload" }, 400, state.view);
  return storeParsed(req, ctx, parseHealthExportPro(body, { timeZone: resolveTimeZone(ctx.timeZone) }), text, state);
}

async function ingestHcWebhook(req, ctx) {
  const opened = await beginIngest(req, ctx);
  if (opened.response) return opened.response;
  const state = opened.state;
  state.done = headerDone(req);
  const read = await readJsonText(req, state);
  if (read.response) return read.response;
  const text = read.text;
  const limited = await claimQuota(req, ctx, state);
  if (limited) return limited;
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return respond({ error: "invalid_json" }, 400, state.view);
  }
  markDone(state, body);
  if (doneOnly(body)) return closeDone(req, ctx, state, read.bytes);
  const healthConnect = adapterOptions(ctx);
  if (hcWebhookError(body, healthConnect)) return respond({ error: "invalid_payload" }, 400, state.view);
  return storeParsed(req, ctx, parseHcWebhook(body, healthConnect), text, state);
}

async function ingestLifeDashboard(req, ctx) {
  const opened = await beginIngest(req, ctx);
  if (opened.response) return opened.response;
  const state = opened.state;
  state.done = headerDone(req);
  const read = await readJsonText(req, state);
  if (read.response) return read.response;
  const text = read.text;
  const limited = await claimQuota(req, ctx, state);
  if (limited) return limited;
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return respond({ error: "invalid_json" }, 400, state.view);
  }
  markDone(state, body);
  if (doneOnly(body)) return closeDone(req, ctx, state, read.bytes);
  const healthConnect = adapterOptions(ctx);
  if (lifeDashboardError(body, healthConnect)) return respond({ error: "invalid_payload" }, 400, state.view);
  return storeParsed(req, ctx, parseLifeDashboard(body, healthConnect), text, state);
}

async function ingestSyncFit(req, ctx) {
  const opened = await beginIngest(req, ctx);
  if (opened.response) return opened.response;
  const state = opened.state;
  state.done = headerDone(req);
  const read = await readJsonText(req, state);
  if (read.response) return read.response;
  const text = read.text;
  const limited = await claimQuota(req, ctx, state);
  if (limited) return limited;
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return respond({ error: "invalid_json" }, 400, state.view);
  }
  markDone(state, body);
  if (doneOnly(body)) return closeDone(req, ctx, state, read.bytes);
  if (syncFitError(body)) return respond({ error: "invalid_payload" }, 400, state.view);
  return storeParsed(req, ctx, parseSyncFit(body, { timeZone: resolveTimeZone(ctx.timeZone) }), text, state);
}

async function ingestShortcuts(req, ctx) {
  const opened = await beginIngest(req, ctx);
  if (opened.response) return opened.response;
  const state = opened.state;
  state.done = headerDone(req);
  const read = await readJsonText(req, state);
  if (read.response) return read.response;
  const text = read.text;
  const limited = await claimQuota(req, ctx, state);
  if (limited) return limited;
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return respond({ error: "invalid_json" }, 400, state.view);
  }
  markDone(state, body);
  if (doneOnly(body)) return closeDone(req, ctx, state, read.bytes);
  const options = adapterOptions(ctx);
  const error = shortcutsError(body, options);
  if (error) return respond(error, 400, state.view);
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
    bytes: read.bytes,
    payload: shouldStoreRaw({ storeRaw: ctx.storeRaw, payload: text }) ? text : null,
    extra: { dropped: parsed.points.length - kept.length },
    hint: null,
  }, state);
}

async function storeParsed(req, ctx, parsed, text, state, { recency = false, bytes = null } = {}) {
  let points = parsed.points;
  let workouts = parsed.workouts;
  let extra;
  let hint = null;
  const minDate = resolveMinDate(ctx.ingestMinDate);
  if (recency) {
    const filtered = filterRecent(points, workouts, {
      now: state.now,
      timeZone: resolveTimeZone(ctx.timeZone),
      maxAgeDays: resolveMaxAgeDays(ctx.ingestMaxAgeDays),
      keepPast: Boolean(state.view.open || state.pending),
      minDate,
    });
    const nothing = filtered.points.length === 0 && filtered.workouts.length === 0;
    if (nothing && filtered.dropped_early > 0) {
      await ctx.storage.setExportHint(EXPORT_HINT);
      return respond(beforeMinDateBody(minDate), 422, clientView(state));
    }
    if (nothing && !state.view.open && !state.pending && filtered.dropped_stale > 0) {
      await ctx.storage.setExportHint(EXPORT_HINT);
      return respond(outsideWindowBody(), 422, clientView(state));
    }
    points = filtered.points;
    workouts = filtered.workouts;
    extra = {
      dropped_stale: filtered.dropped_stale,
      dropped_future: filtered.dropped_future,
      dropped_early: filtered.dropped_early,
    };
    if (filtered.dropped_stale >= STALE_HINT_AT) hint = EXPORT_HINT;
  }
  const limited = await claimQuota(req, ctx, state);
  if (limited) return limited;
  const allow = storedMetricSet(ctx.metricAllowlist);
  const kept = points.filter((point) => allow.has(point.metric));
  const size = bytes ?? utf8ByteLength(text);
  const payload = shouldStoreRaw({ storeRaw: ctx.storeRaw, payload: text }) ? text : null;
  return storeIngest(ctx, {
    points: aggregateDays(kept, allow),
    workouts,
    samples: kept.length,
    bytes: size,
    payload,
    extra,
    hint,
  }, state);
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
  return storeIngest(ctx, { points, workouts, samples, bytes: utf8ByteLength(text), payload: null });
}

async function summary(url, storage) {
  const date = url.searchParams.get("date");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) return json({ error: "date=YYYY-MM-DD required" }, 400);
  return json(await storage.queryDaySummary(date));
}
