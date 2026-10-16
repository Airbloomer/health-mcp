# Token rotation

Cloudflare has no GitHub OIDC for API tokens. Tenant-deploy, registry-admin, and analytics tokens are expiring, IP-filtered GitHub environment secrets. See `docs/cf-access.md`.

Rotate every 90 days, and immediately on any personnel or access change. Rotation dates stay `not issued` until a token exists.

Per-tenant ingest and read tokens are random (CSPRNG, at least 32 bytes, URL-safe, never user-chosen). The plaintext is shown once to the operator, sent outside the consent SMS thread, and never written to logs, CI output, or the registry. The registry stores an 8-hex prefix of the SHA-256 only.

Later provisioning replaces a tenant token by writing the new secret, allowing a grace period of at most 24 hours, then revoking the old prefix. An incident revokes immediately and sets the tenant to `frozen`.
