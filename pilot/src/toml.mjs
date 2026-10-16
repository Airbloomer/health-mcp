function stripComment(line) {
  let quote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') quote = !quote;
    else if (ch === "#" && !quote) return line.slice(0, i);
  }
  return line;
}

function parseValue(raw) {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw.startsWith('"') && raw.endsWith('"')) return JSON.parse(raw);
  return raw;
}

/** Subset parser for the tenant and registry templates. */
export function parseToml(text) {
  const doc = { values: {}, sections: {}, arrays: {} };
  let bucket = doc.values;
  for (const rawLine of String(text).split(/\n/)) {
    const line = stripComment(rawLine).trim();
    if (!line) continue;
    const array = line.match(/^\[\[([A-Za-z0-9_.-]+)\]\]$/);
    if (array) {
      const name = array[1];
      doc.arrays[name] ||= [];
      bucket = {};
      doc.arrays[name].push(bucket);
      continue;
    }
    const section = line.match(/^\[([A-Za-z0-9_.-]+)\]$/);
    if (section) {
      const name = section[1];
      doc.sections[name] ||= {};
      bucket = doc.sections[name];
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!kv) throw new Error(`cannot parse toml line: ${line}`);
    bucket[kv[1]] = parseValue(kv[2].trim());
  }
  return doc;
}
