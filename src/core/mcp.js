import { LATEST_METRICS, SUM_METRICS } from "./metrics.js";

/** Protocol versions this server can speak. Unknown requests fall back to 2025-06-18. */
export const MCP_PROTOCOL_VERSIONS = ["2025-03-26", "2025-06-18", "2025-11-25"];

export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** End date may be at most this many days after the start date. */
export const MAX_RANGE_DAYS = 366;

/** Most rows one tool call returns. Extra rows are dropped and `truncated` is set. */
export const MAX_TOOL_RESULTS = 500;

/** MCP request bodies above this are rejected. */
export const MAX_MCP_BYTES = 64 * 1024;

export const MCP_SERVER_NAME = "health-mcp";

const SUPPORTED = new Set(MCP_PROTOCOL_VERSIONS);
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const METRIC_RE = /^[a-z][a-z0-9_]{0,127}$/;

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export const MCP_TOOLS = [
  {
    name: "get_daily_summary",
    description: "Daily summary for one calendar day of data exported from Apple Health: dietary and active calories, macros, steps, weight, body fat, and workouts. Same object as GET /summary.",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Calendar day, YYYY-MM-DD." },
      },
      required: ["date"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "get_metric",
    description: `Daily rows for one stored metric between two dates, inclusive. Each row is one calendar day with sum_qty, last_qty, last_ts, units, and n. The end date can be at most ${MAX_RANGE_DAYS} days after the start date, and at most ${MAX_TOOL_RESULTS} rows are returned.`,
    inputSchema: {
      type: "object",
      properties: {
        metric: { type: "string", description: "Health Auto Export metric name, such as step_count." },
        start_date: { type: "string", description: "Inclusive start, YYYY-MM-DD." },
        end_date: { type: "string", description: "Inclusive end, YYYY-MM-DD." },
      },
      required: ["metric", "start_date", "end_date"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "list_metrics",
    description: "Metric names that have at least one stored day, with the summary field each recognized metric fills.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: READ_ONLY,
  },
  {
    name: "list_workouts",
    description: `Workouts whose calendar date falls between two dates, inclusive. The end date can be at most ${MAX_RANGE_DAYS} days after the start date, and at most ${MAX_TOOL_RESULTS} workouts are returned.`,
    inputSchema: {
      type: "object",
      properties: {
        start_date: { type: "string", description: "Inclusive start, YYYY-MM-DD." },
        end_date: { type: "string", description: "Inclusive end, YYYY-MM-DD." },
      },
      required: ["start_date", "end_date"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
];

class ToolInputError extends Error {}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

export function isIsoDate(value) {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function asNumber(value) {
  if (value == null || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function requireDate(value, label) {
  if (!isIsoDate(value)) throw new ToolInputError(`${label} must be YYYY-MM-DD`);
}

function dateRange(start, end) {
  requireDate(start, "start_date");
  requireDate(end, "end_date");
  if (start > end) throw new ToolInputError("start_date must be on or before end_date");
  const span = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000);
  if (span > MAX_RANGE_DAYS) throw new ToolInputError(`date range must be ${MAX_RANGE_DAYS} days or fewer`);
}

function metricName(value) {
  const name = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!METRIC_RE.test(name)) throw new ToolInputError("metric must be a Health Auto Export name such as step_count");
  return name;
}

function argumentsOf(params) {
  if (params == null || params.arguments == null) return {};
  if (!isPlainObject(params.arguments)) throw new ToolInputError("arguments must be an object");
  return params.arguments;
}

function toolError(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

function toolOk(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

function summaryField(name) {
  return SUM_METRICS[name] || LATEST_METRICS[name] || null;
}

async function runTool(name, args, storage) {
  if (name === "get_daily_summary") {
    requireDate(args.date, "date");
    return storage.queryDaySummary(args.date);
  }
  if (name === "get_metric") {
    const metric = metricName(args.metric);
    dateRange(args.start_date, args.end_date);
    const rows = await storage.queryMetricRange(metric, args.start_date, args.end_date);
    return {
      metric,
      start_date: args.start_date,
      end_date: args.end_date,
      truncated: rows.length > MAX_TOOL_RESULTS,
      rows: rows.slice(0, MAX_TOOL_RESULTS).map((row) => ({
        date: row.date,
        sum_qty: asNumber(row.sum_qty),
        last_qty: asNumber(row.last_qty),
        last_ts: row.last_ts ?? null,
        units: row.units ?? null,
        n: asNumber(row.n),
      })),
    };
  }
  if (name === "list_metrics") {
    const names = await storage.listMetrics();
    return {
      metrics: [...new Set(names)].sort().map((entry) => ({
        name: entry,
        summary_field: summaryField(entry),
      })),
    };
  }
  if (name === "list_workouts") {
    dateRange(args.start_date, args.end_date);
    const workouts = await storage.listWorkouts(args.start_date, args.end_date);
    return {
      start_date: args.start_date,
      end_date: args.end_date,
      truncated: workouts.length > MAX_TOOL_RESULTS,
      workouts: workouts.slice(0, MAX_TOOL_RESULTS).map((workout) => ({
        name: workout.name,
        start: workout.start,
        date: workout.date,
        duration_min: asNumber(workout.duration_min),
        kcal: asNumber(workout.kcal),
      })),
    };
  }
  return null;
}

function initializeResult(params) {
  const requested = params && typeof params.protocolVersion === "string" ? params.protocolVersion : "";
  return {
    protocolVersion: SUPPORTED.has(requested) ? requested : MCP_PROTOCOL_VERSION,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: MCP_SERVER_NAME, version: "0.1.0" },
    instructions: "Read-only health data. Dates are calendar days in YYYY-MM-DD. This server has no write tools.",
  };
}

async function dispatch(method, params, storage) {
  if (method === "initialize") return initializeResult(params);
  if (method === "ping") return {};
  if (method === "tools/list") return { tools: MCP_TOOLS };
  if (method === "tools/call") {
    const name = params && typeof params.name === "string" ? params.name : "";
    if (!MCP_TOOLS.some((tool) => tool.name === name)) {
      return { rpcError: { code: -32602, message: "unknown tool" } };
    }
    try {
      const value = await runTool(name, argumentsOf(params), storage);
      return toolOk(value);
    } catch (error) {
      if (error instanceof ToolInputError) return toolError(error.message);
      throw error;
    }
  }
  return { rpcError: { code: -32601, message: "method not found" } };
}

function rpc(id, body, status) {
  return { status, payload: { jsonrpc: "2.0", id: id ?? null, ...body } };
}

function accepted() {
  return new Response(null, { status: 202, headers: { "cache-control": "no-store" } });
}

function respond(req, status, payload) {
  const accept = req.headers.get("accept") || "";
  const streamOnly = status === 200 && accept.includes("text/event-stream") && !accept.includes("application/json");
  if (streamOnly) {
    return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
    });
  }
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function normalizeOrigin(value) {
  return String(value).trim().replace(/\/+$/, "").toLowerCase();
}

/** Comma-separated Origin values. Empty means no browser origin is allowed. */
export function parseOriginAllowlist(value) {
  if (value == null || value === false) return [];
  const list = Array.isArray(value) ? value : String(value).split(",");
  return list.map(normalizeOrigin).filter(Boolean);
}

/** A missing Origin is allowed. A present Origin must be on the allowlist. */
export function originAllowed(origin, allowlist) {
  if (origin == null || String(origin).trim() === "") return true;
  return new Set(parseOriginAllowlist(allowlist)).has(normalizeOrigin(origin));
}

function tooLarge() {
  return new Response(JSON.stringify({ error: "payload_too_large" }), {
    status: 413,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** Byte size from `Content-Length`, or null when the header is missing or not an integer. */
export function declaredContentLength(header) {
  if (header == null) return null;
  const value = String(header).trim();
  if (!/^\d+$/.test(value)) return null;
  return Number(value);
}

/**
 * Read a request body in chunks and stop once it passes `limit` bytes.
 * Cancels the stream instead of buffering the rest.
 */
export async function readLimitedText(req, limit) {
  if (req.body == null) return "";
  const reader = req.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > limit) {
        const error = new Error("payload_too_large");
        error.code = "PAYLOAD_TOO_LARGE";
        throw error;
      }
      chunks.push(value);
      size += value.byteLength;
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  reader.releaseLock();
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Streamable HTTP MCP endpoint. Stateless: no session id is issued.
 * Only the four read tools are registered. This function never writes.
 * @param {Request} req
 * @param {{ mcpAllowedOrigins?: string | string[], storage: { queryDaySummary: Function, queryMetricRange: Function, listMetrics: Function, listWorkouts: Function } }} ctx
 */
export async function handleMcp(req, ctx) {
  if (!originAllowed(req.headers.get("origin"), ctx.mcpAllowedOrigins)) {
    return new Response(JSON.stringify({ error: "forbidden_origin" }), {
      status: 403,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }
  if (req.method !== "POST") {
    return new Response(null, { status: 405, headers: { allow: "POST", "cache-control": "no-store" } });
  }
  const declared = declaredContentLength(req.headers.get("content-length"));
  if (declared != null && declared > MAX_MCP_BYTES) return tooLarge();
  const version = req.headers.get("mcp-protocol-version");
  if (version && !SUPPORTED.has(version)) {
    const error = rpc(null, { error: { code: -32600, message: "unsupported protocol version" } }, 400);
    return respond(req, error.status, error.payload);
  }

  const accept = req.headers.get("accept");
  const acceptsResponse = !accept || accept.includes("*/*") || accept.includes("application/json") || accept.includes("text/event-stream");
  if (!acceptsResponse) {
    return new Response(JSON.stringify({ error: "not_acceptable" }), {
      status: 406,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }

  let text;
  try {
    text = await readLimitedText(req, MAX_MCP_BYTES);
  } catch (error) {
    if (error?.code === "PAYLOAD_TOO_LARGE") return tooLarge();
    throw error;
  }
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    const error = rpc(null, { error: { code: -32700, message: "parse error" } }, 400);
    return respond(req, error.status, error.payload);
  }
  if (!isPlainObject(message) || message.jsonrpc !== "2.0") {
    const error = rpc(null, { error: { code: -32600, message: "invalid request" } }, 400);
    return respond(req, error.status, error.payload);
  }
  if (message.id != null && typeof message.id !== "string" && typeof message.id !== "number") {
    const error = rpc(null, { error: { code: -32600, message: "invalid request" } }, 400);
    return respond(req, error.status, error.payload);
  }

  if (!message.method) {
    if (Object.hasOwn(message, "result") || Object.hasOwn(message, "error")) return accepted();
    const error = rpc(message.id ?? null, { error: { code: -32600, message: "invalid request" } }, 400);
    return respond(req, error.status, error.payload);
  }
  if (!Object.hasOwn(message, "id")) return accepted();

  try {
    const result = await dispatch(message.method, message.params, ctx.storage);
    if (result && result.rpcError) {
      const error = rpc(message.id, { error: result.rpcError }, 200);
      return respond(req, error.status, error.payload);
    }
    const ok = rpc(message.id, { result }, 200);
    return respond(req, ok.status, ok.payload);
  } catch {
    const error = rpc(message.id, { error: { code: -32603, message: "internal error" } }, 200);
    return respond(req, error.status, error.payload);
  }
}
