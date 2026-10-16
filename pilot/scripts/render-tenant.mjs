import fs from "node:fs";
import path from "node:path";
import { maskLines, renderTenant } from "../src/render.mjs";

const tenantId = process.argv[2];
const out = process.argv[3];
if (!tenantId || !out) {
  console.error("usage: render-tenant.mjs <tenant-id> <output.rendered.toml>");
  process.exit(1);
}
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || "";
const d1Id = process.env.D1_ID || "";
const rendered = renderTenant({
  tenantId,
  accountId,
  d1Id,
  compatDate: process.env.COMPAT_DATE || "2026-09-22",
});
if (process.env.GITHUB_ACTIONS) {
  for (const line of maskLines([accountId, d1Id])) console.log(line);
}
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, rendered);
console.log("wrote rendered config");
