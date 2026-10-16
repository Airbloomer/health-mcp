-- Registry D1: hmcp-pilot-registry
-- No health rows and no full token hashes.
-- Later phases add tables with additive migrations keyed by tenant_id.

CREATE TABLE tenants (
  tenant_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN (
    'pending_consent', 'approved', 'provisioning', 'active', 'frozen', 'deleting', 'deleted'
  )),
  created_at TEXT NOT NULL,
  worker_name TEXT NOT NULL UNIQUE,
  d1_name TEXT NOT NULL UNIQUE,
  d1_id TEXT,
  hostname TEXT NOT NULL UNIQUE,
  health_mcp_ref TEXT,
  billing_tag TEXT NOT NULL DEFAULT 'hmcp-pilot' CHECK (billing_tag = 'hmcp-pilot'),
  deletion_requested_at TEXT,
  deleted_at TEXT,
  CHECK (deleted_at IS NULL OR deletion_requested_at IS NOT NULL),
  CHECK (length(tenant_id) = 26 AND tenant_id NOT GLOB '*[^a-z2-7]*'),
  CHECK (worker_name = 'hmcp-pilot-' || tenant_id),
  CHECK (d1_name = 'hmcp-pilot-' || tenant_id),
  CHECK (hostname = tenant_id || '.health.airbloomer.com'),
  CHECK (worker_name != 'hmcp-pilot-registry'),
  CHECK (d1_name != 'hmcp-pilot-registry')
);

CREATE TABLE consents (
  consent_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
  consented_at TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('sms')),
  scope TEXT NOT NULL,
  notice_version TEXT NOT NULL,
  evidence_ref TEXT NOT NULL,
  evidence_hmac TEXT NOT NULL,
  evidence_key_version TEXT NOT NULL,
  withdrawn_at TEXT
);

-- Owner decision: the SMS consent copy lives in this registry.
-- Ciphertext only. The column does not hold the raw consent text.
-- Readable by the owner role. Retention is the life of the account plus 3 years.
CREATE TABLE consent_evidence (
  evidence_ref TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
  ciphertext TEXT NOT NULL,
  encryption TEXT NOT NULL CHECK (encryption IN ('age')),
  created_at TEXT NOT NULL,
  retention_policy TEXT NOT NULL CHECK (retention_policy = 'account_life_plus_3y')
);

CREATE TABLE token_meta (
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id),
  kind TEXT NOT NULL CHECK (kind IN ('ingest', 'mcp_read')),
  hash_alg TEXT NOT NULL DEFAULT 'sha256',
  hash_prefix TEXT NOT NULL CHECK (hash_prefix GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
  created_at TEXT NOT NULL,
  rotated_at TEXT,
  revoked_at TEXT,
  PRIMARY KEY (tenant_id, kind, created_at)
);

CREATE UNIQUE INDEX token_meta_prefix ON token_meta(hash_prefix);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN (
    'tenant_created',
    'consent_recorded',
    'evidence_rehashed',
    'token_issued',
    'token_rotated',
    'token_revoked',
    'status_changed',
    'deletion_requested',
    'deletion_completed',
    'export_requested',
    'export_delivered',
    'export_operator_copy_deleted',
    'worker_deploy',
    'secret_change'
  )),
  detail TEXT
);

CREATE INDEX consents_by_tenant ON consents(tenant_id);
CREATE INDEX events_by_tenant ON events(tenant_id);

CREATE TRIGGER tenants_require_consent_insert
BEFORE INSERT ON tenants
WHEN NEW.status IN ('approved', 'provisioning', 'active', 'frozen', 'deleting', 'deleted')
BEGIN
  SELECT RAISE(ABORT, 'activation requires consent')
  WHERE NOT EXISTS (
    SELECT 1 FROM consents
    WHERE tenant_id = NEW.tenant_id AND withdrawn_at IS NULL
  );
END;

CREATE TRIGGER tenants_require_consent_update
BEFORE UPDATE OF status ON tenants
WHEN NEW.status IN ('approved', 'provisioning', 'active', 'frozen', 'deleting', 'deleted')
BEGIN
  SELECT RAISE(ABORT, 'activation requires consent')
  WHERE NOT EXISTS (
    SELECT 1 FROM consents
    WHERE tenant_id = NEW.tenant_id AND withdrawn_at IS NULL
  );
END;
