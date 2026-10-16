import { aggregateDays, shouldStoreRaw, storedMetricSet, utf8Bytes } from "./aggregate.js";
import { appleChunkError, parseAppleExport } from "./apple-export.js";
import { tokenClass } from "./auth.js";
import { assertTimeZone } from "./datetime.js";
import { hcWebhookError, parseHcWebhook } from "./hc-webhook.js";
import { canonicalStart, realCalendarDate, workoutLocalDate } from "./health-connect.js";
import {
  isDailyWriteLimitError,
  isMissingWriterError,
  limitsFor,
  resolveLimitsProfile,
  secondsUntilUtcMidnight,
  workoutCap,
} from "./limits.js";
import { declaredContentLength, handleMcp, MCP_SERVER_NAME, readLimitedText } from "./mcp.js";
import { DEFAULT_TIME_ZONE, MAX_APPLE_EXPORT_BYTES } from "./metrics.js";
import { localDate } from "./parse.js";
import { isRemovedIngestPath, ROUTES } from "./routes.js";
import { parseShortcuts, shortcutDays, shortcutsError, shortcutsSourcePriority } from "./shortcuts.js";

export { ROUTES };

export function json(body, status = 200, headers = {}) {
  const response = new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
  return response;
}

function resolveTimeZone(value) {
  const zone = typeof value === "string" && value.trim() ? value.trim() : DEFAULT_TIME_ZONE;
  assertTimeZone(zone);
  return zone;
}

function adapterOptions(ctx) {
  return {
    timeZone: resolveTimeZone(ctx.timeZone),
    now: ctx.now instanceof Date ? ctx.now : new Date(),
  };
}

function requestLimits(ctx) {
  const resolved = resolveLimitsProfile(ctx.limitsProfile, ctx.adapter || "cloudflare");
  return resolved;
}

function countRecords(body) {
  let total = 0;
  let perArray = 0;
  if (!body || typeof body !== "object" || Array.isArray(body)) return { total, perArray };
  for (const value of Object.values(body)) {
    if (!Array.isArray(value)) continue;
    total += value.length;
    if (value.length > perArray) perArray = value.length;
    for (const item of value) {
      if (item && typeof item === "object" && Array.isArray(item.stages)) {
        total += item.stages.length;
        if (item.stages.length > perArray) perArray = item.stages.length;
      }
    }
  }
  return { total, perArray };
}

function countWorkouts(body, routeId) {
  if (!body || typeof body !== "object") return 0;
  if (routeId === "hc-webhook") return Array.isArray(body.exercise) ? body.exercise.length : 0;
  return Array.isArray(body.workouts) ? body.workouts.length : 0;
}

function jsonMedia(header) {
  if (header == null || String(header).trim() === "") return true;
  return String(header).split(";")[0].trim().toLowerCase() === "application/json";
}

function logLine(fields) {
  console.log(JSON.stringify(fields));
}

function nearLimit(used, max) {
  return Number.isFinite(max) && max > 0 && used / max >= 0.8;
}

/**
 * @param {Request} req
 * @param {{ token?: string, urlToken?: string, timeZone?: string, storeRaw?: boolean | string, shortcutsSourcePriority?: string, metricAllowlist?: string | string[], mcpAllowedOrigins?: string | string[], limitsProfile?: string, adapter?: string, tenantId?: string, storage: object, now?: Date }} ctx
 */
export async function handleRequest(req, ctx) {
  const url = new URL(req.url);
  if (isRemovedIngestPath(url.pathname)) return json({ error: "gone" }, 410);
  const resolved = requestLimits(ctx);
  if (resolved.invalid) {
    logLine({ limit_profile_invalid: true, route: url.pathname });
    return json({ error: "misconfigured" }, 503);
  }
  const limits = limitsFor(resolved.profile);
  const klass = tokenClass(req, { HEALTH_INGEST_TOKEN: ctx.token, HEALTH_INGEST_URL_TOKEN: ctx.urlToken });
  if (!klass) {
    const response = json({ error: "unauthorized" }, 401);
    if (url.pathname === "/mcp") response.headers.set("www-authenticate", `Bearer realm="${MCP_SERVER_NAME}"`);
    return response;
  }
  const route = ROUTES.find((entry) => (entry.method == null || entry.method === req.method) && entry.match(url.pathname));
  if (!route) return json({ error: "not_found" }, 404);
  if (route.guard === "json-ingest") return ingestJson(req, ctx, route, klass, limits);
  if (route.id === "summary") return summary(url, ctx.storage);
  if (route.id === "limits") return limitsRoute(limits);
  if (route.id === "mcp") return handleMcp(req, ctx);
  if (route.id === "apple-health") return importApple(req, ctx, klass);
  return json({ error: "not_found" }, 404);
}

function limitsRoute(limits) {
  return json({
    profile: limits.profile,
    max_bytes: limits.maxBytes,
    max_workouts: limits.maxBearerWorkouts,
    max_rows: Number.isFinite(limits.maxStoredRows) ? limits.maxStoredRows : null,
  });
}

async function ingestJson(req, ctx, route, klass, limits) {
  const started = Date.now();
  const base = { tenant: ctx.tenantId || "self", route: route.id, profile: limits.profile };
  const declared = declaredContentLength(req.headers.get("content-length"));
  if (declared != null && declared > limits.maxBytes) {
    logLine({ ...base, status: 413, bytes: declared, limit_hit: "bytes" });
    req.body?.cancel().catch(() => {});
    return json({ error: "payload_too_large", max_bytes: limits.maxBytes, retry: "split" }, 413);
  }
  if (!jsonMedia(req.headers.get("content-type"))) {
    logLine({ ...base, status: 415, limit_hit: "content_type" });
    return json({ error: "unsupported_media_type" }, 415);
  }
  let text;
  try {
    text = await readLimitedText(req, limits.maxBytes);
  } catch (error) {
    if (error?.code === "PAYLOAD_TOO_LARGE") {
      logLine({ ...base, status: 413, limit_hit: "bytes" });
      return json({ error: "payload_too_large", max_bytes: limits.maxBytes, retry: "split" }, 413);
    }
    throw error;
  }
  const bytes = utf8Bytes(text);
  let body;
  try {
    body = text === "" ? {} : JSON.parse(text);
  } catch {
    logLine({ ...base, status: 400, bytes });
    return json({ error: "invalid_json" }, 400);
  }
  const records = countRecords(body);
  if (records.perArray > limits.maxRecordsPerArray || records.total > limits.maxInputRecords) {
    const max = records.perArray > limits.maxRecordsPerArray ? limits.maxRecordsPerArray : limits.maxInputRecords;
    logLine({ ...base, status: 413, bytes, records: records.total, limit_hit: "records" });
    return json({ error: "too_many_records", max, retry: "split" }, 413);
  }
  const workoutsIn = countWorkouts(body, route.id);
  const maxWorkouts = workoutCap(limits, klass);
  if (workoutsIn > maxWorkouts) {
    logLine({ ...base, status: 413, bytes, workouts: workoutsIn, limit_hit: "workouts" });
    return json({ error: "too_many_workouts", max: maxWorkouts, retry: "split" }, 413);
  }
  const parsed = await parseIngest(route.id, body, ctx, klass);
  if (parsed.response) {
    logLine({ ...base, status: parsed.response.status, bytes, records: records.total });
    return parsed.response;
  }
  const rows = parsed.points.length + parsed.workouts.length;
  if (Number.isFinite(limits.maxStoredRows) && rows > limits.maxStoredRows) {
    logLine({ ...base, status: 413, bytes, records: records.total, rows, limit_hit: "rows" });
    return json({ error: "too_many_rows", max: limits.maxStoredRows, retry: "split" }, 413);
  }
  const limitNear = [];
  if (nearLimit(bytes, limits.maxBytes)) limitNear.push("bytes");
  if (nearLimit(workoutsIn, maxWorkouts)) limitNear.push("workouts");
  if (nearLimit(records.total, limits.maxInputRecords)) limitNear.push("records");
  if (nearLimit(rows, limits.maxStoredRows)) limitNear.push("rows");
  if (rows === 0) {
    logLine({
      ...base,
      status: 200,
      bytes,
      records: records.total,
      points: 0,
      workouts: 0,
      duration_ms: Date.now() - started,
      ...(limitNear.length ? { limit_near: limitNear } : {}),
    });
    return json({ ok: true, dates: [], points: 0, workouts: 0, ...parsed.extra });
  }
  try {
    const response = await storeIngest(ctx, {
      route: route.id,
      points: parsed.points,
      workouts: parsed.workouts,
      samples: parsed.samples,
      bytes,
      extra: parsed.extra,
    });
    logLine({
      ...base,
      status: 200,
      bytes,
      records: records.total,
      points: parsed.points.length,
      workouts: parsed.workouts.length,
      duration_ms: Date.now() - started,
      ...(limitNear.length ? { limit_near: limitNear } : {}),
    });
    return response;
  } catch (error) {
    if (isMissingWriterError(error)) {
      console.error(JSON.stringify({ schema_outdated: true, route: route.id }));
      return json({ error: "schema_outdated" }, 500);
    }
    if (isDailyWriteLimitError(error)) {
      const retryAfter = secondsUntilUtcMidnight(ctx.now instanceof Date ? ctx.now : new Date());
      logLine({ ...base, status: 429, bytes, limit_hit: "daily_writes" });
      return json({ error: "daily_write_limit", retry: "after" }, 429, { "retry-after": String(retryAfter) });
    }
    throw error;
  }
}

async function parseIngest(routeId, body, ctx, klass) {
  if (routeId === "hc-webhook") return parseHc(body, ctx, klass);
  if (routeId === "shortcuts") return parseShortcutIngest(body, ctx, klass);
  return parseChunk(body, ctx);
}

function withWriter(workouts, klass) {
  const writer = klass === "url" ? "url" : "bearer";
  return workouts.map((workout) => ({ ...workout, writer, ...(klass === "url" ? { insertOnly: true } : {}) }));
}

async function parseHc(body, ctx, klass) {
  const options = adapterOptions(ctx);
  if (hcWebhookError(body, options)) return { response: json({ error: "invalid_payload" }, 400) };
  const parsed = parseHcWebhook(body, options);
  const allow = storedMetricSet(ctx.metricAllowlist);
  const kept = parsed.points.filter((point) => allow.has(point.metric));
  const aggregated = aggregateDays(kept, allow);
  const points = klass === "url" ? aggregated.map((row) => ({ ...row, n: 0 })) : aggregated;
  const droppedWorkouts = Array.isArray(body.exercise) ? body.exercise.length - parsed.workouts.length : 0;
  return {
    points,
    workouts: withWriter(parsed.workouts, klass),
    samples: kept.length,
    extra: droppedWorkouts > 0 ? { dropped_workouts: droppedWorkouts } : {},
  };
}

async function parseShortcutIngest(body, ctx, klass) {
  const options = adapterOptions(ctx);
  const error = shortcutsError(body, options);
  if (error) return { response: json(error, 400) };
  const parsed = parseShortcuts(body, options);
  const allow = storedMetricSet(ctx.metricAllowlist);
  const kept = parsed.points.filter((point) => allow.has(point.metric));
  const rows = shortcutDays(kept, shortcutsSourcePriority(ctx.shortcutsSourcePriority));
  const points = klass === "bearer" ? rows : rows.map(({ replace, ...row }) => ({ ...row, n: 0 }));
  const extra = { dropped: parsed.points.length - kept.length };
  if (parsed.droppedWorkouts) extra.dropped_workouts = parsed.droppedWorkouts;
  return {
    points,
    workouts: withWriter(parsed.workouts, klass),
    samples: kept.length,
    extra,
  };
}

async function parseChunk(body, ctx) {
  if (appleChunkError(body)) return { response: json({ error: "invalid_payload" }, 400) };
  const timeZone = resolveTimeZone(ctx.timeZone);
  const allow = storedMetricSet(ctx.metricAllowlist);
  const points = (body.points || []).filter((point) => allow.has(point.metric)).map(({ replace, insertOnly, ...point }) => point);
  const workouts = [];
  let droppedWorkouts = 0;
  for (const workout of body.workouts || []) {
    const start = canonicalStart(workout.start, timeZone);
    if (!start) {
      droppedWorkouts += 1;
      continue;
    }
    workouts.push({
      name: workout.name,
      start,
      date: realCalendarDate(workout.date) ? workout.date : (workoutLocalDate(workout.start, timeZone, start) || workout.date),
      duration_min: workout.duration_min ?? null,
      kcal: workout.kcal ?? null,
      writer: "bearer",
    });
  }
  const samples = points.reduce((sum, point) => sum + (Number(point.n) || 0), 0);
  return {
    points,
    workouts,
    samples,
    extra: droppedWorkouts ? { dropped_workouts: droppedWorkouts } : {},
  };
}

function rawDocument(route, points, workouts) {
  return JSON.stringify({
    route,
    points: points.map(({ replace, insertOnly, ...point }) => point),
    workouts: workouts.map(({ insertOnly, ...workout }) => ({
      name: workout.name,
      start: workout.start,
      date: workout.date,
      duration_min: workout.duration_min ?? null,
      kcal: workout.kcal ?? null,
    })),
  });
}

async function storeIngest(ctx, { route, points, workouts, samples, bytes, extra }) {
  const timeZone = resolveTimeZone(ctx.timeZone);
  const now = ctx.now instanceof Date ? ctx.now : new Date();
  const dates = [...new Set([...points.map((point) => point.date), ...workouts.map((workout) => workout.date)])].sort();
  const key = dates.length ? dates[dates.length - 1] : localDate(now.toISOString(), timeZone);
  const id = `${key}/${now.toISOString()}/${crypto.randomUUID().slice(0, 8)}`;
  const payload = rawDocument(route, points, workouts);
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

async function importApple(req, ctx) {
  const declared = declaredContentLength(req.headers.get("content-length"));
  if (declared != null && declared > MAX_APPLE_EXPORT_BYTES) return json({ error: "payload_too_large" }, 413);
  if (!req.body) return json({ error: "invalid_payload" }, 400);
  try {
    const parsed = await parseAppleExport(limitBytes(req.body, MAX_APPLE_EXPORT_BYTES), {
      timeZone: resolveTimeZone(ctx.timeZone),
      allow: storedMetricSet(ctx.metricAllowlist),
      sourcePriority: ctx.sourcePriority,
    });
    if (parsed.points.length === 0 && parsed.workouts.length === 0) {
      return json({ ok: true, dates: [], points: 0, workouts: 0 });
    }
    return storeIngest(ctx, {
      route: "apple-health",
      points: parsed.points,
      workouts: parsed.workouts.map((workout) => ({ ...workout, writer: "bearer" })),
      samples: parsed.samples,
      bytes: parsed.bytes,
    });
  } catch (error) {
    if (error?.code === "PAYLOAD_TOO_LARGE") return json({ error: "payload_too_large" }, 413);
    if (error?.code === "INVALID_EXPORT" || error?.code === "INVALID_ZIP" || error?.code === "UNSUPPORTED_ZIP") {
      return json({ error: "invalid_payload" }, 400);
    }
    if (isMissingWriterError(error)) {
      console.error(JSON.stringify({ schema_outdated: true, route: "apple-health" }));
      return json({ error: "schema_outdated" }, 500);
    }
    throw error;
  }
}

async function summary(url, storage) {
  const date = url.searchParams.get("date");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) return json({ error: "date=YYYY-MM-DD required" }, 400);
  return json(await storage.queryDaySummary(date));
}

function attachHandlers() {
  const byId = {
    "apple-health": importApple,
    "apple-chunk": (req, ctx) => handleRequest(req, ctx),
    "hc-webhook": (req, ctx) => handleRequest(req, ctx),
    shortcuts: (req, ctx) => handleRequest(req, ctx),
    summary: (req, ctx) => summary(new URL(req.url), ctx.storage),
    limits: (req, ctx) => {
      const resolved = requestLimits(ctx);
      return limitsRoute(limitsFor(resolved.profile));
    },
    mcp: (req, ctx) => handleMcp(req, ctx),
  };
  for (const route of ROUTES) route.handler = byId[route.id];
}

attachHandlers();
