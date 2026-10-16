function timingSafeEq(a, b) {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) diff |= (left[i] || 0) ^ (right[i] || 0);
  return diff === 0;
}

/**
 * True when the request carries `Authorization: Bearer <token>`.
 * `env` may be the token string or an object with `HEALTH_INGEST_TOKEN`.
 * A missing or empty token never authenticates.
 */
export function authed(req, env) {
  const expected = typeof env === "string" ? env : env?.HEALTH_INGEST_TOKEN;
  if (typeof expected !== "string" || expected.length === 0) return false;
  const header = req.headers.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  return timingSafeEq(match[1].trim(), expected);
}
