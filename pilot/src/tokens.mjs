import { createHash, randomBytes } from "node:crypto";

export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,}$/;

/** CSPRNG, 32 bytes, URL-safe. Never user-chosen. Callers show the result once. */
export function generateToken() {
  return randomBytes(32).toString("base64url");
}

/** First 8 hex chars of SHA-256. The full hash is not stored. */
export function tokenHashPrefix(token) {
  return createHash("sha256").update(String(token), "utf8").digest("hex").slice(0, 8);
}

/**
 * Fail when two rows share a hash or an 8-hex prefix.
 * `hash` is optional and only present in fixtures; the registry stores the prefix.
 */
export function assertUniqueTokenMeta(rows) {
  const prefixes = new Map();
  const hashes = new Map();
  for (const row of rows) {
    const prefix = row.hash_prefix;
    if (!/^[0-9a-f]{8}$/.test(prefix || "")) {
      throw new Error("token hash prefix must be 8 hex chars");
    }
    if (prefixes.has(prefix)) {
      throw new Error("token hash prefix collision");
    }
    prefixes.set(prefix, row.tenant_id);
    if (row.hash) {
      if (hashes.has(row.hash)) throw new Error("shared token hash");
      hashes.set(row.hash, row.tenant_id);
    }
  }
}
