import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { AUDIT_ALERT_STATUS, selfTestAlerts } from "../pilot/src/audit.mjs";
import { lintAccessDoc, readAccessDoc, assertTokenPolicy } from "../pilot/src/access.mjs";
import {
  BILLING_TAG,
  HMAC_SECRET_PREFIX,
  REGISTRY_SCRIPT,
  RESIDUAL_RISK_LINE,
  SUMMARY_ALLOWLIST,
} from "../pilot/src/constants.mjs";
import { assertEvent, assertMetadataDetail } from "../pilot/src/events.mjs";
import { evidenceHmac, rehashRow, verifyEvidence, verifyRow } from "../pilot/src/hmac.mjs";
import { assertEnvironmentKeys } from "../pilot/src/keys.mjs";
import {
  assertRenderedTenant,
  assertTenantDeployTarget,
  lintRenderedTenant,
  lintTenantSource,
  scanTextForHmac,
  tenantSurfacesReferencingHmac,
} from "../pilot/src/lint.mjs";
import { applyRegistry, migrationSql, tableColumns, COLUMN_ALLOWLIST } from "../pilot/src/registry.mjs";
import { maskLines, renderTenant } from "../pilot/src/render.mjs";
import { approvedReviewers, assertDistinctReviewer } from "../pilot/src/reviewer.mjs";
import { assertUniqueTokenMeta, generateToken, tokenHashPrefix, TOKEN_PATTERN } from "../pilot/src/tokens.mjs";
import {
  USAGE_CSV_COLUMNS,
  USAGE_INTROSPECTION_TODO,
  USAGE_QUERY,
  assertCsvColumns,
  buildUsagePlan,
  DAY_OWNERSHIP,
  mergeOwnedDays,
  owningPull,
  toCsv,
  usageRows,
} from "../pilot/src/usage.mjs";
import {
  assertUsageSchedule,
  lintEnvironmentSplit,
  lintWorkflowText,
  readWorkflows,
  tenantWorkflowCanDeployRegistry,
} from "../pilot/src/workflows.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ID = "k3vm2xq7n4pr5tw6y2abc3defg";
const ID_B = "m7qk3v2n5p6r4tw2yabc3defgh";
const ACCOUNT = "acct-tenant-example";
const D1 = "d1-tenant-example";
const REGISTRY_ACCOUNT = "acct-registry-example";

function childEnv(extra = {}) {
  return { PATH: process.env.PATH || "", ...extra };
}

function fresh() {
  const db = new Database(":memory:");
  applyRegistry(db);
  return db;
}

function insertTenant(db, id, status = "pending_consent") {
  db.prepare(`INSERT INTO tenants (
    tenant_id, status, created_at, worker_name, d1_name, hostname, billing_tag
  ) VALUES (?, ?, '2026-01-01T00:00:00Z', ?, ?, ?, 'hmcp-pilot')`).run(
    id,
    status,
    `hmcp-pilot-${id}`,
    `hmcp-pilot-${id}`,
    `${id}.health.airbloomer.com`,
  );
}

function renderSample(overrides = {}) {
  return renderTenant({
    tenantId: ID,
    accountId: ACCOUNT,
    d1Id: D1,
    ...overrides,
  });
}

test("test 1: pinned ref is 40 hex and an ancestor of main when that commit is present", () => {
  const ref = fs.readFileSync(path.join(root, "pilot/HEALTH_MCP_REF"), "utf8").trim();
  assert.match(ref, /^[0-9a-f]{40}$/);
  const ci = fs.readFileSync(path.join(root, ".github/workflows/pilot-ci.yml"), "utf8");
  assert.match(ci, /git merge-base --is-ancestor "\$ref" origin\/main/);
  const hasCommit = spawnSync("git", ["cat-file", "-e", `${ref}^{commit}`], { cwd: root });
  const hasMain = spawnSync("git", ["rev-parse", "--verify", "origin/main"], { cwd: root });
  if (hasCommit.status !== 0 || hasMain.status !== 0) return;
  const ancestor = spawnSync("git", ["merge-base", "--is-ancestor", ref, "origin/main"], { cwd: root });
  assert.equal(ancestor.status, 0);
});

test("test 2: rendered template matches naming, billing tag, and raw storage", () => {
  const text = renderSample();
  assertRenderedTenant(text, { tenantId: ID, tenantAccountId: ACCOUNT, registryAccountId: REGISTRY_ACCOUNT });
  assert.match(text, new RegExp(`name = "hmcp-pilot-${ID}"`));
  assert.match(text, new RegExp(`database_name = "hmcp-pilot-${ID}"`));
  assert.match(text, new RegExp(`pattern = "${ID}\\.health\\.airbloomer\\.com"`));
  assert.match(text, /BILLING_TAG = "hmcp-pilot"/);
  assert.match(text, /workers_dev = false/);
  assert.match(text, /HEALTH_STORE_RAW = "false"/);
  assert.equal(BILLING_TAG, "hmcp-pilot");
  assert.ok(text.includes(`${BILLING_TAG}-${ID}`));
  assert.equal(SUMMARY_ALLOWLIST.split(",").length, 9);
});

test("test 3: naming linter rejects prefix, id shape, phone, and email", () => {
  const good = `name = "hmcp-pilot-${ID}"\n`;
  assert.deepEqual(lintTenantSource(`${ID}.toml`, good), []);
  assert.ok(lintTenantSource("Bad.toml", good).length > 0);
  assert.ok(lintTenantSource("phone123.toml", `name = "hmcp-pilot-phone123"\n`).length > 0);
  assert.ok(lintTenantSource(`${ID}.toml`, `${good}contact = "person@example.com"\n`).includes("email"));
  assert.ok(lintTenantSource(`${ID}.toml`, `${good}contact = "+14155551212"\n`).includes("phone"));
});

test("test 4 and 15: registry checks reject status, billing tag, and deleted_at", () => {
  const db = fresh();
  insertTenant(db, ID);
  assert.throws(() => db.prepare("UPDATE tenants SET status = 'nope' WHERE tenant_id = ?").run(ID));
  assert.throws(() => db.prepare("UPDATE tenants SET billing_tag = 'other' WHERE tenant_id = ?").run(ID));
  assert.throws(() => db.prepare("UPDATE tenants SET deleted_at = '2026-02-01T00:00:00Z' WHERE tenant_id = ?").run(ID));
  db.prepare("UPDATE tenants SET deletion_requested_at = '2026-01-02T00:00:00Z', deleted_at = '2026-01-03T00:00:00Z' WHERE tenant_id = ?").run(ID);
  const row = db.prepare("SELECT deleted_at FROM tenants WHERE tenant_id = ?").get(ID);
  assert.equal(row.deleted_at, "2026-01-03T00:00:00Z");
});

test("test 5: registry columns are the allowlist", () => {
  const db = fresh();
  const columns = tableColumns(db);
  assert.deepEqual(Object.keys(columns).sort(), Object.keys(COLUMN_ALLOWLIST).sort());
  for (const [table, allowed] of Object.entries(COLUMN_ALLOWLIST)) {
    assert.deepEqual(columns[table], allowed);
  }
  const sql = migrationSql();
  const names = Object.values(columns).flat().join(",");
  assert.doesNotMatch(names, /phone|email|token|payload|secret/i);
  assert.doesNotMatch(sql, /evidence_sha256/);
});

test("test 6 and 16: gitignore and gitleaks cover rendered files and secrets", () => {
  const ignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
  for (const line of ["tenants/*.rendered.toml", "*.secret", ".dev.vars", ".wrangler/"]) {
    assert.ok(ignore.includes(line), line);
  }
  const ci = fs.readFileSync(path.join(root, ".github/workflows/pilot-ci.yml"), "utf8");
  assert.match(ci, /gitleaks/);
  assert.match(fs.readFileSync(path.join(root, "pilot/README.md"), "utf8"), /push protection/i);
});

test("test 7: app source has no tenant id", () => {
  const files = [];
  for (const name of fs.readdirSync(path.join(root, "src"), { recursive: true })) {
    const file = path.join(root, "src", name);
    if (fs.statSync(file).isFile()) files.push(file);
  }
  for (const file of files) {
    assert.doesNotMatch(fs.readFileSync(file, "utf8"), /\b[a-z2-7]{26}\b/);
  }
});

test("test 8: schema has evidence_hmac and evidence_key_version, not evidence_sha256", () => {
  const columns = tableColumns(fresh());
  assert.ok(columns.consents.includes("evidence_hmac"));
  assert.ok(columns.consents.includes("evidence_key_version"));
  assert.equal(columns.consents.includes("evidence_sha256"), false);
  assert.equal(columns.consents.includes("evidence_key_id"), false);
});

test("test 9: synthetic HMAC vector and the test does not read a real key", () => {
  const key = "synthetic-test-key-32-bytes-long!";
  const evidence = "synthetic-evidence-v1";
  const expected = "ca7fabea1cbee1a42d30179013c2f7be0ab1b7e8d39668044cef874415eb32cb";
  assert.equal(evidenceHmac(key, evidence), expected);
  assert.equal(createHmac("sha256", key).update(evidence).digest("hex"), expected);
  assert.equal(verifyEvidence(key, evidence, expected), true);
  assert.equal(process.env.CONSENT_EVIDENCE_HMAC_KEY, undefined);
  const source = fs.readFileSync(path.join(root, "pilot/src/hmac.mjs"), "utf8");
  assert.equal(source.includes("process.env"), false);
});

test("test 10: two D1 bindings, the registry, or another tenant database fail", () => {
  const text = renderSample();
  const extra = text.replace(
    "[[d1_databases]]",
    `[[d1_databases]]\nbinding = "OTHER"\ndatabase_name = "hmcp-pilot-${ID_B}"\ndatabase_id = "other"\n\n[[d1_databases]]`,
  );
  assert.ok(lintRenderedTenant(extra, { tenantId: ID }).includes("d1 binding count"));
  const registry = text.replaceAll(`hmcp-pilot-${ID}`, REGISTRY_SCRIPT);
  assert.ok(lintRenderedTenant(registry, { tenantId: ID }).length > 0);
  const other = text.replace(`database_name = "hmcp-pilot-${ID}"`, `database_name = "hmcp-pilot-${ID_B}"`);
  assert.ok(lintRenderedTenant(other, { tenantId: ID }).includes("d1 name"));
});

test("test 11: TENANT_ID mismatch fails", () => {
  const text = renderSample().replace(`TENANT_ID = "${ID}"`, `TENANT_ID = "${ID_B}"`);
  const errors = lintRenderedTenant(text, { tenantId: ID });
  assert.ok(errors.includes("TENANT_ID"));
});

test("test 12: shared token hash prefix fails", () => {
  assert.throws(() => assertUniqueTokenMeta([
    { tenant_id: ID, hash_prefix: "abcdef12" },
    { tenant_id: ID_B, hash_prefix: "abcdef12" },
  ]));
  assert.throws(() => assertUniqueTokenMeta([
    { tenant_id: ID, hash_prefix: "abcdef12", hash: "abc" },
    { tenant_id: ID_B, hash_prefix: "1234abcd", hash: "abc" },
  ]));
  assert.doesNotThrow(() => assertUniqueTokenMeta([
    { tenant_id: ID, hash_prefix: "abcdef12" },
    { tenant_id: ID_B, hash_prefix: "1234abcd" },
  ]));
  const db = fresh();
  insertTenant(db, ID);
  insertTenant(db, ID_B);
  db.prepare("INSERT INTO token_meta (tenant_id, kind, hash_prefix, created_at) VALUES (?, 'ingest', 'abcdef12', '2026-01-01T00:00:00Z')").run(ID);
  assert.throws(() => db.prepare("INSERT INTO token_meta (tenant_id, kind, hash_prefix, created_at) VALUES (?, 'ingest', 'abcdef12', '2026-01-02T00:00:00Z')").run(ID_B));
});

test("test 13: template has no URL token, and URL token plus observability fails", () => {
  const text = renderSample();
  assert.equal(text.includes("HEALTH_INGEST_URL_TOKEN"), false);
  const bad = text
    .replace("enabled = false", "enabled = true")
    .replace('HEALTH_STORE_RAW = "false"', 'HEALTH_STORE_RAW = "false"\nHEALTH_INGEST_URL_TOKEN = "not-a-real-token"');
  const errors = lintRenderedTenant(bad, { tenantId: ID });
  assert.ok(errors.includes("url token"));
  assert.ok(errors.includes("observability"));
});

test("test 14: cf-access.md uses role labels and rejects names and emails", () => {
  const text = readAccessDoc();
  assert.deepEqual(lintAccessDoc(text), []);
  assert.ok(lintAccessDoc(`${text}\ncontact = "person@example.com"`).includes("email"));
  assert.ok(lintAccessDoc(`${text}\nApproved By Example Person`).some((item) => item.includes("personal name")));
});

test("test 17: tenant surfaces do not reference the HMAC key", () => {
  assert.deepEqual(tenantSurfacesReferencingHmac(), []);
  assert.equal(scanTextForHmac(`secret put ${HMAC_SECRET_PREFIX}_pilot-1`), true);
  const registry = fs.readFileSync(path.join(root, "pilot/templates/wrangler.registry.toml"), "utf8");
  assert.equal(scanTextForHmac(registry), true);
});

test("test 18: k1 still verifies after k2 is current, and removal after re-hash is safe", () => {
  const keys = new Map([
    ["k1", Buffer.from("11".repeat(32), "hex")],
    ["k2", Buffer.from("22".repeat(32), "hex")],
  ]);
  const evidence = "synthetic-evidence-row";
  const row = {
    version: "k1",
    evidence,
    hmac: "f36238888e82a3cf38d6d0d3572e41bf0364c5d8e2a7d778fc21cf9165ceaff5",
  };
  assert.equal(evidenceHmac(keys.get("k1"), evidence), row.hmac);
  assert.equal(verifyRow(row, keys), true);
  const next = rehashRow(row, keys, "k2");
  assert.equal(next.version, "k2");
  assert.equal(next.hmac, "b604390cc3fe77ddfc48d78e3f6f6e8586cf1c8545292043bec159b19d1121c5");
  assert.equal(verifyRow(next, keys), true);
  keys.delete("k1");
  assert.equal(verifyRow(next, keys), true);
  assert.equal(verifyRow(row, keys), false);
});

test("test 19: environment key namespaces differ and ci-test is not the pilot id", () => {
  assert.doesNotThrow(() => assertEnvironmentKeys());
  assert.throws(() => assertEnvironmentKeys([
    { name: "dev", namespace: "dev", version: "dev-1" },
    { name: "ci-test", namespace: "pilot", version: "pilot-1" },
    { name: "pilot", namespace: "pilot", version: "pilot-1" },
  ]));
});

test("test 20: tenant and registry workflows do not share environments", () => {
  const files = readWorkflows();
  assert.deepEqual(lintEnvironmentSplit(files), []);
  assert.ok(lintEnvironmentSplit({
    ...files,
    "pilot-tenant-deploy.yml": `${files["pilot-tenant-deploy.yml"]}\nenvironment: registry-admin\n`,
  }).some((item) => item.includes("registry-admin")));
  assert.ok(lintEnvironmentSplit({
    ...files,
    "pilot-registry.yml": `${files["pilot-registry.yml"]}\nenvironment: pilot-tenant-deploy\n`,
  }).some((item) => item.includes("pilot-tenant-deploy")));
});

test("test 21: tenant workflow cannot deploy the registry, and tenant config omits the registry account", () => {
  const files = readWorkflows();
  assert.equal(tenantWorkflowCanDeployRegistry(files["pilot-tenant-deploy.yml"]), false);
  assert.equal(tenantWorkflowCanDeployRegistry("run: npx wrangler deploy --name hmcp-pilot-registry"), true);
  assert.throws(() => assertTenantDeployTarget(REGISTRY_SCRIPT));
  const text = renderSample();
  assert.equal(text.includes(REGISTRY_ACCOUNT), false);
  assert.equal(text.includes("REGISTRY_ACCOUNT_ID"), false);
  const named = text.replace(ACCOUNT, REGISTRY_ACCOUNT);
  assert.ok(lintRenderedTenant(named, {
    tenantId: ID,
    tenantAccountId: ACCOUNT,
    registryAccountId: REGISTRY_ACCOUNT,
  }).includes("registry account id"));
});

test("test 22: observability, invocation logs, logpush, and tail fail", () => {
  const text = renderSample();
  assert.ok(lintRenderedTenant(text.replace("[observability]\nenabled = false", "[observability]\nenabled = true"), { tenantId: ID }).includes("observability"));
  const logsOn = text.replace("invocation_logs = false", "invocation_logs = true");
  assert.ok(lintRenderedTenant(logsOn, { tenantId: ID }).includes("invocation_logs"));
  assert.ok(lintRenderedTenant(`${text}\n[logpush]\nenabled = true\n`, { tenantId: ID }).includes("logpush"));
  assert.ok(lintRenderedTenant(`${text}\n[[tail_consumers]]\nservice = "tail"\n`, { tenantId: ID }).includes("tail consumer"));
});

test("test 23: export actions are metadata-only", () => {
  for (const action of ["export_requested", "export_delivered", "export_operator_copy_deleted"]) {
    assert.doesNotThrow(() => assertEvent({
      actor: "owner-operator",
      action,
      detail: { status: "ok", count: 1 },
    }));
  }
  assert.throws(() => assertMetadataDetail({ phone: "15555550123" }));
  assert.throws(() => assertMetadataDetail({ status: "person@example.com" }));
  const sql = migrationSql();
  for (const action of ["export_requested", "export_delivered", "export_operator_copy_deleted"]) {
    assert.ok(sql.includes(`'${action}'`));
  }
});

test("activation requires a consent row", () => {
  const db = fresh();
  assert.throws(() => insertTenant(db, ID, "approved"));
  insertTenant(db, ID);
  assert.throws(() => db.prepare("UPDATE tenants SET status = 'active' WHERE tenant_id = ?").run(ID));
  db.prepare(`INSERT INTO consents (
    consent_id, tenant_id, consented_at, channel, scope, notice_version, evidence_ref, evidence_hmac, evidence_key_version
  ) VALUES ('c1', ?, '2026-01-01T00:00:00Z', 'sms', 'summary', 'n1', 'ev1', ?, 'pilot-1')`).run(ID, "ab".repeat(32));
  db.prepare("UPDATE tenants SET status = 'active' WHERE tenant_id = ?").run(ID);
  const status = db.prepare("SELECT status FROM tenants WHERE tenant_id = ?").get(ID);
  assert.equal(status.status, "active");
});

test("tokens are random, url-safe, and at least 32 characters", () => {
  const first = generateToken();
  const second = generateToken();
  assert.match(first, TOKEN_PATTERN);
  assert.notEqual(first, second);
  assert.match(tokenHashPrefix(first), /^[0-9a-f]{8}$/);
});

test("audit hook alerts the owner on deploy and secret change", () => {
  assert.equal(AUDIT_ALERT_STATUS, "PENDING");
  const alerts = selfTestAlerts();
  assert.ok(alerts.every((alert) => alert.to === "owner"));
  assert.ok(alerts.some((alert) => alert.kind === "worker_deploy"));
  assert.ok(alerts.some((alert) => alert.kind === "secret_change"));
  const script = spawnSync(process.execPath, ["pilot/scripts/audit-alert.mjs", "--self-test"], { cwd: root, encoding: "utf8", env: childEnv() });
  assert.equal(script.status, 0);
  assert.match(script.stdout, /worker_deploy/);
  assert.match(script.stdout, /secret_change/);
  const access = readAccessDoc();
  assert.match(access, /Audit alerts[\s\S]*PENDING/);
  assert.match(access, /required before deploy/);
  assert.match(access, /does not read the Cloudflare account audit log/);
});

test("registry-admin reviewer cannot be the triggering actor", () => {
  const policy = JSON.parse(fs.readFileSync(path.join(root, "pilot/environments/registry-admin.policy.json"), "utf8"));
  assert.equal(policy.prevent_self_review, true);
  assert.equal(policy.required_reviewers, true);
  assert.doesNotThrow(() => assertDistinctReviewer({ actor: "trigger", approvers: ["reviewer"], policy }));
  assert.throws(() => assertDistinctReviewer({ actor: "trigger", approvers: ["trigger"], policy }));
  assert.throws(() => assertDistinctReviewer({ actor: "trigger", approvers: [], policy }));
  assert.deepEqual(approvedReviewers([
    { state: "approved", user: { login: "reviewer" } },
    { state: "rejected", user: { login: "other" } },
  ]), ["reviewer"]);
  const source = fs.readFileSync(path.join(root, "pilot/scripts/assert-distinct-reviewer.mjs"), "utf8");
  assert.equal(source.includes("APPROVERS"), false);
  const script = spawnSync(process.execPath, ["pilot/scripts/assert-distinct-reviewer.mjs"], {
    cwd: root,
    encoding: "utf8",
    env: childEnv({ ACTOR: "trigger", APPROVERS: "reviewer", GITHUB_ACTIONS: "true" }),
  });
  assert.equal(script.status, 1);
  assert.match(script.stderr, /required reviewer/);
});

test("token policies are expiring, IP-filtered environment secrets", () => {
  for (const name of ["registry-admin.policy.json", "pilot-tenant-deploy.policy.json", "pilot-analytics.policy.json"]) {
    const policy = JSON.parse(fs.readFileSync(path.join(root, "pilot/environments", name), "utf8"));
    assertTokenPolicy(policy);
  }
  const access = readAccessDoc();
  assert.ok(access.includes(RESIDUAL_RISK_LINE));
  assert.match(access, /2FA is required for every member/);
  assert.match(access, /No Global API Key exists or is in use/);
  assert.match(access, /2027-01-31/);
  assert.match(access, /before tenant 3/);
  assert.match(access, /AIR-27/);
  assert.match(access, /must be verified before deploy/);
  assert.match(access, /has not been verified/);
  assert.match(access, /does not create GitHub environments/);
});

test("usage query uses cpuTimeUs and lowercase string, and leaves filters as TODOs", () => {
  assert.match(USAGE_QUERY, /\$acct:\s*string!/);
  assert.match(USAGE_QUERY, /\$dbId:\s*string!/);
  assert.match(USAGE_QUERY, /cpuTimeUs/);
  assert.doesNotMatch(USAGE_QUERY, /cpuTimeP50/);
  assert.doesNotMatch(USAGE_QUERY, /databaseId_in/);
  assert.doesNotMatch(USAGE_QUERY, /databaseSizeBytes/);
  assert.doesNotMatch(USAGE_QUERY, /\bmax\b/);
  assert.ok(USAGE_INTROSPECTION_TODO.some((line) => line.includes("databaseId_in") && line.includes("TODO")));
  assert.ok(USAGE_INTROSPECTION_TODO.some((line) => line.includes("max") && line.includes("TODO")));
  const plan = buildUsagePlan({ year: 2026, month: 9, databaseIds: ["db-a", "db-b"] });
  assert.equal(plan.cadence.dayOfMonth, 1);
  assert.deepEqual(plan.cadence.crons, ["30 0 1 * *", "30 0 16 * *"]);
  assert.equal(plan.cadence.ownership, DAY_OWNERSHIP);
  assert.equal(plan.workers.length, 30);
  assert.equal(plan.d1.length, 2);
  assert.equal(plan.storage_bytes, null);
  const csv = toCsv(usageRows({
    month: "2026-09",
    workers: [{ scriptName: `hmcp-pilot-${ID}`, requests: 3, cpuTimeUs: 9 }],
    d1: [{ databaseId: "db-a", rowsRead: 4, rowsWritten: 5 }],
  }));
  assertCsvColumns(csv);
  assert.match(csv, new RegExp(`^${USAGE_CSV_COLUMNS.join(",")}`));
  assert.throws(() => assertCsvColumns("month,resource,extra\n"));
  assertUsageSchedule(readWorkflows()["pilot-usage.yml"]);
});

test("workflow supply chain: pinned actions, read permissions, dependabot, wrangler lock", () => {
  const files = readWorkflows();
  const errors = Object.entries(files).flatMap(([name, text]) => lintWorkflowText(name, text));
  assert.deepEqual(errors, []);
  assert.ok(lintWorkflowText("bad.yml", "on:\n  pull_request_target:\npermissions:\n  contents: read\n").length > 0);
  assert.ok(lintWorkflowText("bad.yml", "on:\n  pull_request:\npermissions:\n  contents: write\njobs: {}\n").some((item) => item.includes("contents")));
  const dependabot = fs.readFileSync(path.join(root, ".github/dependabot.yml"), "utf8");
  assert.match(dependabot, /package-ecosystem:\s*npm/);
  assert.match(dependabot, /package-ecosystem:\s*github-actions/);
  assert.match(dependabot, /directory:\s*"\/pilot"/);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "pilot/package.json"), "utf8"));
  assert.equal(pkg.devDependencies.wrangler, "4.151.1");
  const lock = fs.readFileSync(path.join(root, "pilot/package-lock.json"), "utf8");
  assert.match(lock, /"wrangler"/);
  assert.match(lock, /4\.151\.1/);
});

test("HC Webhook pin is the v1.9.22 release checksum", () => {
  const pin = JSON.parse(fs.readFileSync(path.join(root, "pilot/hc-webhook.json"), "utf8"));
  assert.equal(pin.tag, "v1.9.22");
  assert.equal(pin.asset, "app-foss-release.apk");
  assert.equal(pin.sha256, "53da856ac76dc12c29775ab13b2d683412e65c5da3b1d2b7b48ddf1ee47a9f9b");
  assert.equal(pin.source, "github_release");
});

test("P3 and P4 stubs exit 1 and tenant deploy does not deploy", () => {
  for (const script of ["provision.mjs", "deprovision.mjs", "export-tenant.mjs"]) {
    const result = spawnSync(process.execPath, [`pilot/scripts/${script}`], { cwd: root, encoding: "utf8", env: childEnv() });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not implemented/);
  }
  const denied = spawnSync(process.execPath, ["pilot/scripts/put-tenant-secret.mjs", "OTHER"], { cwd: root, encoding: "utf8", env: childEnv() });
  assert.equal(denied.status, 1);
  const later = spawnSync(process.execPath, ["pilot/scripts/put-tenant-secret.mjs", "INGEST_TOKEN_HASH"], { cwd: root, encoding: "utf8", env: childEnv() });
  assert.equal(later.status, 1);
  assert.match(later.stderr, /not implemented/);
  for (const actions of ["true", "false"]) {
    const deploy = spawnSync(process.execPath, ["pilot/scripts/tenant-deploy.mjs"], {
      cwd: root,
      encoding: "utf8",
      env: childEnv({
        GITHUB_ACTIONS: actions,
        TENANT_ID: ID,
        PILOT_TENANT_DEPLOY_TOKEN: "test-token-value",
        TZ: "Pacific/Kiritimati",
      }),
    });
    assert.equal(deploy.status, 0, deploy.stderr);
    assert.match(deploy.stdout, /deploy is not run/);
    assert.equal(deploy.stdout.includes("test-token-value"), false);
    assert.equal(deploy.stdout.includes("::add-mask::"), false);
  }
  const forced = spawnSync(process.execPath, ["pilot/scripts/tenant-deploy.mjs", "--deploy"], {
    cwd: root,
    encoding: "utf8",
    env: childEnv({ TENANT_ID: ID, GITHUB_ACTIONS: "true" }),
  });
  assert.equal(forced.status, 1);
  for (const file of ["pilot/scripts/tenant-deploy.mjs", "pilot/scripts/registry-admin.mjs"]) {
    assert.equal(fs.readFileSync(path.join(root, file), "utf8").includes("::add-mask::"), false);
  }
});

test("render masks ids and does not print the config", () => {
  assert.deepEqual(maskLines([ACCOUNT, ""]), [`::add-mask::${ACCOUNT}`]);
  const out = path.join(root, "pilot/tenants", `${ID}.rendered.toml`);
  const result = spawnSync(process.execPath, ["pilot/scripts/render-tenant.mjs", ID, out], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_ACTIONS: "true",
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
      D1_ID: D1,
    },
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, new RegExp(`::add-mask::${ACCOUNT}`));
  assert.match(result.stdout, new RegExp(`::add-mask::${D1}`));
  assert.equal(result.stdout.includes(`name = "hmcp-pilot-${ID}"`), false);
  const written = fs.readFileSync(out, "utf8");
  assert.match(written, new RegExp(`name = "hmcp-pilot-${ID}"`));
  fs.unlinkSync(out);
});

test("consolidated spec is the current text", () => {
  const spec = fs.readFileSync(path.join(root, "specs/p1.md"), "utf8");
  assert.match(spec, /evidence_hmac/);
  assert.match(spec, /evidence_key_version/);
  assert.match(spec, /cpuTimeUs/);
  assert.match(spec, /2027-01-31/);
  assert.match(spec, /merge-base --is-ancestor/);
  assert.match(spec, /age ciphertext/);
  assert.match(spec, /age private key lives with the owner role/);
  assert.match(spec, /AIR-27/);
  assert.match(spec, /PENDING\. Required before deploy/);
  assert.match(spec, /free tier; upgrade when a real limit is hit/);
  assert.match(spec, /Days 1-15 come from the day-16 pull/);
  assert.match(spec, /required before P3/);
  assert.ok(spec.includes(RESIDUAL_RISK_LINE));
  assert.doesNotMatch(spec, /Workers Paid/);
});

test("day ownership ignores the other pull", () => {
  assert.equal(owningPull(1), "day-16");
  assert.equal(owningPull(15), "day-16");
  assert.equal(owningPull(16), "day-1");
  assert.equal(owningPull(31), "day-1");
  const day16 = [];
  const day1 = [];
  for (let day = 1; day <= 31; day += 1) {
    day16.push({ day, pull: "day-16", value: `early-${day}` });
    day1.push({ day, pull: "day-1", value: `late-${day}` });
  }
  const merged = mergeOwnedDays([...day1, ...day16]);
  assert.equal(merged.length, 31);
  assert.deepEqual(merged.filter((row) => row.day <= 15).map((row) => row.value), Array.from({ length: 15 }, (_, i) => `early-${i + 1}`));
  assert.deepEqual(merged.filter((row) => row.day >= 16).map((row) => row.value), Array.from({ length: 16 }, (_, i) => `late-${i + 16}`));
  const droppedOwner = mergeOwnedDays([
    { day: 3, pull: "day-1", value: "retention-still-has-the-other-pull" },
    { day: 20, pull: "day-16", value: "retention-still-has-the-other-pull" },
    { day: 20, pull: "day-1", value: "owned" },
  ]);
  assert.deepEqual(droppedOwner, [{ day: 20, pull: "day-1", value: "owned" }]);
});

test("CODEOWNERS is required before P3", () => {
  const text = fs.readFileSync(path.join(root, ".github/CODEOWNERS"), "utf8");
  assert.match(text, /Required before P3/);
  for (const owned of [
    "/pilot/HEALTH_MCP_REF",
    "/.github/workflows/",
    "/pilot/templates/",
    "/pilot/registry/migrations/",
  ]) {
    assert.ok(text.includes(owned), owned);
  }
  assert.match(text, /@Airbloomer\/reviewer/);
  assert.match(text, /@Airbloomer\/security-reviewer/);
  assert.match(text, /unverified/);
  assert.match(text, /Branch protection is off/);
  assert.equal(text.match(/\b[A-Z][a-z]{2,} [A-Z][a-z]{2,}\b/), null);
});

test("no tenant or account ids are committed outside the synthetic fixtures", () => {
  const fixtures = new Set([ID, ID_B]);
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(full);
    }
  }
  walk(root);
  const accountIds = [];
  const tenantIds = [];
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (text.includes("\0")) continue;
    const rel = path.relative(root, file);
    for (const match of text.matchAll(/\b[0-9a-f]{32}\b/g)) accountIds.push(`${rel}:${match[0]}`);
    for (const match of text.matchAll(/\b[a-z2-7]{26}\b/g)) {
      if (rel === "test/pilot.test.mjs" && fixtures.has(match[0])) continue;
      tenantIds.push(`${rel}:${match[0]}`);
    }
  }
  assert.deepEqual(accountIds, []);
  assert.deepEqual(tenantIds, []);
});

test("actor must be a role label or a workflow name", () => {
  assert.throws(() => assertEvent({ actor: "Example Person", action: "tenant_created", detail: "" }));
  assert.doesNotThrow(() => assertEvent({ actor: "pilot-registry", action: "worker_deploy", detail: { result: "ok" } }));
});
