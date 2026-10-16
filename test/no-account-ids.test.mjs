import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = new Set(["node_modules", ".git"]);

test("the whole repo has no account-shaped ids", () => {
  const accountIds = [];
  const shortIds = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      let text;
      try {
        text = fs.readFileSync(full, "utf8");
      } catch {
        continue;
      }
      if (text.includes("\0")) continue;
      const rel = path.relative(root, full);
      for (const match of text.matchAll(/\b[0-9a-f]{32}\b/g)) accountIds.push(`${rel}:${match[0]}`);
      for (const match of text.matchAll(/\b[a-z2-7]{26}\b/g)) shortIds.push(`${rel}:${match[0]}`);
    }
  }
  walk(root);
  assert.deepEqual(accountIds, []);
  assert.deepEqual(shortIds, []);
});
