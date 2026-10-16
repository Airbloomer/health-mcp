function timingSafeEq(a, b) {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) diff |= (left[i] || 0) ^ (right[i] || 0);
  return diff === 0;
}

const TOKEN_PATH = /^\/ingest\/(?:hc-webhook|life-dashboard)\/([^/]+)$/;

function presentedToken(req) {
  const header = req.headers.get("authorization") || "";
  if (header) {
    const match = header.match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : "";
  }
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return null;
  }
  if (url.searchParams.has("token")) return url.searchParams.get("token") || "";
  const path = url.pathname.match(TOKEN_PATH);
  if (!path) return null;
  try {
    return decodeURIComponent(path[1]);
  } catch {
    return path[1];
  }
}

/**
 * True when the request carries the ingest token.
 * `Authorization: Bearer` is the default. When that header is absent, the same
 * token may be the `token` query parameter or the last segment of
 * `/ingest/hc-webhook/<token>` or `/ingest/life-dashboard/<token>`.
 * `env` may be the token string or an object with `HEALTH_INGEST_TOKEN`.
 * A missing or empty expected token never authenticates.
 */
export function authed(req, env) {
  const expected = typeof env === "string" ? env : env?.HEALTH_INGEST_TOKEN;
  if (typeof expected !== "string" || expected.length === 0) return false;
  const presented = presentedToken(req);
  if (presented == null) return false;
  return timingSafeEq(presented, expected);
}

/** Hide ingest tokens in query strings and adapter URL paths. */
export function redactRequestTarget(target, secret) {
  let text = String(target ?? "")
    .replace(/([?&#]token=)[^&#\s]*/gi, "$1[redacted]")
    .replace(/(\/ingest\/(?:hc-webhook|life-dashboard)\/)[^/?#\s]+/g, "$1[redacted]");
  if (typeof secret === "string" && secret.length > 0) text = text.split(secret).join("[redacted]");
  return text;
}
