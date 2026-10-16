// Cloudflare Workers entry. The platform-free core lives in src/core.
export { authed } from "./core/auth.js";
export { handleRequest } from "./core/http.js";
export { MemoryStorage } from "./core/memory.js";
export { localDate, parse } from "./core/parse.js";
export { summarizeDay } from "./core/summary.js";

export { default } from "./adapters/cloudflare.js";
