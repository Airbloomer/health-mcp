# Pilot deploy tooling

Current spec: [`specs/p1.md`](../specs/p1.md). Account access: [`docs/cf-access.md`](../docs/cf-access.md).

P1 builds the registry schema, tenant config checks, and CI guards. It does not deploy and it does not call `wrangler deploy`.

`HEALTH_MCP_REF` is a 40-hex commit that must be an ancestor of `main`. CI runs `git merge-base --is-ancestor` against `origin/main`.

Secret scanning and push protection stay on. Gitignore covers `tenants/*.rendered.toml`, `*.secret`, `.dev.vars`, and `.wrangler/`. CI runs gitleaks.

Wrangler is pinned in `pilot/package-lock.json`. Do not use `npx wrangler@latest`.

The pilot stays on the Cloudflare free tier. Plan: free tier; upgrade when a real limit is hit. CPU stays within 10 ms per invocation and D1 stays within 100,000 rows written per UTC day. The worker logs a JSON signal when either limit is approached, and it does not write a batch that would pass the daily D1 cap.

`.github/CODEOWNERS` is required before P3. It covers `HEALTH_MCP_REF`, `.github/workflows/`, `pilot/templates/`, and `pilot/registry/migrations/`. Branch protection must require the reviewer and security-reviewer role teams before P3. The ancestor check does not stop a self-merged pin bump.
