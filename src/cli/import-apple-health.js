import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createNodeStorage } from "../adapters/node.js";
import { storedMetricSet } from "../core/aggregate.js";
import { chunkByDate, parseAppleExport } from "../core/apple-export.js";
import { DEFAULT_TIME_ZONE } from "../core/metrics.js";
import { localDate } from "../core/parse.js";

const DEFAULT_MAX_ROWS_PER_DAY = 50_000;

function parseArgs(argv) {
  const options = {
    file: "",
    chunkUrl: "",
    token: process.env.HEALTH_INGEST_TOKEN || "",
    timeZone: process.env.HEALTH_TIMEZONE || "",
    datesPerChunk: 31,
    maxWorkoutsPerChunk: null,
    maxRowsPerChunk: null,
    maxRowsPerDay: DEFAULT_MAX_ROWS_PER_DAY,
    resume: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--chunk-url") options.chunkUrl = argv[++index] || "";
    else if (arg === "--token") options.token = argv[++index] || "";
    else if (arg === "--time-zone") options.timeZone = argv[++index] || "";
    else if (arg === "--dates-per-chunk") options.datesPerChunk = Number(argv[++index]);
    else if (arg === "--max-workouts-per-chunk") options.maxWorkoutsPerChunk = Number(argv[++index]);
    else if (arg === "--max-rows-per-chunk") options.maxRowsPerChunk = Number(argv[++index]);
    else if (arg === "--max-rows-per-day") options.maxRowsPerDay = Number(argv[++index]);
    else if (arg === "--resume") options.resume = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg.startsWith("-")) throw new Error(`Unknown option ${arg}`);
    else if (!options.file) options.file = arg;
    else throw new Error("Unexpected argument");
  }
  return options;
}

export function progressPathFor(file) {
  return path.join(path.dirname(path.resolve(file)), ".health-import-progress.json");
}

export function chunkHash(chunk) {
  return createHash("sha256").update(JSON.stringify(chunk)).digest("hex");
}

export function fileSha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function rowCount(chunk) {
  return (chunk.points?.length || 0) + (chunk.workouts?.length || 0);
}

/** Split one date when it does not fit. Points stay in the earliest sub-chunk that has room. */
export function splitDateChunk(points, workouts, maxWorkouts, maxRows) {
  const chunks = [];
  let pointIndex = 0;
  let workoutIndex = 0;
  const workoutCap = Number.isFinite(maxWorkouts) ? maxWorkouts : Number.POSITIVE_INFINITY;
  const rowCap = Number.isFinite(maxRows) ? maxRows : Number.POSITIVE_INFINITY;
  while (pointIndex < points.length || workoutIndex < workouts.length) {
    const chunk = { points: [], workouts: [] };
    while (pointIndex < points.length && rowCount(chunk) < rowCap) {
      chunk.points.push(points[pointIndex]);
      pointIndex += 1;
    }
    while (workoutIndex < workouts.length && chunk.workouts.length < workoutCap && rowCount(chunk) < rowCap) {
      chunk.workouts.push(workouts[workoutIndex]);
      workoutIndex += 1;
    }
    if (rowCount(chunk) === 0) break;
    chunks.push(chunk);
  }
  return chunks.length ? chunks : [{ points: points || [], workouts: workouts || [] }];
}

/** Date windows, then a row and workout cap. One date's points stay in its first sub-chunk. */
export function splitImportChunks(points, workouts, { datesPerChunk = 31, maxWorkouts = 40, maxRows = Infinity } = {}) {
  const dated = chunkByDate(points, workouts, datesPerChunk);
  const chunks = [];
  for (const chunk of dated.length ? dated : [{ points: points || [], workouts: workouts || [] }]) {
    const dates = new Set([...(chunk.points || []).map((point) => point.date), ...(chunk.workouts || []).map((workout) => workout.date)]);
    if (dates.size <= 1) {
      const fitsWorkouts = (chunk.workouts || []).length <= maxWorkouts;
      const fitsRows = rowCount(chunk) <= maxRows;
      chunks.push(...(fitsWorkouts && fitsRows ? [chunk] : splitDateChunk(chunk.points || [], chunk.workouts || [], maxWorkouts, maxRows)));
      continue;
    }
    if ((chunk.workouts || []).length <= maxWorkouts && rowCount(chunk) <= maxRows) {
      chunks.push(chunk);
      continue;
    }
    chunks.push(...splitImportChunks(chunk.points, chunk.workouts, { datesPerChunk: 1, maxWorkouts, maxRows }));
  }
  return chunks;
}

function readProgress(file, sha256) {
  if (!fs.existsSync(file)) return { export_sha256: sha256, chunks: [] };
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (parsed.export_sha256 !== sha256) return { export_sha256: sha256, chunks: [] };
  return { export_sha256: sha256, chunks: Array.isArray(parsed.chunks) ? parsed.chunks : [] };
}

function writeProgress(file, progress) {
  const body = JSON.stringify({ export_sha256: progress.export_sha256, chunks: progress.chunks });
  fs.writeFileSync(file, body);
}

function acknowledged(progress, index, hash) {
  return progress.chunks.some((entry) => entry.index === index && entry.hash === hash);
}

async function pause(ms, sleep) {
  if (sleep) return sleep(ms);
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function halveChunk(chunk) {
  const points = chunk.points || [];
  const workouts = chunk.workouts || [];
  if (workouts.length > 1) {
    const mid = Math.ceil(workouts.length / 2);
    return [
      { points, workouts: workouts.slice(0, mid) },
      { points: [], workouts: workouts.slice(mid) },
    ];
  }
  if (points.length > 1) {
    const mid = Math.ceil(points.length / 2);
    return [
      { points: points.slice(0, mid), workouts },
      { points: points.slice(mid), workouts: [] },
    ];
  }
  return null;
}

async function postOne(fetchImpl, url, headers, chunk) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers,
    body: JSON.stringify(chunk),
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

/**
 * Post chunks. 413 split halves the chunk. 429 stops and prints Retry-After.
 * 5xx or an 1102 body backs off at most 5 times, then halves.
 */
export async function deliverChunks({
  url,
  token = "",
  chunks,
  sha256,
  progressFile,
  resume = false,
  fetchImpl = fetch,
  sleep,
  maxRowsPerDay = DEFAULT_MAX_ROWS_PER_DAY,
  log = console.error,
}) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const progress = resume ? readProgress(progressFile, sha256) : { export_sha256: sha256, chunks: [] };
  if (!resume) writeProgress(progressFile, progress);
  let points = 0;
  let workouts = 0;
  let rowsToday = 0;
  const dates = [];
  const queue = chunks.map((chunk, index) => ({ chunk, index }));
  let sent = 0;
  while (queue.length) {
    const item = queue.shift();
    const hash = chunkHash(item.chunk);
    if (resume && acknowledged(progress, item.index, hash)) continue;
    const rows = rowCount(item.chunk);
    if (rowsToday + rows > maxRowsPerDay) {
      log(`daily row budget reached; resume later (${maxRowsPerDay} rows)`);
      return { ok: false, stopped: "daily_budget", dates: [...new Set(dates)].sort(), points, workouts, sent };
    }
    let tries = 0;
    while (true) {
      const { response, body } = await postOne(fetchImpl, url, headers, item.chunk);
      const text = JSON.stringify(body);
      if (response.ok) {
        points += body.points || 0;
        workouts += body.workouts || 0;
        rowsToday += rows;
        for (const date of body.dates || []) dates.push(date);
        progress.chunks.push({ index: item.index, hash });
        writeProgress(progressFile, progress);
        sent += 1;
        break;
      }
      if (response.status === 413 && body.retry === "split") {
        const halves = halveChunk(item.chunk);
        if (!halves) throw new Error("chunk cannot be split");
        queue.unshift({ chunk: halves[1], index: item.index }, { chunk: halves[0], index: item.index });
        break;
      }
      if (response.status === 429) {
        const retryAfter = response.headers.get("retry-after") || "";
        log(`retry after ${retryAfter} seconds`);
        return { ok: false, stopped: "retry_after", retryAfter, dates: [...new Set(dates)].sort(), points, workouts, sent };
      }
      if (response.status >= 500 || text.includes("1102")) {
        tries += 1;
        if (tries <= 5) {
          await pause(2 ** (tries - 1) * 100, sleep);
          continue;
        }
        const halves = halveChunk(item.chunk);
        if (!halves) throw new Error(body.error || `HTTP ${response.status}`);
        queue.unshift({ chunk: halves[1], index: item.index }, { chunk: halves[0], index: item.index });
        break;
      }
      throw new Error(body.error || `HTTP ${response.status}`);
    }
  }
  return { ok: true, dates: [...new Set(dates)].sort(), points, workouts, sent };
}

export async function readServerLimits(chunkUrl, token, fetchImpl = fetch) {
  const limitsUrl = new URL("/limits", chunkUrl);
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetchImpl(limitsUrl, { headers });
  if (!response.ok) throw new Error("limits unavailable");
  return response.json();
}

async function postChunks(parsed, options) {
  let maxWorkouts = options.maxWorkoutsPerChunk;
  let maxRows = options.maxRowsPerChunk;
  if (maxWorkouts == null || maxRows == null) {
    const limits = await readServerLimits(options.chunkUrl, options.token, options.fetchImpl);
    if (maxWorkouts == null) maxWorkouts = limits.max_workouts;
    if (maxRows == null) maxRows = limits.max_rows == null ? Infinity : limits.max_rows;
  }
  const chunks = splitImportChunks(parsed.points, parsed.workouts, {
    datesPerChunk: options.datesPerChunk,
    maxWorkouts,
    maxRows,
  });
  const sha256 = options.sha256 || fileSha256(options.file);
  return deliverChunks({
    url: options.chunkUrl,
    token: options.token,
    chunks,
    sha256,
    progressFile: options.progressFile || progressPathFor(options.file),
    resume: options.resume,
    fetchImpl: options.fetchImpl,
    sleep: options.sleep,
    maxRowsPerDay: options.maxRowsPerDay,
    log: options.log,
  });
}

export async function runImport(options) {
  const timeZone = options.timeZone || DEFAULT_TIME_ZONE;
  const parsed = await parseAppleExport(fs.createReadStream(options.file), {
    timeZone,
    allow: storedMetricSet(process.env.HEALTH_METRIC_ALLOWLIST),
    sourcePriority: process.env.HEALTH_SOURCE_PRIORITY,
  });
  if (options.chunkUrl) return postChunks(parsed, options);

  const storage = await createNodeStorage(process.env);
  try {
    const now = new Date();
    const dates = [...new Set([...parsed.points.map((point) => point.date), ...parsed.workouts.map((workout) => workout.date)])].sort();
    const key = dates.length ? dates[dates.length - 1] : localDate(now.toISOString(), timeZone);
    const id = `${key}/${now.toISOString()}/${crypto.randomUUID().slice(0, 8)}`;
    await storage.insertIngest({
      id,
      date: key,
      receivedAt: now.toISOString(),
      bytes: parsed.bytes,
      payload: null,
      storeRaw: false,
      points: parsed.points,
      workouts: parsed.workouts.map((workout) => ({ ...workout, writer: "bearer" })),
    });
    return { ok: true, id, dates, points: parsed.samples, workouts: parsed.workouts.length };
  } finally {
    await storage.close?.();
  }
}

function isMainModule() {
  const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
  return entry === import.meta.url;
}

const USAGE = "Usage: node src/cli/import-apple-health.js <export.xml|export.zip> [--chunk-url URL] [--token TOKEN] [--time-zone TZ] [--dates-per-chunk N] [--max-workouts-per-chunk N] [--max-rows-per-chunk N] [--max-rows-per-day N] [--resume]";

if (isMainModule()) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help || !options.file) {
      console.error(USAGE);
      console.error("Prefer HEALTH_INGEST_TOKEN in the environment over --token. A token on the command line is visible to other users on the machine.");
      process.exit(options.help ? 0 : 1);
    }
    const result = await runImport(options);
    console.log(JSON.stringify(result));
    if (result.ok === false) process.exit(2);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
