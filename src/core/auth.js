function timingSafeEq(a, b) {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) diff |= (left[i] || 0) ^ (right[i] || 0);
  return diff === 0;
}

const URL_TOKEN_PATH = /^\/ingest\/(?:hc-webhook|shortcuts)\/([^/]*)$/;
/** Raw URL tokens: at least 32 characters, no decoding and no trimming. */
export const URL_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,}$/;

const warnings = { pattern: false, equal: false };

/** Test hook. Production calls log each misconfiguration once. */
export function resetUrlTokenWarnings() {
  warnings.pattern = false;
  warnings.equal = false;
}

function requestUrl(req) {
  try {
    return new URL(req.url);
  } catch {
    return null;
  }
}

/** Path and query as they appear in the request URL, without percent-decoding. */
function rawPathAndSearch(urlText) {
  let rest = String(urlText ?? "");
  const scheme = rest.match(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i);
  if (scheme) rest = rest.slice(scheme[0].length);
  const hash = rest.indexOf("#");
  if (hash !== -1) rest = rest.slice(0, hash);
  const query = rest.indexOf("?");
  if (query === -1) return { path: rest, search: "" };
  return { path: rest.slice(0, query), search: rest.slice(query) };
}

/**
 * The literal `token=` value, or `undefined` when that exact key is absent.
 * An encoded key such as `%74oken` is not this key. The value is not decoded.
 */
function literalQueryToken(search) {
  if (!search) return undefined;
  const body = search.startsWith("?") ? search.slice(1) : search;
  for (const part of body.split("&")) {
    if (part.startsWith("token=")) return part.slice("token=".length);
  }
  return undefined;
}

/** POST /ingest/hc-webhook and /ingest/shortcuts, including the path-token form. */
export function urlTokenRoute(req) {
  if ((req.method || "GET").toUpperCase() !== "POST") return false;
  const url = requestUrl(req);
  if (!url) return false;
  return url.pathname === "/ingest/hc-webhook"
    || url.pathname === "/ingest/shortcuts"
    || URL_TOKEN_PATH.test(url.pathname);
}

function presentedUrlToken(req) {
  const { path, search } = rawPathAndSearch(req.url);
  const query = literalQueryToken(search);
  if (query !== undefined) return query;
  const segment = path.match(URL_TOKEN_PATH);
  if (!segment) return null;
  return segment[1];
}

function configuredSecret(value) {
  return typeof value === "string" ? value.trim() : "";
}

function warnUrlToken(kind, message) {
  if (warnings[kind]) return;
  warnings[kind] = true;
  console.error(message);
}

/**
 * The URL token used for comparison, or "" when URL auth is off.
 * The configured value must match `URL_TOKEN_PATTERN` with no trimming.
 * When it equals `HEALTH_INGEST_TOKEN` after trimming, it is treated as unset.
 */
export function activeUrlToken(urlToken, bearerToken) {
  const raw = typeof urlToken === "string" ? urlToken : "";
  const bearer = configuredSecret(bearerToken);
  const trimmed = raw.trim();
  if (trimmed.length > 0 && bearer.length > 0 && timingSafeEq(trimmed, bearer)) {
    warnUrlToken("equal", "HEALTH_INGEST_URL_TOKEN matches HEALTH_INGEST_TOKEN; URL token auth is disabled");
    return "";
  }
  if (!URL_TOKEN_PATTERN.test(raw)) {
    if (trimmed.length > 0) warnUrlToken("pattern", "HEALTH_INGEST_URL_TOKEN is ignored; it must match ^[A-Za-z0-9_-]{32,}$");
    return "";
  }
  return raw;
}

/**
 * True when the request carries `Authorization: Bearer <HEALTH_INGEST_TOKEN>`.
 * On POST `/ingest/hc-webhook` and `/ingest/shortcuts` only, a missing
 * Authorization header may instead carry `HEALTH_INGEST_URL_TOKEN` as a raw
 * path segment or a literal `token=` query pair. Neither form is decoded or
 * trimmed. The value must match `^[A-Za-z0-9_-]{32,}$`. That secret is
 * write-only, is not accepted on `/summary`, `/mcp`, or any other route, and
 * does nothing when unset, malformed, or equal to `HEALTH_INGEST_TOKEN`.
 * An Authorization header is never checked against the URL token.
 * `env` may be the bearer token string, or an object with `HEALTH_INGEST_TOKEN`
 * and `HEALTH_INGEST_URL_TOKEN`. A missing or empty secret never authenticates.
 */
export function authed(req, env) {
  const bearerToken = typeof env === "string" ? env : env?.HEALTH_INGEST_TOKEN;
  const header = req.headers.get("authorization") || "";
  if (header) {
    const expected = configuredSecret(bearerToken);
    if (!expected) return false;
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) return false;
    return timingSafeEq(match[1].trim(), expected);
  }
  if (typeof env === "string" || !urlTokenRoute(req)) return false;
  const urlSecret = activeUrlToken(env?.HEALTH_INGEST_URL_TOKEN, bearerToken);
  if (!urlSecret) return false;
  const presented = presentedUrlToken(req);
  if (presented == null || !URL_TOKEN_PATTERN.test(presented)) return false;
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
    .replace(/(\/ingest\/(?:hc-webhook|shortcuts)\/)[^/?#\s]+/g, "$1[redacted]");
  for (const value of [secret, urlSecret]) {
    if (typeof value !== "string" || value.length === 0) continue;
    text = text.split(value).join("[redacted]");
    const encoded = encodeURIComponent(value);
    if (encoded !== value) text = text.split(encoded).join("[redacted]");
  }
  return text;
}
