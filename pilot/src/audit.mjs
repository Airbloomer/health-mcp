/**
 * PENDING. Required before deploy.
 * This module does not read the Cloudflare account audit log.
 * The published schema names action.type and resource.type as strings and does not
 * list Worker deploy or Worker secret values. The v2 example sets resource.type to "type":
 * https://developers.cloudflare.com/fundamentals/account/account-security/audit-logs/
 * https://developers.cloudflare.com/logs/logpush/logpush-job/datasets/account/audit_logs/
 * The fixtures below are synthetic. They are not those field values.
 */
export const AUDIT_ALERT_STATUS = "PENDING";

/**
 * Classify a synthetic event used by the self-test.
 * Secret changes are matched first so a secret resource is not treated as a deploy.
 */
export function classifyAuditEvent(event) {
  const resource = String(event?.resource?.type ?? "").toLowerCase();
  const action = String(event?.action?.type ?? event?.action ?? "").toLowerCase();
  if (!resource || !action) return null;
  if (resource.includes("secret") && ["create", "update", "delete"].includes(action)) {
    return "secret_change";
  }
  const worker = resource.includes("worker") || resource.includes("script");
  if (worker && ["create", "update", "deploy", "upload"].includes(action)) {
    return "worker_deploy";
  }
  return null;
}

/** Alert addressed to the owner role. Secret values and request bodies are dropped. */
export function buildOwnerAlert(event) {
  const kind = classifyAuditEvent(event);
  if (!kind) return null;
  const alert = {
    to: "owner",
    kind,
    action: String(event?.action?.type ?? event?.action ?? ""),
    resource_type: String(event?.resource?.type ?? ""),
  };
  if (event?.resource?.id != null) alert.resource_id = String(event.resource.id);
  if (event?.when != null) alert.at = String(event.when);
  return alert;
}

export const SELF_TEST_FIXTURES = [
  {
    when: "2026-10-01T00:00:00Z",
    action: { type: "update" },
    resource: { type: "workers_script", id: "hmcp-pilot-example" },
    secret: "do-not-copy",
  },
  {
    when: "2026-10-01T00:00:01Z",
    action: { type: "create" },
    resource: { type: "workers_script_secret", id: "hmcp-pilot-example" },
    new_value: "do-not-copy",
  },
  {
    when: "2026-10-01T00:00:02Z",
    action: { type: "delete" },
    resource: { type: "workers_secret", id: "hmcp-pilot-example" },
  },
];

export function selfTestAlerts() {
  const alerts = SELF_TEST_FIXTURES.map((event) => buildOwnerAlert(event));
  if (alerts.some((alert) => !alert || alert.to !== "owner")) {
    throw new Error("audit alert must notify the owner");
  }
  const kinds = new Set(alerts.map((alert) => alert.kind));
  if (!kinds.has("worker_deploy") || !kinds.has("secret_change")) {
    throw new Error("audit alert must cover deploys and secret changes");
  }
  const encoded = JSON.stringify(alerts);
  if (encoded.includes("do-not-copy")) {
    throw new Error("audit alert copied a secret value");
  }
  return alerts;
}
