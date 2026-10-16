import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BILLING_TAG,
  HMAC_SECRET_PREFIX,
  HOST_SUFFIX,
  REGISTRY_DATABASE,
  REGISTRY_SCRIPT,
  SENSITIVE_MARKERS,
  SUMMARY_ALLOWLIST,
  TENANT_ID_PATTERN,
  resourceName,
} from "./constants.mjs";
import { parseToml } from "./toml.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE = /(?:\+\d{10,15}\b)|(?:\b\d{3}[-.\s)]\d{3}[-.\s]\d{4}\b)/;

function fail(errors) {
  if (errors.length) {
    const error = new Error(errors.join("; "));
    error.errors = errors;
    throw error;
  }
}

export function lintRenderedTenant(text, options = {}) {
  const errors = [];
  const doc = parseToml(text);
  const tenantId = options.tenantId || doc.sections.vars?.TENANT_ID;
  if (!TENANT_ID_PATTERN.test(tenantId || "")) errors.push("tenant id");

  const expectedName = resourceName(tenantId);
  if (doc.values.name !== expectedName) errors.push("worker name");
  if (doc.values.workers_dev !== false) errors.push("workers_dev");
  if (doc.values.preview_urls !== false) errors.push("preview_urls");

  const vars = doc.sections.vars || {};
  if (vars.BILLING_TAG !== BILLING_TAG) errors.push("BILLING_TAG");
  if (vars.TENANT_ID !== tenantId) errors.push("TENANT_ID");
  if (vars.HEALTH_STORE_RAW !== "false") errors.push("HEALTH_STORE_RAW");
  if (vars.HEALTH_METRIC_ALLOWLIST !== SUMMARY_ALLOWLIST) errors.push("allowlist");
  const allow = String(vars.HEALTH_METRIC_ALLOWLIST || "");
  for (const marker of SENSITIVE_MARKERS) {
    if (allow.includes(marker)) errors.push(`sensitive:${marker}`);
  }

  const obs = doc.sections.observability || {};
  const logs = doc.sections["observability.logs"] || {};
  if (obs.enabled !== false) errors.push("observability");
  if (logs.invocation_logs !== false && obs.invocation_logs !== false) errors.push("invocation_logs");
  if (logs.enabled === true) errors.push("invocation logs enabled");
  if (/logpush/i.test(text)) errors.push("logpush");
  if (/tail_consumers/i.test(text)) errors.push("tail consumer");
  if (text.includes("HEALTH_INGEST_URL_TOKEN")) errors.push("url token");
  if (obs.enabled === true && text.includes("HEALTH_INGEST_URL_TOKEN")) {
    errors.push("url token with observability");
  }
  if (text.includes(HMAC_SECRET_PREFIX)) errors.push("hmac key on tenant");

  const databases = doc.arrays.d1_databases || [];
  if (databases.length !== 1) errors.push("d1 binding count");
  const database = databases[0] || {};
  if (database.database_name !== expectedName) errors.push("d1 name");
  if (database.binding !== "DB") errors.push("d1 binding");
  if (database.database_name === REGISTRY_DATABASE) errors.push("registry binding");
  if (text.includes(REGISTRY_DATABASE)) errors.push("registry database");

  for (const name of Object.keys(doc.arrays)) {
    if (name !== "d1_databases" && name !== "routes" && doc.arrays[name].length) {
      errors.push(`unexpected binding ${name}`);
    }
  }

  const routes = doc.arrays.routes || [];
  if (routes.length !== 1) errors.push("route count");
  const route = routes[0] || {};
  if (route.pattern !== `${tenantId}${HOST_SUFFIX}`) errors.push("hostname");
  if (route.custom_domain !== true) errors.push("custom domain");

  if (text.includes("REGISTRY_ACCOUNT_ID")) errors.push("registry account placeholder");
  if (
    options.registryAccountId &&
    options.registryAccountId !== options.tenantAccountId &&
    text.includes(options.registryAccountId)
  ) {
    errors.push("registry account id");
  }

  const places = [doc.values.name, vars.TENANT_ID, database.database_name, route.pattern];
  if (new Set([expectedName, tenantId, expectedName, `${tenantId}${HOST_SUFFIX}`]).size !== 3) {
    errors.push("identity");
  }
  if (places[0] !== expectedName || places[1] !== tenantId || places[2] !== expectedName || places[3] !== `${tenantId}${HOST_SUFFIX}`) {
    errors.push("TENANT_ID mismatch");
  }

  return errors;
}

export function assertRenderedTenant(text, options) {
  fail(lintRenderedTenant(text, options));
}

export function lintTenantSource(filename, text) {
  const errors = [];
  const base = path.basename(filename);
  if (!base.endsWith(".toml")) errors.push("extension");
  const id = base.slice(0, -".toml".length);
  if (!TENANT_ID_PATTERN.test(id)) errors.push("id");
  if (EMAIL.test(text)) errors.push("email");
  if (PHONE.test(text)) errors.push("phone");
  if (!text.includes(NAME_PREFIX_IN_FILE(id))) errors.push("prefix");
  return errors;
}

function NAME_PREFIX_IN_FILE(id) {
  return resourceName(id);
}

export function assertTenantDeployTarget(scriptName) {
  if (scriptName === REGISTRY_SCRIPT || scriptName === REGISTRY_DATABASE) {
    throw new Error("tenant deploy cannot target the registry");
  }
  if (!String(scriptName || "").startsWith(`${BILLING_TAG}-`)) {
    throw new Error("resource name must use the billing prefix");
  }
}

const TENANT_SURFACE = [
  "templates/wrangler.tenant.toml.tmpl",
  "scripts/put-tenant-secret.mjs",
  "scripts/tenant-deploy.mjs",
  "scripts/provision.mjs",
];

export function tenantSurfacesReferencingHmac(dir = root) {
  const hits = [];
  for (const rel of TENANT_SURFACE) {
    const file = path.join(dir, rel);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    if (text.includes(HMAC_SECRET_PREFIX)) hits.push(rel);
  }
  return hits;
}

export function scanTextForHmac(text) {
  return text.includes(HMAC_SECRET_PREFIX);
}
