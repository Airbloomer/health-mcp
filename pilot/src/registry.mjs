import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const migrationPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "registry",
  "migrations",
  "0001_registry.sql",
);

export const COLUMN_ALLOWLIST = {
  tenants: [
    "tenant_id",
    "status",
    "created_at",
    "worker_name",
    "d1_name",
    "d1_id",
    "hostname",
    "health_mcp_ref",
    "billing_tag",
    "deletion_requested_at",
    "deleted_at",
  ],
  consents: [
    "consent_id",
    "tenant_id",
    "consented_at",
    "channel",
    "scope",
    "notice_version",
    "evidence_ref",
    "evidence_hmac",
    "evidence_key_version",
    "withdrawn_at",
  ],
  consent_evidence: [
    "evidence_ref",
    "tenant_id",
    "ciphertext",
    "encryption",
    "created_at",
    "retention_policy",
  ],
  token_meta: [
    "tenant_id",
    "kind",
    "hash_alg",
    "hash_prefix",
    "created_at",
    "rotated_at",
    "revoked_at",
  ],
  events: ["id", "tenant_id", "at", "actor", "action", "detail"],
};

export function migrationSql() {
  return fs.readFileSync(migrationPath, "utf8");
}

export function applyRegistry(db) {
  db.pragma("foreign_keys = ON");
  db.exec(migrationSql());
  return db;
}

export function tableColumns(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
  const columns = {};
  for (const table of tables) {
    columns[table.name] = db.prepare(`PRAGMA table_info(${table.name})`).all().map((row) => row.name);
  }
  return columns;
}
