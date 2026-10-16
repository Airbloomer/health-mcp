# Cloudflare account access

Role labels only. This file is the access list for the pilot Cloudflare account.

## Account members

2FA is required for every member.

No Global API Key exists or is in use.

| Role label | Cloudflare role | Second factor |
| --- | --- | --- |
| owner-operator | Administrator | required |
| security-reviewer | Administrator | required |

## Time-box

Security re-reviews before tenant 3 is provisioned, or by 2027-01-31, whichever comes first. After that point a separate registry account is mandatory unless the single-account fallback is re-accepted.

The acceptance covers the 2-user pilot only.

## Residual risk

An account-scoped tenant deploy token can technically reach the registry Worker/D1; mitigated by CI separation, environment reviewers and audit alerts.

The owner acknowledges this line by signing off on the pull request.

## Tokens

Cloudflare has no GitHub OIDC for API tokens. These tokens are therefore issued with an expiry, an IP filter, environment-only storage, and a rotation schedule.

Rules for every token:

- TTL is 90 days.
- Client IP filtering is required where CI egress allows it.
- Store the token only as a GitHub environment secret behind a required reviewer.
- Never store the token as a repo secret or an org secret.
- Rotate it every 90 days, and immediately on any personnel or access change.

Rotation dates: not issued. This phase does not create tokens. The first rotation is due 90 days after a token is issued.

### Tenant deploy token

- Purpose: deploy tenant workers and tenant D1 databases, plus DNS and Workers Routes for `health.airbloomer.com`.
- Account: the Airbloomer account (single-account fallback).
- Permissions: Workers Scripts Edit, D1 Edit.
- Zone: `airbloomer.com`.
- Holder role: ci-deploy-token.
- GitHub environment: `pilot-tenant-deploy`.
- Reviewer role: security-reviewer.
- Secret name: `PILOT_TENANT_DEPLOY_TOKEN`.
- TTL: 90 days.
- IP filter: required.
- Rotation: every 90 days, and immediately on personnel or access change.
- Rotation dates: not issued.

### Registry-admin token

- Purpose: changes to the registry worker and the registry D1 only.
- Account: the same Airbloomer account.
- Permissions: Workers Scripts Edit, D1 Edit.
- Zone: none.
- Holder role: registry-admin.
- GitHub environment: `registry-admin`.
- Reviewer role: security-reviewer.
- A required reviewer must approve each run, and that reviewer cannot be the person who triggered it.
- Secret name: `REGISTRY_ADMIN_TOKEN`.
- TTL: 90 days.
- IP filter: required.
- Rotation: every 90 days, and immediately on personnel or access change.
- Rotation dates: not issued.

### Analytics token

- Purpose: monthly usage counts for attribution.
- Account: the Airbloomer account.
- Permissions: Account Analytics Read.
- Zone: none.
- Holder role: pilot-analytics.
- GitHub environment: `pilot-analytics`.
- Reviewer role: security-reviewer.
- Secret name: `PILOT_ANALYTICS_TOKEN`.
- Scope note: D1 analytics return counts only. Tenant health rows are not readable with this token.
- TTL: 90 days.
- IP filter: required.
- Rotation: every 90 days, and immediately on personnel or access change.
- Rotation dates: not issued.

## Audit alerts

Alerts go to the owner on every Worker deploy and every secret change (create, update, or delete) on the account.

## Plan

The pilot stays on the Cloudflare free tier. Recorded plan: free tier; upgrade when a real limit is hit.

CPU stays within 10 ms per invocation. D1 writes stay within 100,000 rows per UTC day. At 80 percent of either cap the worker logs one JSON line. The line names `limit_approaching` or `limit_reached`, the limit (`worker_cpu_ms` or `d1_rows_written`), `used`, `cap`, and the plan string above. A D1 write that would pass the daily cap is not issued.

## Changes

Update this file in the same pull request as any access change. Security signs off before any deploy.
