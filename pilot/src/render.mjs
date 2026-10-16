import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BILLING_TAG,
  HOST_SUFFIX,
  NAME_PREFIX,
  SUMMARY_ALLOWLIST,
  TENANT_ID_PATTERN,
} from "./constants.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function templatePath() {
  return path.join(root, "templates", "wrangler.tenant.toml.tmpl");
}

export function loadTenantTemplate() {
  return fs.readFileSync(templatePath(), "utf8");
}

/**
 * Render a tenant wrangler config. Account id and D1 id are injected by the
 * caller and are not committed. The returned text is for the caller to write
 * to a gitignored `*.rendered.toml`; this function does not print it.
 */
export function renderTenant({
  tenantId,
  compatDate = "2026-09-22",
  accountId,
  d1Id,
  template = loadTenantTemplate(),
}) {
  if (!TENANT_ID_PATTERN.test(tenantId || "")) {
    throw new Error("tenant id must match ^[a-z2-7]{26}$");
  }
  if (!accountId || !d1Id || !compatDate) {
    throw new Error("compat date, account id, and d1 id are required");
  }
  const values = {
    TENANT_ID: tenantId,
    COMPAT_DATE: compatDate,
    CLOUDFLARE_ACCOUNT_ID: accountId,
    D1_ID: d1Id,
  };
  const rendered = template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, key) => {
    if (!(key in values)) throw new Error(`unknown template key ${key}`);
    return values[key];
  });
  if (rendered.includes("{{") || rendered.includes("}}")) {
    throw new Error("unrendered template marker");
  }
  if (!rendered.includes(`${NAME_PREFIX}${tenantId}`)) {
    throw new Error("rendered name is missing the billing prefix");
  }
  if (!rendered.includes(`BILLING_TAG = "${BILLING_TAG}"`)) {
    throw new Error("rendered config is missing BILLING_TAG");
  }
  if (!rendered.includes(`HEALTH_METRIC_ALLOWLIST = "${SUMMARY_ALLOWLIST}"`)) {
    throw new Error("rendered config is missing the summary allowlist");
  }
  if (!rendered.includes(`${tenantId}${HOST_SUFFIX}`)) {
    throw new Error("rendered hostname is wrong");
  }
  return rendered;
}

/** GitHub log mask directives. Callers print these and do not print the config. */
export function maskLines(values) {
  return values.filter((value) => value != null && value !== "").map((value) => `::add-mask::${value}`);
}
