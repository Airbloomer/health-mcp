# Registry

Database name: `hmcp-pilot-registry`. Resource names use the `hmcp-pilot-` prefix, which is the `BILLING_TAG` plus a hyphen.

The registry holds no health data, no phone numbers, no plaintext tokens, and no full token hashes. Tenant Workers are never bound to it.

## Consent evidence

The SMS consent copy is stored in this database, in `consent_evidence`, as `age` ciphertext. `consents.evidence_ref` points at that row. `evidence_hmac` is HMAC-SHA256 over those stored bytes, keyed by `CONSENT_EVIDENCE_HMAC_KEY_<version>` on the registry Worker only.

Who can read it: the owner role. Tenant Workers have no binding to this database.

The age private key lives with the owner role, outside this repository and outside D1. It is not on the registry Worker, not on a tenant Worker, and not in CI.

Encryption: `age` ciphertext in the column, plus the platform's encryption of D1 at rest.

Retention: the life of the account plus 3 years (`account_life_plus_3y`). This is the documented retention exception. Deleting a tenant does not delete the ciphertext early.

## Deletion of a tenant

Deleting a tenant deletes that tenant's Worker, its secrets, and its whole D1 database. The registry records `deletion_requested_at` when deletion is requested and `deleted_at` when the database delete finishes. Health data is fully deleted within 30 days. That window covers D1 Time Travel retention. Whether a database delete purges Time Travel immediately is still to be confirmed.

## Activation

Status `approved` and every later status requires a consent row whose `withdrawn_at` is empty.
