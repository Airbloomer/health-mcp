import http from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { activeUrlToken, authed, redactRequestTarget } from "../core/auth.js";
import { handleRequest, syncIngestBackfill } from "../core/http.js";
import { backfillTotalBody, payloadTooLargeBody } from "../core/ingest-guard.js";
import { MAX_MCP_BYTES } from "../core/mcp.js";
import { MAX_APPLE_EXPORT_BYTES, MAX_PAYLOAD_CHARS } from "../core/metrics.js";
import { openPostgres } from "./postgres.js";
import { createSqliteStorage } from "./sqlite.js";

const POSTGRES_URL = /^postgres(?:ql)?:\/\//i;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * `DATABASE_URL` selects the driver: a postgres URL, or a filesystem path for SQLite.
 * When it is unset, SQLite uses `SQLITE_PATH` or `./data/health.sqlite`.
 */
export async function createNodeStorage(env = process.env) {
  const databaseUrl = env.DATABASE_URL || "";
  if (POSTGRES_URL.test(databaseUrl)) return openPostgres(databaseUrl);
  if (URL_SCHEME.test(databaseUrl)) {
    throw new Error("DATABASE_URL must be a postgres URL or a SQLite file path");
  }
  const filename = databaseUrl || env.SQLITE_PATH || "./data/health.sqlite";
  return createSqliteStorage(filename);
}

function writeJson(res, status, body, done) {
  const payload = JSON.stringify(body);
  const headers = {
    "content-type": "application/json",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
  };
  if (done) headers.connection = "close";
  res.writeHead(status, headers);
  if (done) res.end(payload, done);
  else res.end(payload);
}

function requestPath(req) {
  return (req.url || "").split("?")[0];
}

function isJsonIngest(req) {
  const path = requestPath(req);
  if (path === "/mcp" || path === "/import/apple-health/chunk" || path === "/import/apple-health") return false;
  return path === "/ingest" || path.startsWith("/ingest/");
}

function bodyLimit(req, byteLimit) {
  if (requestPath(req) === "/mcp") return MAX_MCP_BYTES;
  if (requestPath(req) === "/import/apple-health/chunk") return MAX_PAYLOAD_CHARS;
  const type = String(req.headers["content-type"] || "");
  if (type.includes("json") && isJsonIngest(req)) return byteLimit;
  return MAX_PAYLOAD_CHARS;
}

function declaredByteLength(req) {
  const raw = req.headers["content-length"];
  if (raw == null) return null;
  const value = String(Array.isArray(raw) ? raw[0] : raw).trim();
  if (!/^\d+$/.test(value)) return null;
  return Number(value);
}

function requestIsAuthed(req, token, urlToken) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else headers.append(key, value);
  }
  const host = req.headers.host || "localhost";
  return authed(new Request(`http://${host}${req.url || "/"}`, { method: req.method, headers }), {
    HEALTH_INGEST_TOKEN: token,
    HEALTH_INGEST_URL_TOKEN: urlToken,
  });
}

function tooLargeError(req, limit, state) {
  const error = new Error("payload_too_large");
  error.code = "PAYLOAD_TOO_LARGE";
  const relaxed = Boolean(state?.view?.open || state?.pending);
  if (requestPath(req) === "/mcp" || !isJsonIngest(req)) error.detail = { error: "payload_too_large" };
  else {
    error.detail = payloadTooLargeBody(limit, {
      closed: state ? !relaxed : false,
      duringBackfill: relaxed,
      maxBytes: state?.limits?.maxBytes,
    });
  }
  return error;
}

async function readBody(req, byteLimit, state) {
  const chunks = [];
  let size = 0;
  const limit = bodyLimit(req, byteLimit);
  const declared = declaredByteLength(req);
  if (declared != null && declared > limit) throw tooLargeError(req, limit, state);
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw tooLargeError(req, limit, state);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const SKIP_HEADERS = new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive"]);

function toWebRequest(req, body) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value == null || SKIP_HEADERS.has(key.toLowerCase())) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.append(key, value);
    }
  }
  const host = req.headers.host || "localhost";
  const init = { method: req.method || "GET", headers };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = body;
    if (body && typeof body.getReader === "function") init.duplex = "half";
  }
  return new Request(`http://${host}${req.url}`, init);
}

export function startServer({ storage, token = "", urlToken = "", timeZone, storeRaw, metricAllowlist, sourcePriority, shortcutsSourcePriority, mcpAllowedOrigins, ingestMaxAgeDays, ingestMaxBodyBytes, ingestRatePerHour, ingestBackfillMaxBytes, ingestBackfillPerHour, ingestBackfillTotalBytes, ingestBackfillHours, ingestMinDate, ingestMaxStatements, now, port = 8787, host = "0.0.0.0" }) {
  const server = http.createServer(async (req, res) => {
    try {
      const context = {
        storage,
        token,
        urlToken,
        timeZone,
        storeRaw,
        metricAllowlist,
        sourcePriority,
        shortcutsSourcePriority,
        mcpAllowedOrigins,
        ingestMaxAgeDays,
        ingestMaxBodyBytes,
        ingestRatePerHour,
        ingestBackfillMaxBytes,
        ingestBackfillPerHour,
        ingestBackfillTotalBytes,
        ingestBackfillHours,
        ingestMinDate,
        ingestMaxStatements,
        now,
      };
      if (!requestIsAuthed(req, token, urlToken)) {
        writeJson(res, 401, { error: "unauthorized" }, () => req.destroy());
        return;
      }
      let request;
      if (requestPath(req) === "/import/apple-health" && (req.method || "").toUpperCase() === "POST") {
        const declared = declaredByteLength(req);
        if (declared != null && declared > MAX_APPLE_EXPORT_BYTES) {
          writeJson(res, 413, { error: "payload_too_large" });
          req.destroy();
          return;
        }
        request = toWebRequest(req, Readable.toWeb(req));
      } else {
        const state = await syncIngestBackfill(context);
        const declared = declaredByteLength(req);
        const limit = bodyLimit(req, state.byteLimit);
        if (
          declared != null
          && (state.view.open || state.pending)
          && declared > state.admitRemaining
          && declared <= limit
        ) {
          writeJson(res, 413, backfillTotalBody(state.limits.maxBytes));
          req.destroy();
          return;
        }
        const body = await readBody(req, state.byteLimit, state);
        request = toWebRequest(req, body);
      }
      const response = await handleRequest(request, context);
      const payload = Buffer.from(await response.arrayBuffer());
      const headers = { "content-length": payload.length };
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });
      res.writeHead(response.status, headers);
      res.end(payload);
    } catch (error) {
      if (error?.code === "PAYLOAD_TOO_LARGE") {
        writeJson(res, 413, error.detail || { error: "payload_too_large" });
        req.destroy();
        return;
      }
      const message = error instanceof Error ? error.message : error;
      console.error(redactRequestTarget(`${req.method || ""} ${req.url || ""} ${message}`, token, urlToken));
      if (!res.headersSent) writeJson(res, 500, { error: "internal" });
      else res.destroy();
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}

function isMainModule() {
  const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
  return entry === import.meta.url;
}

if (isMainModule()) {
  const token = process.env.HEALTH_INGEST_TOKEN || "";
  const urlToken = activeUrlToken(process.env.HEALTH_INGEST_URL_TOKEN, token);
  const timeZone = process.env.HEALTH_TIMEZONE;
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || "0.0.0.0";
  if (!token) console.error("HEALTH_INGEST_TOKEN is empty; every request will be rejected");

  const storage = await createNodeStorage(process.env);
  const server = await startServer({
    storage,
    token,
    urlToken,
    timeZone,
    storeRaw: process.env.HEALTH_STORE_RAW,
    metricAllowlist: process.env.HEALTH_METRIC_ALLOWLIST,
    sourcePriority: process.env.HEALTH_SOURCE_PRIORITY,
    shortcutsSourcePriority: process.env.HEALTH_SHORTCUTS_SOURCE_PRIORITY,
    mcpAllowedOrigins: process.env.MCP_ALLOWED_ORIGINS,
    ingestMaxAgeDays: process.env.INGEST_MAX_AGE_DAYS,
    ingestMaxBodyBytes: process.env.INGEST_MAX_BODY_BYTES,
    ingestRatePerHour: process.env.INGEST_RATE_LIMIT_PER_HOUR,
    ingestBackfillMaxBytes: process.env.INGEST_BACKFILL_MAX_BYTES,
    ingestBackfillPerHour: process.env.INGEST_BACKFILL_MAX_PER_HOUR,
    ingestBackfillTotalBytes: process.env.INGEST_BACKFILL_MAX_TOTAL_BYTES,
    ingestBackfillHours: process.env.INGEST_BACKFILL_HOURS,
    ingestMinDate: process.env.INGEST_MIN_DATE,
    ingestMaxStatements: process.env.INGEST_MAX_STATEMENTS,
    port,
    host,
  });
  const address = server.address();
  const shown = address && typeof address === "object" ? `${address.address}:${address.port}` : String(port);
  console.log(`health-mcp listening on ${shown}`);

  const shutdown = () => {
    server.close(() => {
      Promise.resolve(storage.close?.()).finally(() => process.exit(0));
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
