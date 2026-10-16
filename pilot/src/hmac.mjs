import { createHmac, timingSafeEqual } from "node:crypto";

/** HMAC-SHA256 hex over stored evidence bytes. The key is never logged. */
export function evidenceHmac(key, bytes) {
  const material = Buffer.isBuffer(key) ? key : Buffer.from(String(key ?? ""), "utf8");
  if (material.length < 32) {
    throw new Error("HMAC key must be at least 32 bytes");
  }
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes ?? ""), "utf8");
  return createHmac("sha256", material).update(data).digest("hex");
}

export function verifyEvidence(key, bytes, hex) {
  if (typeof hex !== "string" || !/^[0-9a-f]{64}$/.test(hex)) return false;
  const got = evidenceHmac(key, bytes);
  return timingSafeEqual(Buffer.from(got, "utf8"), Buffer.from(hex, "utf8"));
}

/**
 * Verify a row with the key version it was written under, then recompute
 * under `nextVersion`. Old versions stay available until this returns.
 */
export function rehashRow(row, keys, nextVersion) {
  const current = keys.get(row.version);
  if (!current || !verifyEvidence(current, row.evidence, row.hmac)) {
    throw new Error("evidence hmac does not verify under its key version");
  }
  const next = keys.get(nextVersion);
  if (!next) throw new Error("next key version is not available");
  return {
    ...row,
    version: nextVersion,
    hmac: evidenceHmac(next, row.evidence),
  };
}

export function verifyRow(row, keys) {
  const key = keys.get(row.version);
  if (!key) return false;
  return verifyEvidence(key, row.evidence, row.hmac);
}
