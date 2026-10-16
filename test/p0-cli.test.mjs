import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { deliverChunks, progressPathFor, splitImportChunks } from "../src/cli/import-apple-health.js";

function workouts(count) {
  return Array.from({ length: count }, (_, index) => ({
    name: "Walk",
    start: new Date(Date.UTC(2026, 9, 14, 0, 0, index)).toISOString(),
    date: "2026-10-14",
    duration_min: 10,
    kcal: 1,
  }));
}

function response(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] || null },
    async json() { return body; },
  };
}

test("11 CLI splits 2500 workouts, resumes, and stops on 429", async () => {
  const chunks = splitImportChunks([], workouts(2500), { maxWorkouts: 40, maxRows: 40, datesPerChunk: 31 });
  assert.ok(chunks.length >= 63);
  assert.ok(chunks.every((chunk) => chunk.workouts.length <= 40));
  assert.equal(chunks.reduce((sum, chunk) => sum + chunk.workouts.length, 0), 2500);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "health-import-"));
  const file = path.join(dir, "export.xml");
  fs.writeFileSync(file, "<HealthData></HealthData>");
  const progressFile = progressPathFor(file);
  let calls = 0;
  const fetchImpl = async (_url, init) => {
    calls += 1;
    if (calls === 11) throw new Error("interrupt");
    const chunk = JSON.parse(init.body);
    return response(200, { ok: true, points: 0, workouts: chunk.workouts.length, dates: ["2026-10-14"] });
  };
  await assert.rejects(() => deliverChunks({
    url: "http://127.0.0.1/import/apple-health/chunk",
    token: "secret-token",
    chunks,
    sha256: "abc",
    progressFile,
    fetchImpl,
  }));
  const progress = JSON.parse(fs.readFileSync(progressFile, "utf8"));
  assert.equal(progress.chunks.length, 10);
  assert.equal(JSON.stringify(progress).includes("secret-token"), false);
  assert.equal(JSON.stringify(progress).includes("Walk"), false);
  let resumed = 0;
  const again = await deliverChunks({
    url: "http://127.0.0.1/import/apple-health/chunk",
    token: "secret-token",
    chunks,
    sha256: "abc",
    progressFile,
    resume: true,
    fetchImpl: async (_url, init) => {
      resumed += 1;
      const chunk = JSON.parse(init.body);
      return response(200, { ok: true, points: 0, workouts: chunk.workouts.length, dates: ["2026-10-14"] });
    },
  });
  assert.equal(again.workouts + 10 * chunks.slice(0, 10).reduce((sum, chunk) => sum + 0, 0) >= 0, true);
  const firstTen = chunks.slice(0, 10).reduce((sum, chunk) => sum + chunk.workouts.length, 0);
  assert.equal(again.workouts, 2500 - firstTen);
  assert.equal(resumed, chunks.length - 10);

  const logs = [];
  let seen = 0;
  const stopped = await deliverChunks({
    url: "http://127.0.0.1/import/apple-health/chunk",
    token: "secret-token",
    chunks: chunks.slice(0, 4),
    sha256: "other",
    progressFile: path.join(dir, "other.json"),
    fetchImpl: async () => {
      seen += 1;
      if (seen === 2) return response(429, { error: "daily_limit", limit_hit: "d1_rows_written" }, { "retry-after": "120" });
      return response(200, { ok: true, points: 0, workouts: 1, dates: ["2026-10-14"] });
    },
    log: (line) => logs.push(line),
  });
  assert.equal(stopped.stopped, "retry_after");
  assert.match(logs.join("\n"), /retry after 120 seconds/);
  const continued = await deliverChunks({
    url: "http://127.0.0.1/import/apple-health/chunk",
    token: "secret-token",
    chunks: chunks.slice(0, 4),
    sha256: "other",
    progressFile: path.join(dir, "other.json"),
    resume: true,
    fetchImpl: async () => response(200, { ok: true, points: 0, workouts: 1, dates: ["2026-10-14"] }),
  });
  assert.equal(continued.ok, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("413 split halves a chunk before the next send", async () => {
  const chunks = splitImportChunks([{ metric: "step_count", date: "2026-10-14", sum_qty: 1, last_qty: 1, last_ts: "t", units: "count", n: 1 }], workouts(4), {
    maxWorkouts: 4,
    maxRows: 40,
  });
  const bodies = [];
  let calls = 0;
  const result = await deliverChunks({
    url: "http://127.0.0.1/import/apple-health/chunk",
    chunks,
    sha256: "hash",
    progressFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "health-halve-")), "progress.json"),
    fetchImpl: async (_url, init) => {
      calls += 1;
      const chunk = JSON.parse(init.body);
      bodies.push(chunk.workouts.length);
      if (calls === 1) return response(413, { error: "too_many_workouts", retry: "split" });
      return response(200, { ok: true, points: chunk.points.length, workouts: chunk.workouts.length, dates: ["2026-10-14"] });
    },
  });
  assert.equal(result.ok, true);
  assert.ok(bodies[1] < bodies[0]);
  assert.equal(result.workouts, 4);
  assert.equal(chunks[0].points.length, 1);
});
