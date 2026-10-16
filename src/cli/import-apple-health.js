import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createNodeStorage } from "../adapters/node.js";
import { storedMetricSet } from "../core/aggregate.js";
import { chunkByDate, parseAppleExport } from "../core/apple-export.js";
import { DEFAULT_TIME_ZONE } from "../core/metrics.js";
import { localDate } from "../core/parse.js";

function parseArgs(argv) {
  const options = {
    file: "",
    chunkUrl: "",
    token: process.env.HEALTH_INGEST_TOKEN || "",
    timeZone: process.env.HEALTH_TIMEZONE || "",
    datesPerChunk: 31,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--chunk-url") options.chunkUrl = argv[++index] || "";
    else if (arg === "--token") options.token = argv[++index] || "";
    else if (arg === "--time-zone") options.timeZone = argv[++index] || "";
    else if (arg === "--dates-per-chunk") options.datesPerChunk = Number(argv[++index]);
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg.startsWith("-")) throw new Error(`Unknown option ${arg}`);
    else if (!options.file) options.file = arg;
    else throw new Error("Unexpected argument");
  }
  return options;
}

async function postChunks(parsed, options) {
  const chunks = chunkByDate(parsed.points, parsed.workouts, options.datesPerChunk);
  const headers = { "content-type": "application/json" };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  let points = 0;
  let workouts = 0;
  const dates = [];
  const batches = chunks.length ? chunks : [{ points: [], workouts: [] }];
  for (const chunk of batches) {
    const response = await fetch(options.chunkUrl, { method: "POST", headers, body: JSON.stringify(chunk) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    points += body.points || 0;
    workouts += body.workouts || 0;
    for (const date of body.dates || []) dates.push(date);
  }
  return { ok: true, dates: [...new Set(dates)].sort(), points, workouts };
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
      workouts: parsed.workouts,
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

if (isMainModule()) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help || !options.file) {
      console.error("Usage: node src/cli/import-apple-health.js <export.xml|export.zip> [--chunk-url URL] [--token TOKEN] [--time-zone TZ] [--dates-per-chunk N]");
      console.error("Prefer HEALTH_INGEST_TOKEN in the environment over --token. A token on the command line is visible to other users on the machine.");
      process.exit(options.help ? 0 : 1);
    }
    const result = await runImport(options);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
