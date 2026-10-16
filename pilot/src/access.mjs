import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RE_REVIEW_DATE, RESIDUAL_RISK_LINE, ROLE_LABELS, TOKEN_TTL_DAYS } from "./constants.mjs";

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const NAME = /\b[A-Z][a-z]{2,} [A-Z][a-z]{2,}\b/g;
const ALLOWED_PHRASES = ["Workers Scripts", "Workers Routes", "Account Analytics", "Time Travel"];

export function lintAccessDoc(text) {
  const errors = [];
  if (EMAIL.test(text)) errors.push("email");
  let stripped = text;
  for (const phrase of ALLOWED_PHRASES) stripped = stripped.split(phrase).join(" ");
  const names = stripped.match(NAME);
  if (names) errors.push(...names.map((name) => `personal name: ${name}`));
  for (const role of ROLE_LABELS) {
    if (!text.includes(role)) errors.push(`missing role ${role}`);
  }
  if (!text.includes(RESIDUAL_RISK_LINE)) errors.push("residual risk");
  if (!text.includes("2FA is required for every member")) errors.push("2fa");
  if (!text.includes("No Global API Key exists or is in use")) errors.push("global api key");
  if (!text.includes(RE_REVIEW_DATE)) errors.push("time-box date");
  if (!text.includes("before tenant 3")) errors.push("tenant 3");
  if (!text.includes("every Worker deploy and every secret change")) errors.push("audit alerts");
  if (!text.includes("has no GitHub OIDC")) errors.push("oidc");
  if (!text.includes(`${TOKEN_TTL_DAYS} days`)) errors.push("ttl");
  if (!text.includes("IP filter")) errors.push("ip filter");
  if (!text.includes("environment secret")) errors.push("environment secret");
  if (!text.includes("not issued")) errors.push("rotation dates");
  if (!text.includes("cannot be the person who triggered")) errors.push("distinct reviewer");
  if (!text.includes("free tier; upgrade when a real limit is hit")) errors.push("free tier");
  return errors;
}

export function accessDocPath() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "docs", "cf-access.md");
}

export function readAccessDoc() {
  return fs.readFileSync(accessDocPath(), "utf8");
}

export function assertTokenPolicy(policy) {
  const errors = [];
  if (policy.ttl_days !== TOKEN_TTL_DAYS) errors.push("ttl");
  if (policy.ip_filter !== true) errors.push("ip_filter");
  if (policy.storage !== "github_environment_secret") errors.push("storage");
  if (policy.oidc !== false) errors.push("oidc");
  if (policy.repo_secret !== false || policy.org_secret !== false) errors.push("repo or org secret");
  if (!/90 days/.test(policy.rotation || "")) errors.push("rotation");
  if (!/personnel or access change/.test(policy.rotation || "")) errors.push("rotation trigger");
  if (policy.rotation_dates !== "not issued") errors.push("rotation dates");
  if (errors.length) throw new Error(errors.join("; "));
}
