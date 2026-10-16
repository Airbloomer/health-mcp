import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { handleRequest } from "../src/core/http.js";
import { MAX_MCP_BYTES, MAX_RANGE_DAYS, MAX_TOOL_RESULTS, MCP_PROTOCOL_VERSION, MCP_TOOLS } from "../src/core/mcp.js";
import { MemoryStorage } from "../src/core/memory.js";
import { expectedSummary, summaryChunk, summaryDate } from "./expected.mjs";
const TOOL_NAMES = ["get_daily_summary", "get_metric", "list_metrics", "list_workouts"];

function request(pathname, { method = "GET", token = "tok", body, accept } = {}) {
  const headers = new Headers();
  if (token) headers.set("authorization", /^bearer\s/i.test(token) ? token : `Bearer ${token}`);
  if (body != null) headers.set("content-type", "application/json");
  if (accept) headers.set("accept", accept);
  return new Request(`http://localhost${pathname}`, {
    method,
    headers,
    body: body == null ? undefined : body,
  });
}

function rpc(method, params, id = 1) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

async function call(ctx, method, params, { token = "tok", accept, id = 1 } = {}) {
  const response = await handleRequest(request("/mcp", {
    method: "POST",
    token,
    accept,
    body: rpc(method, params, id),
  }), ctx);
  return { status: response.status, body: await response.json(), contentType: response.headers.get("content-type") };
}

async function tool(ctx, name, args) {
  const { status, body } = await call(ctx, "tools/call", { name, arguments: args });
  assert.equal(status, 200);
  assert.equal(body.jsonrpc, "2.0");
  return body.result;
}

test("mcp rejects a missing or wrong bearer token", async () => {
  const ctx = { token: "tok", storage: new MemoryStorage() };
  const missing = await handleRequest(request("/mcp", { method: "POST", token: "", body: rpc("tools/list") }), ctx);
  assert.equal(missing.status, 401);
  assert.deepEqual(await missing.json(), { error: "unauthorized" });
  assert.match(missing.headers.get("www-authenticate"), /Bearer realm="health-mcp"/);

  const wrong = await handleRequest(request("/mcp", { method: "POST", token: "nope", body: rpc("tools/list") }), ctx);
  assert.equal(wrong.status, 401);
});

test("mcp lists only read tools and serves each one", async () => {
  const storage = new MemoryStorage();
  const ctx = { token: "tok", storage, now: new Date("2026-10-16T12:00:00Z") };
  const ingested = await handleRequest(request("/import/apple-health/chunk", { method: "POST", body: JSON.stringify(summaryChunk) }), ctx);
  assert.equal(ingested.status, 200);

  const init = await call(ctx, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  });
  assert.equal(init.status, 200);
  assert.equal(init.body.result.protocolVersion, "2025-06-18");
  assert.equal(init.body.result.capabilities.tools.listChanged, false);
  assert.equal(init.body.result.serverInfo.name, "health-mcp");

  const listed = await call(ctx, "tools/list");
  assert.deepEqual(listed.body.result.tools.map((entry) => entry.name), TOOL_NAMES);
  assert.deepEqual(MCP_TOOLS.map((entry) => entry.name), TOOL_NAMES);
  assert.ok(listed.body.result.tools.every((entry) => entry.annotations.readOnlyHint === true));
  assert.ok(listed.body.result.tools.every((entry) => entry.annotations.destructiveHint === false));

  const summary = await tool(ctx, "get_daily_summary", { date: summaryDate });
  assert.equal(summary.isError, false);
  assert.deepEqual(summary.structuredContent, expectedSummary);
  assert.deepEqual(JSON.parse(summary.content[0].text), expectedSummary);

  const metric = await tool(ctx, "get_metric", {
    metric: "STEP_COUNT",
    start_date: "2026-10-01",
    end_date: summaryDate,
  });
  assert.equal(metric.structuredContent.metric, "step_count");
  assert.equal(metric.structuredContent.rows.length, 1);
  assert.equal(metric.structuredContent.rows[0].date, summaryDate);
  assert.equal(metric.structuredContent.rows[0].sum_qty, 9321);
  assert.equal(metric.structuredContent.rows[0].n, 2);
  assert.equal(metric.structuredContent.rows[0].units, "count");

  const outside = await tool(ctx, "get_metric", {
    metric: "step_count",
    start_date: "2026-10-01",
    end_date: "2026-10-13",
  });
  assert.deepEqual(outside.structuredContent.rows, []);

  const metrics = await tool(ctx, "list_metrics", {});
  const step = metrics.structuredContent.metrics.find((entry) => entry.name === "step_count");
  assert.equal(step.summary_field, "steps");
  assert.equal(metrics.structuredContent.metrics.length, 9);

  const workouts = await tool(ctx, "list_workouts", { start_date: summaryDate, end_date: summaryDate });
  assert.deepEqual(workouts.structuredContent.workouts, [{
    name: "Traditional Strength Training",
    start: "2026-10-15T00:30:00.000Z",
    date: summaryDate,
    duration_min: 45,
    kcal: 310,
  }]);

  const none = await tool(ctx, "list_workouts", { start_date: "2026-01-01", end_date: "2026-01-02" });
  assert.deepEqual(none.structuredContent.workouts, []);
});

test("mcp validates tool arguments and protocol messages", async () => {
  const storage = new MemoryStorage();
  const ctx = { token: "tok", storage };
  const before = storage.points.size;

  const missingDate = await tool(ctx, "get_daily_summary", {});
  assert.equal(missingDate.isError, true);
  assert.match(missingDate.content[0].text, /date must be YYYY-MM-DD/);

  const bogus = await tool(ctx, "get_daily_summary", { date: "2026-02-31" });
  assert.equal(bogus.isError, true);

  const backwards = await tool(ctx, "get_metric", {
    metric: "step_count",
    start_date: summaryDate,
    end_date: "2026-10-01",
  });
  assert.equal(backwards.isError, true);
  assert.match(backwards.content[0].text, /on or before/);

  const badMetric = await tool(ctx, "get_metric", {
    metric: "step count",
    start_date: summaryDate,
    end_date: summaryDate,
  });
  assert.equal(badMetric.isError, true);
  assert.match(badMetric.content[0].text, /step_count/);

  const huge = await tool(ctx, "list_workouts", { start_date: "2000-01-01", end_date: "2026-01-01" });
  assert.equal(huge.isError, true);
  assert.match(huge.content[0].text, /366 days/);

  const notObject = await tool(ctx, "list_metrics", ["nope"]);
  assert.equal(notObject.isError, true);

  const unknown = await call(ctx, "tools/call", { name: "delete_day", arguments: { date: summaryDate } });
  assert.equal(unknown.body.error.code, -32602);
  assert.equal(unknown.body.error.message, "unknown tool");
  assert.equal(storage.points.size, before);

  const missing = await call(ctx, "resources/list");
  assert.equal(missing.body.error.code, -32601);

  const parse = await handleRequest(request("/mcp", { method: "POST", body: "{" }), ctx);
  assert.equal(parse.status, 400);
  assert.equal((await parse.json()).error.code, -32700);

  const batch = await handleRequest(request("/mcp", { method: "POST", body: "[]" }), ctx);
  assert.equal(batch.status, 400);
  assert.equal((await batch.json()).error.code, -32600);

  const noted = await handleRequest(request("/mcp", {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  }), ctx);
  assert.equal(noted.status, 202);

  const rejected = await handleRequest(new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      authorization: "Bearer tok",
      "content-type": "application/json",
      "mcp-protocol-version": "1999-01-01",
    },
    body: rpc("ping"),
  }), ctx);
  assert.equal(rejected.status, 400);

  const stream = await handleRequest(request("/mcp", {
    method: "POST",
    body: rpc("ping"),
    accept: "text/event-stream",
  }), ctx);
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get("content-type"), /text\/event-stream/);
  assert.match(await stream.text(), /"result":\{\}/);

  const plain = await handleRequest(request("/mcp", { method: "POST", body: rpc("ping"), accept: "text/plain" }), ctx);
  assert.equal(plain.status, 406);

  const get = await handleRequest(request("/mcp", { method: "GET" }), ctx);
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST");
});

test("mcp rejects an Origin that is not allowlisted", async () => {
  const ctx = { token: "tok", storage: new MemoryStorage() };
  const post = (origin, extra = {}) => handleRequest(new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      authorization: "Bearer tok",
      "content-type": "application/json",
      ...(origin ? { origin } : {}),
    },
    body: rpc("ping"),
  }), { ...ctx, ...extra });

  const blocked = await post("https://example.com");
  assert.equal(blocked.status, 403);
  assert.deepEqual(await blocked.json(), { error: "forbidden_origin" });

  const absent = await post(null);
  assert.equal(absent.status, 200);

  const allowed = await post("https://example.com", { mcpAllowedOrigins: "https://example.com/, https://other.example" });
  assert.equal(allowed.status, 200);

  const elsewhere = await post("https://elsewhere.example", { mcpAllowedOrigins: "https://example.com" });
  assert.equal(elsewhere.status, 403);
});

test("mcp falls back to protocol 2025-06-18", async () => {
  const ctx = { token: "tok", storage: new MemoryStorage() };
  assert.equal(MCP_PROTOCOL_VERSION, "2025-06-18");
  const missing = await call(ctx, "initialize", {});
  assert.equal(missing.body.result.protocolVersion, "2025-06-18");
  const unknown = await call(ctx, "initialize", { protocolVersion: "2024-11-05" });
  assert.equal(unknown.body.result.protocolVersion, "2025-06-18");
  const supported = await call(ctx, "initialize", { protocolVersion: "2025-03-26" });
  assert.equal(supported.body.result.protocolVersion, "2025-03-26");
});

test("mcp rejects a body over 64KB before reading and aborts the stream", async () => {
  const ctx = { token: "tok", storage: new MemoryStorage() };
  assert.equal(MAX_MCP_BYTES, 64 * 1024);

  const declared = await handleRequest(new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      authorization: "Bearer tok",
      "content-type": "application/json",
      "content-length": String(MAX_MCP_BYTES + 1),
    },
    body: rpc("ping"),
  }), ctx);
  assert.equal(declared.status, 413);
  assert.deepEqual(await declared.json(), { error: "payload_too_large" });

  const exact = await handleRequest(request("/mcp", { method: "POST", body: "x".repeat(MAX_MCP_BYTES) }), ctx);
  assert.equal(exact.status, 400);

  let pulls = 0;
  let cancelled = false;
  const chunk = new Uint8Array(8 * 1024);
  const streamed = await handleRequest(new Request("http://localhost/mcp", {
    method: "POST",
    headers: { authorization: "Bearer tok", "content-type": "application/json", "content-length": "8" },
    body: new ReadableStream({
      pull(controller) {
        pulls += 1;
        if (pulls > 20) controller.error(new Error("reader did not stop"));
        else controller.enqueue(chunk);
      },
      cancel() { cancelled = true; },
    }),
    duplex: "half",
  }), ctx);
  assert.equal(streamed.status, 413);
  assert.deepEqual(await streamed.json(), { error: "payload_too_large" });
  assert.equal(cancelled, true);
  assert.equal(pulls, 9);

  const within = await handleRequest(request("/mcp", { method: "POST", body: rpc("ping") }), ctx);
  assert.equal(within.status, 200);
});

function addDays(iso, days) {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

test("mcp caps the date range at 366 days and limits results", async () => {
  const storage = new MemoryStorage();
  const ctx = { token: "tok", storage };
  const start = "2026-01-01";
  const fit = await tool(ctx, "get_metric", {
    metric: "step_count",
    start_date: start,
    end_date: addDays(start, MAX_RANGE_DAYS),
  });
  assert.equal(fit.isError, false);
  assert.equal(fit.structuredContent.truncated, false);
  assert.equal(MAX_RANGE_DAYS, 366);

  const over = await tool(ctx, "get_metric", {
    metric: "step_count",
    start_date: start,
    end_date: addDays(start, MAX_RANGE_DAYS + 1),
  });
  assert.equal(over.isError, true);
  assert.match(over.content[0].text, /366 days/);

  const workouts = Array.from({ length: MAX_TOOL_RESULTS + 1 }, (_, index) => ({
    name: "Walk",
    start: `2026-06-01 ${String(index).padStart(4, "0")}`,
    date: "2026-06-01",
    duration_min: 1,
    kcal: 1,
  }));
  await storage.insertIngest({
    id: "many",
    date: "2026-06-01",
    receivedAt: "2026-06-01T00:00:00.000Z",
    bytes: 1,
    payload: null,
    storeRaw: false,
    points: [],
    workouts,
  });
  const listed = await tool(ctx, "list_workouts", { start_date: "2026-06-01", end_date: "2026-06-01" });
  assert.equal(listed.isError, false);
  assert.equal(listed.structuredContent.truncated, true);
  assert.equal(listed.structuredContent.workouts.length, MAX_TOOL_RESULTS);
  assert.equal(listed.structuredContent.workouts[0].start, "2026-06-01 0000");
});

test("ci runs npm test on pull requests and pushes to main", () => {
  const text = fs.readFileSync(new URL("../.github/workflows/test.yml", import.meta.url), "utf8");
  assert.match(text, /pull_request/);
  assert.match(text, /branches:\s*\[main\]/);
  assert.match(text, /npm test/);
  assert.match(text, /UTC/);
  assert.match(text, /America\/Los_Angeles/);
  assert.match(text, /TZ:/);
  assert.doesNotMatch(text, /uses:\s+\S+@v\d/);
  assert.match(text, /uses: actions\/checkout@[0-9a-f]{40}/);
  assert.match(text, /uses: actions\/setup-node@[0-9a-f]{40}/);
  const dependabot = fs.readFileSync(new URL("../.github/dependabot.yml", import.meta.url), "utf8");
  assert.match(dependabot, /package-ecosystem:\s*npm/);
  assert.match(dependabot, /package-ecosystem:\s*github-actions/);
});
