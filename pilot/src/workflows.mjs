import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HMAC_SECRET_PREFIX,
  REGISTRY_ADMIN_ENVIRONMENT,
  REGISTRY_ADMIN_SECRET,
  REGISTRY_SCRIPT,
  TENANT_DEPLOY_ENVIRONMENT,
  TENANT_DEPLOY_SECRET,
} from "./constants.mjs";
import { USAGE_CRONS } from "./usage.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function workflowDir() {
  return path.join(repoRoot, ".github", "workflows");
}

export function readWorkflows() {
  const dir = workflowDir();
  const files = {};
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".yml") && !name.endsWith(".yaml")) continue;
    files[name] = fs.readFileSync(path.join(dir, name), "utf8");
  }
  return files;
}

export function lintWorkflowText(name, text) {
  const errors = [];
  if (text.includes("pull_request_target")) errors.push(`${name}: pull_request_target`);
  if (/contents:\s*write/.test(text)) errors.push(`${name}: contents write`);
  if (/wrangler@latest/.test(text) || /npx\s+wrangler/.test(text)) errors.push(`${name}: floating wrangler`);

  const jobsAt = text.search(/^jobs:/m);
  const head = jobsAt === -1 ? text : text.slice(0, jobsAt);
  if (!/^permissions:\s*$/m.test(head)) errors.push(`${name}: missing top-level permissions`);
  if (!/contents:\s*read/.test(head)) errors.push(`${name}: top-level contents: read`);

  const lines = text.split(/\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.includes("uses:")) continue;
    const match = trimmed.match(/uses:\s+(\S+)\s+#\s+(v\S+)\s*$/);
    if (!match) {
      errors.push(`${name}: unpinned or uncommented action (${trimmed})`);
      continue;
    }
    if (!/@[0-9a-f]{40}$/.test(match[1])) errors.push(`${name}: action is not a full sha`);
  }

  if (/pull_request:/.test(text) && /secrets\./.test(text)) {
    errors.push(`${name}: pull_request workflow references secrets`);
  }
  return errors;
}

export function lintEnvironmentSplit(files) {
  const errors = [];
  const tenant = files["pilot-tenant-deploy.yml"] || "";
  const registry = files["pilot-registry.yml"] || "";
  if (!tenant) errors.push("missing tenant workflow");
  if (!registry) errors.push("missing registry workflow");
  for (const word of [REGISTRY_ADMIN_ENVIRONMENT, REGISTRY_ADMIN_SECRET, HMAC_SECRET_PREFIX]) {
    if (tenant.includes(word)) errors.push(`tenant workflow references ${word}`);
  }
  for (const word of [TENANT_DEPLOY_ENVIRONMENT, TENANT_DEPLOY_SECRET]) {
    if (registry.includes(word)) errors.push(`registry workflow references ${word}`);
  }
  if (!tenant.includes(`environment: ${TENANT_DEPLOY_ENVIRONMENT}`)) {
    errors.push("tenant workflow environment");
  }
  if (!registry.includes(`environment: ${REGISTRY_ADMIN_ENVIRONMENT}`)) {
    errors.push("registry workflow environment");
  }
  if (!registry.includes("assert-distinct-reviewer.mjs")) {
    errors.push("registry workflow does not check the reviewer");
  }
  if (!tenant.includes("audit-alert.mjs") || !registry.includes("audit-alert.mjs")) {
    errors.push("deploy workflows must call the audit-alert hook");
  }
  return errors;
}

/** A tenant workflow can deploy the registry only when it runs wrangler deploy. P1 has no such step. */
export function tenantWorkflowCanDeployRegistry(workflowText) {
  if (!workflowText) return false;
  if (new RegExp(`wrangler\\s+deploy[\\s\\S]{0,400}${REGISTRY_SCRIPT}`).test(workflowText)) return true;
  if (/wrangler\s+deploy/.test(workflowText)) return true;
  return false;
}

export function assertUsageSchedule(workflowText) {
  const found = [...String(workflowText).matchAll(/cron:\s*"([^"]+)"/g)].map((match) => match[1]);
  for (const cron of USAGE_CRONS) {
    if (!found.includes(cron)) {
      throw new Error(`usage workflow missing cron ${cron}`);
    }
  }
}
