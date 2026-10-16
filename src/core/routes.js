/** Route table shared by dispatch, URL-token auth, and the Node body limit. */

const PATH_TOKEN = "[A-Za-z0-9_%~.+-]+";

function exact(pathname, expected) {
  return pathname === expected;
}

export const ROUTES = [
  {
    id: "apple-health",
    method: "POST",
    match: (pathname) => exact(pathname, "/import/apple-health"),
    guard: "apple-stream",
    urlToken: false,
    samplePaths: ["/import/apple-health"],
  },
  {
    id: "apple-chunk",
    method: "POST",
    match: (pathname) => exact(pathname, "/import/apple-health/chunk"),
    guard: "json-ingest",
    urlToken: false,
    samplePaths: ["/import/apple-health/chunk"],
  },
  {
    id: "hc-webhook",
    method: "POST",
    match: (pathname) => pathname === "/ingest/hc-webhook" || /^\/ingest\/hc-webhook\/[^/]+$/.test(pathname),
    pathToken: new RegExp(`^/ingest/hc-webhook/(${PATH_TOKEN})$`),
    guard: "json-ingest",
    urlToken: true,
    samplePaths: ["/ingest/hc-webhook", `/ingest/hc-webhook/${"a".repeat(32)}`],
  },
  {
    id: "shortcuts",
    method: "POST",
    match: (pathname) => pathname === "/ingest/shortcuts" || /^\/ingest\/shortcuts\/[^/]+$/.test(pathname),
    pathToken: new RegExp(`^/ingest/shortcuts/(${PATH_TOKEN})$`),
    guard: "json-ingest",
    urlToken: true,
    samplePaths: ["/ingest/shortcuts", `/ingest/shortcuts/${"a".repeat(32)}`],
  },
  {
    id: "summary",
    method: "GET",
    match: (pathname) => exact(pathname, "/summary"),
    guard: "read",
    urlToken: false,
    samplePaths: ["/summary"],
  },
  {
    id: "limits",
    method: "GET",
    match: (pathname) => exact(pathname, "/limits"),
    guard: "read",
    urlToken: false,
    samplePaths: ["/limits"],
  },
  {
    id: "mcp",
    method: null,
    match: (pathname) => exact(pathname, "/mcp"),
    guard: "mcp",
    urlToken: false,
    samplePaths: ["/mcp"],
  },
];

const REMOVED_INGEST = [
  /^\/ingest\/?$/,
  /^\/ingest\/life-dashboard(?:\/[^/]*)?$/,
  /^\/ingest\/health-export-pro(?:\/[^/]*)?$/,
  /^\/ingest\/syncfit(?:\/[^/]*)?$/,
];

export function matchRoute(method, pathname) {
  const verb = (method || "GET").toUpperCase();
  return ROUTES.find((route) => (route.method == null || route.method === verb) && route.match(pathname)) || null;
}

export function isUrlTokenPath(pathname) {
  return ROUTES.some((route) => route.urlToken && route.match(pathname));
}

export function pathToken(pathname) {
  for (const route of ROUTES) {
    if (!route.pathToken) continue;
    const match = pathname.match(route.pathToken);
    if (match) return match[1];
  }
  return null;
}

/** Removed phone-adapter paths. The response does not depend on the token. */
export function isRemovedIngestPath(pathname) {
  return REMOVED_INGEST.some((pattern) => pattern.test(pathname));
}
