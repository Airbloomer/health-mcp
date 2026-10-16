function timingSafeEq(a, b) {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) diff |= (left[i] || 0) ^ (right[i] || 0);
  return diff === 0;
}

const URL_TOKEN_PATH = /^\/ingest\/(?:hc-webhook|life-dashboard)\/([^/]+)$/;

function requestUrl(req) {
  try {
    return new URL(req.url);
  } catch {
    return null;
  }
}

/** POST /ingest/hc-webhook and POST /ingest/life-dashboard, including the path-token form. */
export function urlTokenRoute(req) {
  if ((req.method || "GET").toUpperCase() !== "POST") return false;
  const url = requestUrl(req);
  if (!url) return false;
  return url.pathname === "/ingest/hc-webhook"
    || url.pathname === "/ingest/life-dashboard"
    || URL_TOKEN_PATH.test(url.pathname);
}

function presentedUrlToken(req) {
  const url = requestUrl(req);
  if (!url) return null;
  if (url.searchParams.has("token")) return (url.searchParams.get("token") ?? "").trim();
  const path = url.pathname.match(URL_TOKEN_PATH);
  if (!path) return null;
  try {
    return decodeURIComponent(path[1]).trim();
  } catch {
    return path[1].trim();
  }
}

function configuredSecret(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * True when the request carries `Authorization: Bearer <HEALTH_INGEST_TOKEN>`.
 * On POST `/ingest/hc-webhook` and POST `/ingest/life-dashboard` only, a missing
 * Authorization header may instead carry `HEALTH_INGEST_URL_TOKEN` as the
 * `token` query parameter or the last path segment. That secret is write-only,
 * is not accepted on `/summary`, `/mcp`, or any other route, and does nothing
 * when unset. An Authorization header is never checked against the URL token.
 * `env` may be the bearer token string, or an object with `HEALTH_INGEST_TOKEN`
 * and `HEALTH_INGEST_URL_TOKEN`. A missing or empty secret never authenticates.
 */
export function authed(req, env) {
  const header = req.headers.get("authorization") || "";
  if (header) {
    const expected = configuredSecret(typeof env === "string" ? env : env?.HEALTH_INGEST_TOKEN);
    if (!expected) return false;
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) return false;
    return timingSafeEq(match[1].trim(), expected);
  }
  if (typeof env === "string" || !urlTokenRoute(req)) return false;
  const urlSecret = configuredSecret(env?.HEALTH_INGEST_URL_TOKEN);
  if (!urlSecret) return false;
  const presented = presentedUrlToken(req);
  if (presented == null) return false;
  return timingSafeEq(presented, urlSecret);
}

function decodePercents(value) {
  let text = String(value ?? "");
  for (let pass = 0; pass < 3; pass++) {
    const decoded = text.replace(/%[0-9A-Fa-f]{2}/g, (sequence) => {
      try {
        return decodeURIComponent(sequence);
      } catch {
        return sequence;
      }
    });
    if (decoded === text) break;
    text = decoded;
  }
  return text;
}

/**
 * Hide ingest tokens in query strings, adapter URL paths, and error text.
 * Percent-encoded keys such as `%74oken` are decoded before the match, so the
 * value is removed even when the key is not the literal word `token`.
 */
export function redactRequestTarget(target, secret, urlSecret) {
  let text = decodePercents(target)
    .replace(/([?&#]token=)[^&#\s]*/gi, "$1[redacted]")
    .replace(/(\/ingest\/(?:hc-webhook|life-dashboard)\/)[^/?#\s]+/g, "$1[redacted]");
  for (const value of [secret, urlSecret]) {
    if (typeof value !== "string" || value.length === 0) continue;
    text = text.split(value).join("[redacted]");
    const encoded = encodeURIComponent(value);
    if (encoded !== value) text = text.split(encoded).join("[redacted]");
  }
  return text;
}
