import http from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { activeUrlToken, redactRequestTarget } from "../core/auth.js";
import { handleRequest } from "../core/http.js";
import { limitsFor, OTHER_MAX_BYTES, resolveLimitsProfile } from "../core/limits.js";
import { MAX_MCP_BYTES } from "../core/mcp.js";
import { MAX_APPLE_EXPORT_BYTES } from "../core/metrics.js";
import { matchRoute } from "../core/routes.js";
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

function writeJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** Send the response, then stop reading the rest of the upload. */
function writeJsonAndClose(req, res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload, () => req.destroy());
}

function requestPath(req) {
  return (req.url || "").split("?")[0];
}

function bodyLimit(req, limits) {
  const pathname = requestPath(req);
  const route = matchRoute(req.method, pathname);
  if (!route) return OTHER_MAX_BYTES;
  if (route.guard === "json-ingest") return limits.maxBytes;
  if (route.guard === "mcp") return MAX_MCP_BYTES;
  if (route.guard === "apple-stream") return MAX_APPLE_EXPORT_BYTES;
  return OTHER_MAX_BYTES;
}

function declaredByteLength(req) {
  const raw = req.headers["content-length"];
  if (raw == null) return null;
  const value = String(Array.isArray(raw) ? raw[0] : raw).trim();
  if (!/^\d+$/.test(value)) return null;
  return Number(value);
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  const declared = declaredByteLength(req);
  if (declared != null && declared > limit) {
    const error = new Error("payload_too_large");
    error.code = "PAYLOAD_TOO_LARGE";
    error.limit = limit;
    throw error;
  }
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error("payload_too_large");
      error.code = "PAYLOAD_TOO_LARGE";
      error.limit = limit;
      throw error;
    }
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

export function nodeProfileError(value) {
  const resolved = resolveLimitsProfile(value, "node");
  if (!resolved.invalid) return null;
  return "HEALTH_LIMITS_PROFILE is not a recognized value";
}

export function startServer({ storage, token = "", urlToken = "", timeZone, storeRaw, metricAllowlist, sourcePriority, shortcutsSourcePriority, mcpAllowedOrigins, limitsProfile, port = 8787, host = "0.0.0.0" }) {
  const resolved = resolveLimitsProfile(limitsProfile, "node");
  if (resolved.invalid) {
    const error = new Error("HEALTH_LIMITS_PROFILE is not a recognized value");
    error.code = "INVALID_LIMITS_PROFILE";
    throw error;
  }
  const limits = limitsFor(resolved.profile);
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = requestPath(req);
      let request;
      const route = matchRoute(req.method, pathname);
      if (route?.guard === "apple-stream") {
        const declared = declaredByteLength(req);
        if (declared != null && declared > MAX_APPLE_EXPORT_BYTES) {
          writeJsonAndClose(req, res, 413, { error: "payload_too_large" });
          return;
        }
        request = toWebRequest(req, Readable.toWeb(req));
      } else {
        const limit = bodyLimit(req, limits);
        const declared = declaredByteLength(req);
        if (declared != null && declared > limit) {
          const payload = route?.guard === "json-ingest"
            ? { error: "payload_too_large", max_bytes: limit, retry: "split" }
            : { error: "payload_too_large" };
          writeJsonAndClose(req, res, 413, payload);
          return;
        }
        const body = await readBody(req, limit);
        request = toWebRequest(req, body);
      }
      const response = await handleRequest(request, {
        storage,
        token,
        urlToken,
        timeZone,
        storeRaw,
        metricAllowlist,
        sourcePriority,
        shortcutsSourcePriority,
        mcpAllowedOrigins,
        limitsProfile: resolved.profile,
        adapter: "node",
      });
      const payload = Buffer.from(await response.arrayBuffer());
      const headers = { "content-length": payload.length };
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });
      res.writeHead(response.status, headers);
      res.end(payload);
    } catch (error) {
      if (error?.code === "PAYLOAD_TOO_LARGE") {
        const route = matchRoute(req.method, requestPath(req));
        const payload = route?.guard === "json-ingest"
          ? { error: "payload_too_large", max_bytes: error.limit, retry: "split" }
          : { error: "payload_too_large" };
        writeJsonAndClose(req, res, 413, payload);
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
  const profileError = nodeProfileError(process.env.HEALTH_LIMITS_PROFILE);
  if (profileError) {
    console.error(profileError);
    process.exit(1);
  }
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
    limitsProfile: process.env.HEALTH_LIMITS_PROFILE,
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
