/**
 * Workflow supply-chain lint for this package.
 */

function stripYamlComments(text) {
  return String(text).split("\n").map((line) => {
    let quote = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '"' || ch === "'") quote = !quote;
      else if (ch === "#" && !quote) return line.slice(0, i);
    }
    return line;
  }).join("\n");
}

function triggersPullRequest(text) {
  return /(^|\n)\s*pull_request\s*:/.test(text) || /(^|\n)on:\s*\[[^\]]*pull_request/.test(text);
}

function wranglerLineUnpinned(line) {
  const invokes = /wrangler@/.test(line)
    || /npx\s+wrangler\b/.test(line)
    || (/\bnpm\s+exec\b/.test(line) && /\bwrangler\b/.test(line));
  if (!invokes) return false;
  return !/wrangler@\d+\.\d+\.\d+\b/.test(line);
}

/**
 * Supply-chain lint for a workflow file.
 * `publish.yml` may set job-level `id-token: write` for npm OIDC provenance.
 * Every other write permission is rejected. An exact `wrangler@x.y.z` is a pin;
 * `latest`, a bare `npx wrangler`, and `npm exec` without that pin are not.
 */
export function lintWorkflowText(name, text) {
  const errors = [];
  const code = stripYamlComments(text);
  if (code.includes("pull_request_target")) errors.push(`${name}: pull_request_target`);
  if (/contents:\s*write/.test(code)) errors.push(`${name}: contents write`);
  for (const line of code.split("\n")) {
    if (wranglerLineUnpinned(line)) errors.push(`${name}: unpinned wrangler`);
    if (/\bnpm\s+i\s+-g\b/.test(line)) errors.push(`${name}: npm i -g`);
    for (const item of line.match(/\bnpm\s+install\s+-g\s+\S+/g) || []) {
      if (!/@\d+\.\d+\.\d+\b/.test(item)) errors.push(`${name}: unpinned npm install -g`);
    }
  }
  if (/persist-credentials:\s*['"]?true\b/.test(code)) errors.push(`${name}: persist-credentials true`);
  if (/permissions:\s*write-all\b/.test(code) || /(^|\n)\s*write-all\s*$/.test(code)) {
    errors.push(`${name}: write-all`);
  }
  if (triggersPullRequest(code) && /(^|\n)\s*environment\s*:/.test(code)) {
    errors.push(`${name}: environment in a pull_request workflow`);
  }
  if (/secrets\s*\[/.test(code)) errors.push(`${name}: secrets bracket syntax`);
  if (triggersPullRequest(code) && /secrets\./.test(code)) {
    errors.push(`${name}: pull_request workflow references secrets`);
  }

  const lines = code.split("\n");
  let sawTopPermissions = false;
  for (let i = 0; i < lines.length; i += 1) {
    const header = lines[i].match(/^(\s*)permissions:\s*(\S.*)?$/);
    if (!header) continue;
    const indent = header[1].length;
    const inline = (header[2] || "").trim();
    const topLevel = indent === 0;
    if (topLevel) sawTopPermissions = true;
    if (inline) {
      if (/^write-all\b/.test(inline)) errors.push(`${name}: write-all`);
      else if (topLevel) errors.push(`${name}: extra top-level permission ${inline}`);
      else if (!/^read$/.test(inline)) errors.push(`${name}: job permission ${inline}`);
      continue;
    }
    const keys = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j].trim() === "") continue;
      const inner = lines[j].match(/^(\s*)(\S.*)$/);
      if (!inner || inner[1].length <= indent) break;
      const key = inner[2].match(/^([A-Za-z0-9_-]+):\s*(\S+)/);
      if (key) keys.push([key[1], key[2]]);
    }
    if (topLevel) {
      if (!keys.some(([key, value]) => key === "contents" && value === "read")) {
        errors.push(`${name}: top-level contents: read`);
      }
      for (const [key, value] of keys) {
        if (key === "contents" && value === "read") continue;
        errors.push(`${name}: extra top-level permission ${key}`);
      }
    } else {
      for (const [key, value] of keys) {
        if (value === "read") continue;
        if (name === "publish.yml" && key === "id-token" && value === "write") continue;
        if (key === "write-all" || value === "write-all") errors.push(`${name}: write-all`);
        else errors.push(`${name}: job permission ${key}: ${value}`);
      }
    }
  }
  if (!sawTopPermissions) errors.push(`${name}: missing top-level permissions`);

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.includes("uses:") || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/uses:\s+(\S+)\s+#\s+(v\S+)\s*$/);
    if (!match) {
      errors.push(`${name}: unpinned or uncommented action (${trimmed})`);
      continue;
    }
    if (!/@[0-9a-f]{40}$/.test(match[1])) errors.push(`${name}: action is not a full sha`);
  }
  return errors;
}
