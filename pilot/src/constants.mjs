/** Billing tag and the resource-name prefix derived from it. */
export const BILLING_TAG = "hmcp-pilot";

export const NAME_PREFIX = `${BILLING_TAG}-`;

export const REGISTRY_SCRIPT = `${NAME_PREFIX}registry`;

export const REGISTRY_DATABASE = REGISTRY_SCRIPT;

export const TENANT_ID_PATTERN = /^[a-z2-7]{26}$/;

export const HOST_SUFFIX = ".health.airbloomer.com";

export const SUMMARY_ALLOWLIST = [
  "dietary_energy",
  "protein",
  "carbohydrates",
  "total_fat",
  "active_energy",
  "basal_energy_burned",
  "step_count",
  "weight_body_mass",
  "body_fat_percentage",
].join(",");

/** Sensitive types the pilot does not opt into. Matched as substrings of the allowlist. */
export const SENSITIVE_MARKERS = [
  "menstruation",
  "ovulation",
  "cervical",
  "sexual",
  "intermenstrual",
  "glucose",
  "sleep",
  "body_temperature",
  "skin_temperature",
  "basal_body",
  "basal_temperature",
];

export const ROLE_LABELS = [
  "owner",
  "owner-operator",
  "security-reviewer",
  "ci-deploy-token",
  "registry-admin",
  "pilot-analytics",
];

export const RESIDUAL_RISK_LINE =
  "An account-scoped tenant deploy token can technically reach the registry Worker/D1; mitigated by CI separation, environment reviewers and audit alerts.";

export const TOKEN_TTL_DAYS = 90;

export const RE_REVIEW_DATE = "2027-01-31";

export const EXPORT_ACTIONS = [
  "export_requested",
  "export_delivered",
  "export_operator_copy_deleted",
];

export const EVENT_ACTIONS = [
  "tenant_created",
  "consent_recorded",
  "evidence_rehashed",
  "token_issued",
  "token_rotated",
  "token_revoked",
  "status_changed",
  "deletion_requested",
  "deletion_completed",
  ...EXPORT_ACTIONS,
  "worker_deploy",
  "secret_change",
];

export const USAGE_CSV_COLUMNS = [
  "month",
  "resource",
  "requests",
  "cpu",
  "d1_rows_read",
  "d1_rows_written",
  "storage_bytes",
];

export const REGISTRY_ADMIN_ENVIRONMENT = "registry-admin";

export const TENANT_DEPLOY_ENVIRONMENT = "pilot-tenant-deploy";

export const ANALYTICS_ENVIRONMENT = "pilot-analytics";

export const REGISTRY_ADMIN_SECRET = "REGISTRY_ADMIN_TOKEN";

export const TENANT_DEPLOY_SECRET = "PILOT_TENANT_DEPLOY_TOKEN";

export const ANALYTICS_SECRET = "PILOT_ANALYTICS_TOKEN";

export const HMAC_SECRET_PREFIX = "CONSENT_EVIDENCE_HMAC_KEY";

export const TENANT_SECRET_NAMES = ["INGEST_TOKEN_HASH", "MCP_READ_TOKEN_HASH"];

export function resourceName(id) {
  return `${NAME_PREFIX}${id}`;
}
