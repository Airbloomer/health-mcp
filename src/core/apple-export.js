import { storedMetricSet } from "./aggregate.js";
import { durationMinutesFromSeconds, hkQuantityMetric, hkWorkoutName, quantitySample, toKcal } from "./hk.js";
import { DEFAULT_TIME_ZONE, LATEST_METRICS } from "./metrics.js";
import { localDate } from "./parse.js";

const MAX_TAG_CHARS = 1_000_000;

/** Decompressed export.xml larger than this is rejected. */
export const MAX_APPLE_UNCOMPRESSED_BYTES = 10_000_000_000;

/** After this much output, a ratio above APPLE_COMPRESSION_RATIO is a zip bomb. */
export const APPLE_COMPRESSION_RATIO_FLOOR = 100_000_000;

export const APPLE_COMPRESSION_RATIO = 200;

/** A fresh string. Regex slices keep the whole input chunk alive in V8. */
function flatString(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(String(value)));
}

function exportError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function payloadTooLarge() {
  return exportError("PAYLOAD_TOO_LARGE");
}

/** Comma-separated `HEALTH_SOURCE_PRIORITY`. Empty means pick the largest total. */
export function parseSourcePriority(value) {
  if (value == null || value === false) return [];
  const list = Array.isArray(value) ? value : String(value).split(",");
  return list.map((name) => name.trim()).filter(Boolean);
}

function assertDecompressionBudget(compSize, uncompressed) {
  if (uncompressed > MAX_APPLE_UNCOMPRESSED_BYTES || compSize > MAX_APPLE_UNCOMPRESSED_BYTES) throw payloadTooLarge();
  if (compSize > 0 && uncompressed > APPLE_COMPRESSION_RATIO_FLOOR && uncompressed / compSize > APPLE_COMPRESSION_RATIO) {
    throw payloadTooLarge();
  }
}

function noteDecompressed(produced, compSize, uncompressed) {
  if (produced > uncompressed || produced > MAX_APPLE_UNCOMPRESSED_BYTES) throw payloadTooLarge();
  if (compSize > 0 && produced > APPLE_COMPRESSION_RATIO_FLOOR && produced / compSize > APPLE_COMPRESSION_RATIO) {
    throw payloadTooLarge();
  }
}

export function decodeXml(value) {
  return String(value).replace(/&(#x?[0-9a-fA-F]+|[A-Za-z]+);/g, (entity, body) => {
    const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (Object.hasOwn(named, body)) return named[body];
    if (body[0] !== "#") return entity;
    const hex = body[1] === "x" || body[1] === "X";
    const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return entity;
    return String.fromCodePoint(code);
  });
}

function attributes(tag) {
  const out = {};
  const re = /([^\s=<>\/]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  for (const match of tag.matchAll(re)) out[match[1]] = decodeXml(match[3] ?? match[4] ?? "");
  return out;
}

function isBoundary(char) {
  return char === " " || char === ">" || char === "/" || char === "\n" || char === "\r" || char === "\t";
}

function indexOfTagEnd(xml) {
  let quote = "";
  for (let i = 0; i < xml.length; i += 1) {
    const char = xml[i];
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ">") return i;
  }
  return -1;
}

function findClose(buf, name) {
  const needle = `</${name}`;
  let from = 0;
  while (from < buf.length) {
    const at = buf.indexOf(needle, from);
    if (at < 0) return null;
    const next = buf[at + needle.length];
    if (next == null) return { at, partial: true };
    if (next === ">" || isBoundary(next)) {
      const gt = buf.indexOf(">", at);
      if (gt < 0) return { at, partial: true };
      return { end: gt + 1, partial: false };
    }
    from = at + needle.length;
  }
  return null;
}

function tail(buf, size) {
  return buf.length <= size ? buf : buf.slice(buf.length - size);
}

function appleInstant(value) {
  const match = String(value).match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\s*([+-]\d{2}):?(\d{2}))?/);
  if (!match) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
  }
  const offset = match[3] ? `${match[3]}:${match[4]}` : "Z";
  const parsed = new Date(`${match[1]}T${match[2]}${offset}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
}

function durationSeconds(value, unit) {
  if (value == null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const name = String(unit || "min").trim().toLowerCase();
  if (name === "min" || name === "mins" || name === "minute" || name === "minutes") return number * 60;
  if (name === "h" || name === "hr" || name === "hrs" || name === "hour" || name === "hours") return number * 3600;
  return number;
}

function tagAt(buf, name) {
  const needle = `<${name}`;
  if (!buf.startsWith(needle)) return needle.startsWith(buf) ? "partial" : "no";
  const next = buf[needle.length];
  if (next == null) return "partial";
  return isBoundary(next) ? "yes" : "no";
}

function chooseSource(list, priority) {
  for (const name of priority) {
    const match = list.find((bucket) => bucket.source === name);
    if (match) return match;
  }
  const latest = Object.hasOwn(LATEST_METRICS, list[0].metric);
  return list.reduce((best, bucket) => {
    if (!best) return bucket;
    if (latest) {
      if (String(bucket.last_ts) > String(best.last_ts)) return bucket;
      if (bucket.last_ts === best.last_ts && bucket.n > best.n) return bucket;
      return best;
    }
    if (bucket.sum > best.sum || (bucket.sum === best.sum && bucket.n > best.n)) return bucket;
    return best;
  }, null);
}

function chooseBuckets(days, priority, exportDay) {
  const groups = new Map();
  for (const bucket of days.values()) {
    if (exportDay && bucket.date >= exportDay) continue;
    const key = `${bucket.metric}\0${bucket.date}`;
    const list = groups.get(key);
    if (list) list.push(bucket);
    else groups.set(key, [bucket]);
  }
  const rows = [];
  let samples = 0;
  for (const list of groups.values()) {
    const chosen = chooseSource(list, priority);
    samples += chosen.seen;
    rows.push({
      metric: chosen.metric,
      date: chosen.date,
      sum_qty: chosen.sum,
      last_qty: chosen.last_qty,
      last_ts: chosen.last_ts,
      units: chosen.units ?? null,
      n: chosen.n,
    });
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.metric < b.metric ? -1 : a.metric > b.metric ? 1 : 0));
  return { rows, samples };
}

/**
 * Streaming parser for Apple's Health export.xml.
 * Each allowed (metric, date, sourceName) keeps a running sum, latest
 * sample, and count. Individual samples are not retained. For each
 * metric-day the source with the largest sum is kept. Weight and body
 * fat keep the source with the newest reading. `sourcePriority` wins
 * over both when it names a source that is present.
 * A repeated timestamp equal to that bucket's latest timestamp replaces
 * the previous quantity instead of adding a second sample.
 */
export function createAppleExportParser(options = {}) {
  const timeZone = options.timeZone || DEFAULT_TIME_ZONE;
  const allow = options.allow || storedMetricSet(options.metricAllowlist);
  const priority = parseSourcePriority(options.sourcePriority);
  const days = new Map();
  const workouts = new Map();
  let buf = "";
  let mode = "text";
  let skipping = "";
  let sawExport = false;
  let exportDay = null;
  let doctypeState = null;

  function addRecord(tag) {
    const attrs = attributes(tag);
    const metric = hkQuantityMetric(attrs.type);
    if (!metric || !allow.has(metric)) return;
    const sample = quantitySample(metric, Number(attrs.value), attrs.unit);
    const ts = attrs.startDate || attrs.endDate;
    if (!sample || !ts) return;
    const date = localDate(ts, timeZone);
    if (!date) return;
    const metricName = flatString(metric);
    const day = flatString(date);
    const source = flatString(attrs.sourceName == null ? "" : attrs.sourceName);
    const stamp = flatString(ts);
    const units = sample.units == null ? null : flatString(sample.units);
    const key = `${metricName}\0${day}\0${source}`;
    let bucket = days.get(key);
    if (!bucket) {
      bucket = { metric: metricName, date: day, source, sum: 0, n: 0, seen: 0, last_qty: null, last_ts: null, units: null };
      days.set(key, bucket);
    }
    bucket.seen += 1;
    if (bucket.last_ts === stamp) {
      bucket.sum += sample.qty - bucket.last_qty;
      bucket.last_qty = sample.qty;
      bucket.units = units;
      return;
    }
    bucket.sum += sample.qty;
    bucket.n += 1;
    if (bucket.last_ts == null || stamp >= bucket.last_ts) {
      bucket.last_ts = stamp;
      bucket.last_qty = sample.qty;
      bucket.units = units;
    }
  }

  function addWorkout(tag) {
    const attrs = attributes(tag);
    if (!attrs.startDate) return;
    const date = localDate(attrs.startDate, timeZone);
    if (!date) return;
    let seconds = durationSeconds(attrs.duration, attrs.durationUnit);
    if (seconds == null && attrs.endDate) {
      const start = appleInstant(attrs.startDate);
      const end = appleInstant(attrs.endDate);
      if (start != null && end != null) seconds = (end - start) / 1000;
    }
    let kcal = attrs.totalEnergyBurned == null || attrs.totalEnergyBurned === "" ? null : Number(attrs.totalEnergyBurned);
    if (!Number.isFinite(kcal)) kcal = null;
    if (kcal != null) kcal = Math.round(toKcal(kcal, attrs.totalEnergyBurnedUnit));
    const name = flatString(hkWorkoutName(attrs.workoutActivityType || ""));
    const start = flatString(attrs.startDate);
    const day = flatString(date);
    workouts.set(`${name}\0${start}`, {
      name,
      start,
      date: day,
      duration_min: durationMinutesFromSeconds(seconds),
      kcal,
    });
  }

  function scanDoctype() {
    let index = 0;
    while (index < buf.length) {
      const char = buf[index];
      if (doctypeState.quote) {
        if (char === doctypeState.quote) doctypeState.quote = "";
        index += 1;
        continue;
      }
      if (char === '"' || char === "'") {
        doctypeState.quote = char;
        index += 1;
        continue;
      }
      doctypeState.window = (doctypeState.window + char).slice(-24);
      if (/<!ENTITY[\s>]/i.test(doctypeState.window)) throw exportError("INVALID_EXPORT");
      if (/(?:^|[^A-Za-z])SYSTEM[^A-Za-z]/.test(doctypeState.window)) throw exportError("INVALID_EXPORT");
      if (/(?:^|[^A-Za-z])PUBLIC[^A-Za-z]/.test(doctypeState.window)) throw exportError("INVALID_EXPORT");
      if (char === "[") doctypeState.depth += 1;
      else if (char === "]" && doctypeState.depth > 0) doctypeState.depth -= 1;
      else if (char === ">" && doctypeState.depth === 0) {
        buf = buf.slice(index + 1);
        return true;
      }
      index += 1;
    }
    buf = "";
    return false;
  }

  function takeTag(name) {
    const end = indexOfTagEnd(buf);
    if (end < 0) {
      if (buf.length > MAX_TAG_CHARS) throw exportError("INVALID_EXPORT");
      return null;
    }
    const tag = buf.slice(0, end + 1);
    buf = buf.slice(end + 1);
    sawExport = true;
    if (name === "Record") {
      addRecord(tag);
      if (!tag.endsWith("/>")) skipping = "Record";
    } else if (name === "Workout") {
      addWorkout(tag);
      if (!tag.endsWith("/>")) skipping = "Workout";
    } else if (name === "ExportDate") {
      const value = attributes(tag).value;
      if (value) exportDay = localDate(value, timeZone) || exportDay;
    }
    return tag;
  }

  function pump() {
    while (buf.length || mode === "doctype") {
      if (mode === "comment") {
        const end = buf.indexOf("-->");
        if (end < 0) {
          buf = tail(buf, 2);
          return;
        }
        buf = buf.slice(end + 3);
        mode = "text";
        continue;
      }
      if (mode === "cdata") {
        const end = buf.indexOf("]]>");
        if (end < 0) {
          buf = tail(buf, 2);
          return;
        }
        buf = buf.slice(end + 3);
        mode = "text";
        continue;
      }
      if (mode === "pi") {
        const end = buf.indexOf("?>");
        if (end < 0) {
          buf = tail(buf, 1);
          return;
        }
        buf = buf.slice(end + 2);
        mode = "text";
        continue;
      }
      if (mode === "doctype") {
        if (!buf.length) return;
        if (!scanDoctype()) return;
        mode = "text";
        doctypeState = null;
        continue;
      }
      if (skipping) {
        const closed = findClose(buf, skipping);
        if (!closed) {
          buf = tail(buf, 24);
          return;
        }
        if (closed.partial) {
          buf = buf.slice(closed.at);
          return;
        }
        buf = buf.slice(closed.end);
        skipping = "";
        continue;
      }
      if (!buf.length) return;
      const start = buf.indexOf("<");
      if (start < 0) {
        buf = "";
        return;
      }
      if (start > 0) buf = buf.slice(start);
      if (buf.startsWith("<!--")) {
        mode = "comment";
        buf = buf.slice(4);
        continue;
      }
      if ("<!--".startsWith(buf)) return;
      if (buf.startsWith("<![CDATA[")) {
        mode = "cdata";
        buf = buf.slice(9);
        continue;
      }
      if ("<![CDATA[".startsWith(buf)) return;
      if (buf.startsWith("<?")) {
        mode = "pi";
        buf = buf.slice(2);
        continue;
      }
      if (buf === "<") return;
      if (/^<!DOCTYPE(?=[\s>])/i.test(buf)) {
        mode = "doctype";
        doctypeState = { depth: 0, quote: "", window: "" };
        buf = buf.slice(buf.match(/^<!DOCTYPE/i)[0].length);
        continue;
      }
      if (/^<!DOC/i.test(buf) && buf.length < "<!DOCTYPE ".length) return;
      if (/^<!ENTITY(?=[\s>])/i.test(buf)) throw exportError("INVALID_EXPORT");
      if (/^<!ENT/i.test(buf) && buf.length < "<!ENTITY ".length) return;
      if (buf.startsWith("<!")) {
        const end = indexOfTagEnd(buf);
        if (end < 0) {
          if (buf.length > MAX_TAG_CHARS) throw exportError("INVALID_EXPORT");
          return;
        }
        buf = buf.slice(end + 1);
        continue;
      }
      const names = ["Record", "Workout", "ExportDate", "HealthData"];
      let matched = "";
      let waiting = false;
      for (const name of names) {
        const kind = tagAt(buf, name);
        if (kind === "yes") {
          matched = name;
          break;
        }
        if (kind === "partial") waiting = true;
      }
      if (waiting && !matched) return;
      if (!matched) {
        const end = indexOfTagEnd(buf);
        if (end < 0) {
          if (buf.length > MAX_TAG_CHARS) throw exportError("INVALID_EXPORT");
          return;
        }
        buf = buf.slice(end + 1);
        continue;
      }
      if (!takeTag(matched)) return;
    }
  }

  return {
    push(text) {
      if (text) buf += text;
      pump();
    },
    /** Number of running aggregates retained. This does not grow with sample count. */
    bucketCount() {
      return days.size;
    },
    finish() {
      pump();
      if (mode !== "text" || skipping || doctypeState) throw exportError("INVALID_EXPORT");
      if (buf.includes("<Record") || buf.includes("<Workout") || buf.includes("<HealthData") || buf.includes("<ExportDate")) {
        throw exportError("INVALID_EXPORT");
      }
      if (!sawExport) throw exportError("INVALID_EXPORT");
      const chosen = chooseBuckets(days, priority, exportDay);
      const keptWorkouts = [...workouts.values()]
        .filter((workout) => !exportDay || workout.date < exportDay)
        .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
      return {
        points: chosen.rows,
        workouts: keptWorkouts,
        samples: chosen.samples,
        exportDay,
      };
    },
  };
}

function u16(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function u32(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

class ByteQueue {
  constructor(iterator) {
    this.iterator = iterator;
    this.chunks = [];
    this.buffered = 0;
    this.offset = 0;
    this.done = false;
    this.bytesRead = 0;
  }

  async pull() {
    if (this.done) return false;
    const next = await this.iterator.next();
    if (next.done) {
      this.done = true;
      return false;
    }
    const chunk = next.value instanceof Uint8Array ? next.value : new Uint8Array(next.value);
    if (!chunk.length) return this.pull();
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    return true;
  }

  async read(size) {
    while (this.buffered < size && !this.done) {
      if (!(await this.pull())) break;
    }
    const take = Math.min(size, this.buffered);
    const out = new Uint8Array(take);
    let filled = 0;
    while (filled < take) {
      const chunk = this.chunks[0];
      const slice = Math.min(chunk.length - this.offset, take - filled);
      out.set(chunk.subarray(this.offset, this.offset + slice), filled);
      filled += slice;
      this.offset += slice;
      this.buffered -= slice;
      if (this.offset >= chunk.length) {
        this.chunks.shift();
        this.offset = 0;
      }
    }
    this.bytesRead += take;
    return out;
  }

  async readExact(size) {
    const out = await this.read(size);
    if (out.length !== size) throw exportError("INVALID_ZIP");
    return out;
  }

  async skip(size) {
    let left = size;
    while (left > 0) {
      const chunk = await this.read(Math.min(left, 65536));
      if (!chunk.length) throw exportError("INVALID_ZIP");
      left -= chunk.length;
    }
  }
}

async function writeEntry(queue, method, compSize, uncompressed, parser) {
  assertDecompressionBudget(compSize, uncompressed);
  const decoder = new TextDecoder();
  let produced = 0;
  const accept = (bytes) => {
    produced += bytes.byteLength;
    noteDecompressed(produced, compSize, uncompressed);
    parser.push(decoder.decode(bytes, { stream: true }));
  };
  if (method === 0) {
    let left = compSize;
    while (left > 0) {
      const chunk = await queue.readExact(Math.min(left, 65536));
      left -= chunk.length;
      accept(chunk);
    }
    parser.push(decoder.decode());
    return;
  }

  const stream = new DecompressionStream("deflate-raw");
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const pump = (async () => {
    let left = compSize;
    try {
      while (left > 0) {
        const chunk = await queue.readExact(Math.min(left, 65536));
        left -= chunk.length;
        await writer.write(chunk);
      }
      await writer.close();
    } catch (error) {
      await writer.abort(error).catch(() => {});
      throw error;
    }
  })();
  const consume = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        accept(value);
      }
      parser.push(decoder.decode());
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    }
  })();
  try {
    await Promise.all([pump, consume]);
  } catch (error) {
    if (error?.code === "INVALID_ZIP" || error?.code === "UNSUPPORTED_ZIP" || error?.code === "INVALID_EXPORT" || error?.code === "PAYLOAD_TOO_LARGE") {
      throw error;
    }
    throw exportError("INVALID_ZIP");
  }
}

async function readZip(queue, parser) {
  let found = false;
  let signature = 0x04034b50;
  let haveSignature = true;
  while (true) {
    if (!haveSignature) {
      const raw = await queue.read(4);
      if (raw.length < 4) {
        if (!found) throw exportError("INVALID_EXPORT");
        return;
      }
      signature = u32(raw, 0);
    }
    haveSignature = false;
    if (signature === 0x02014b50 || signature === 0x06054b50) {
      if (!found) throw exportError("INVALID_EXPORT");
      return;
    }
    if (signature !== 0x04034b50) throw exportError("INVALID_ZIP");
    const header = await queue.readExact(26);
    const flags = u16(header, 2);
    const method = u16(header, 4);
    const compSize = u32(header, 14);
    const uncompressed = u32(header, 18);
    const nameLen = u16(header, 22);
    const extraLen = u16(header, 24);
    if (flags & 0x1 || flags & 0x8) throw exportError("UNSUPPORTED_ZIP");
    if (compSize === 0xffffffff || uncompressed === 0xffffffff) throw exportError("UNSUPPORTED_ZIP");
    if (method !== 0 && method !== 8) throw exportError("UNSUPPORTED_ZIP");
    const name = new TextDecoder().decode(await queue.readExact(nameLen)).replaceAll("\\", "/");
    await queue.skip(extraLen);
    const wanted = name.toLowerCase().endsWith("/export.xml") || name.toLowerCase() === "export.xml";
    if (!wanted) {
      await queue.skip(compSize);
      continue;
    }
    found = true;
    await writeEntry(queue, method, compSize, uncompressed, parser);
    return;
  }
}

async function drain(queue) {
  while (true) {
    const chunk = await queue.read(65536);
    if (!chunk.length) return;
  }
}

async function parseQueue(queue, parser) {
  const head = await queue.read(4);
  const zip = head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
  if (zip) {
    await readZip(queue, parser);
    await drain(queue);
    return;
  }
  const decoder = new TextDecoder();
  if (head.length) parser.push(decoder.decode(head, { stream: true }));
  while (true) {
    const chunk = await queue.read(65536);
    if (!chunk.length) break;
    parser.push(decoder.decode(chunk, { stream: true }));
  }
  parser.push(decoder.decode());
}

/**
 * Parse export.xml or a zip that contains it.
 * `source` is a string, Uint8Array, or async iterable of bytes.
 */
export async function parseAppleExport(source, options = {}) {
  const parser = createAppleExportParser(options);
  if (typeof source === "string") {
    parser.push(source);
    const result = parser.finish();
    result.bytes = new TextEncoder().encode(source).length;
    return result;
  }
  const iterable = source instanceof Uint8Array
    ? (async function* bytes() { yield source; })()
    : source;
  const queue = new ByteQueue(iterable[Symbol.asyncIterator]());
  await parseQueue(queue, parser);
  const result = parser.finish();
  result.bytes = queue.bytesRead;
  return result;
}

/** True when the body starts like export.xml or a zip local file header. */
export function looksLikeAppleExport(bytes) {
  let index = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) index = 3;
  while (index < bytes.length && (bytes[index] === 0x20 || bytes[index] === 0x09 || bytes[index] === 0x0a || bytes[index] === 0x0d)) index += 1;
  if (index < bytes.length && bytes[index] === 0x3c) return true;
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Null when `body` is a chunk of whole-day rows. Otherwise "invalid_payload".
 * Each (metric, date) and each (name, start) may appear once.
 */
export function appleChunkError(body) {
  if (!isPlainObject(body)) return "invalid_payload";
  if (!Object.hasOwn(body, "points") && !Object.hasOwn(body, "workouts")) return "invalid_payload";
  const points = body.points ?? [];
  const workouts = body.workouts ?? [];
  if (!Array.isArray(points) || !Array.isArray(workouts)) return "invalid_payload";
  const seen = new Set();
  for (const point of points) {
    if (!isPlainObject(point)) return "invalid_payload";
    if (typeof point.metric !== "string" || !point.metric.trim()) return "invalid_payload";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(point.date || "")) return "invalid_payload";
    if (typeof point.sum_qty !== "number" || !Number.isFinite(point.sum_qty)) return "invalid_payload";
    if (typeof point.last_qty !== "number" || !Number.isFinite(point.last_qty)) return "invalid_payload";
    if (typeof point.last_ts !== "string" || !point.last_ts) return "invalid_payload";
    if (!Number.isInteger(point.n) || point.n < 1) return "invalid_payload";
    if (point.units != null && typeof point.units !== "string") return "invalid_payload";
    const key = `${point.metric}\0${point.date}`;
    if (seen.has(key)) return "invalid_payload";
    seen.add(key);
  }
  const seenWorkouts = new Set();
  for (const workout of workouts) {
    if (!isPlainObject(workout)) return "invalid_payload";
    if (typeof workout.name !== "string" || !workout.name) return "invalid_payload";
    if (typeof workout.start !== "string" || !workout.start) return "invalid_payload";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(workout.date || "")) return "invalid_payload";
    if (workout.duration_min != null && (typeof workout.duration_min !== "number" || !Number.isFinite(workout.duration_min))) {
      return "invalid_payload";
    }
    if (workout.kcal != null && (typeof workout.kcal !== "number" || !Number.isFinite(workout.kcal))) return "invalid_payload";
    const key = `${workout.name}\0${workout.start}`;
    if (seenWorkouts.has(key)) return "invalid_payload";
    seenWorkouts.add(key);
  }
  return null;
}

/** Split already-aggregated rows into chunks that each contain whole dates. */
export function chunkByDate(points, workouts, datesPerChunk = 31) {
  const size = Math.max(1, Number(datesPerChunk) || 31);
  const dates = [...new Set([...(points || []).map((point) => point.date), ...(workouts || []).map((workout) => workout.date)])].sort();
  const chunks = [];
  for (let index = 0; index < dates.length; index += size) {
    const window = new Set(dates.slice(index, index + size));
    chunks.push({
      points: (points || []).filter((point) => window.has(point.date)),
      workouts: (workouts || []).filter((workout) => window.has(workout.date)),
    });
  }
  return chunks;
}
