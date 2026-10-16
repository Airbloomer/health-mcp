# Consent HMAC re-hash

The key is a wrangler secret on the registry Worker only: `CONSENT_EVIDENCE_HMAC_KEY_<version>`. It is never in D1, git, CI logs, or a tenant Worker.

Dev, CI-test, and pilot each have their own key and version namespace (`dev-1`, `ci-test-1`, `pilot-1`). The current version is the non-secret var `CONSENT_EVIDENCE_KEY_VERSION`.

## Procedure

1. Add the new version secret and keep the old one.
2. Switch `CONSENT_EVIDENCE_KEY_VERSION` to the new version.
3. For every consent row, recompute the HMAC from the stored evidence ciphertext and update `evidence_hmac` and `evidence_key_version`.
4. Write a metadata-only `evidence_rehashed` event.
5. Confirm no row still uses the old version.
6. Only then remove the old secret.

A row written under the old version keeps verifying until it is re-hashed. After the re-hash, removing the old key does not affect that row.
