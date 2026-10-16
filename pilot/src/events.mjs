import { EVENT_ACTIONS, EXPORT_ACTIONS, ROLE_LABELS } from "./constants.mjs";

const DETAIL_KEYS = new Set([
  "at",
  "count",
  "counts",
  "version",
  "status",
  "route",
  "resource",
  "result",
  "key_version",
  "rows",
  "sla_days",
  "encryption",
  "channel",
]);

const WORKFLOW_NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/;

export function assertActor(actor) {
  if (ROLE_LABELS.includes(actor) || WORKFLOW_NAME.test(actor || "")) return;
  throw new Error("actor must be a role label or a workflow name");
}

function sensitiveValue(value) {
  const text = String(value);
  if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text)) return true;
  if (/(?:\+\d{10,15}\b)|(?:\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b)/.test(text)) return true;
  if (/^[A-Za-z0-9_-]{32,}$/.test(text)) return true;
  return false;
}

/** `detail` is metadata only: an allowlisted object, or empty. */
export function assertMetadataDetail(detail) {
  if (detail == null || detail === "") return;
  const value = typeof detail === "string" ? JSON.parse(detail) : detail;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("detail must be a metadata object");
  }
  for (const [key, item] of Object.entries(value)) {
    if (!DETAIL_KEYS.has(key)) throw new Error(`detail key is not metadata: ${key}`);
    if (item != null && typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") {
      throw new Error("detail values must be scalars");
    }
    if (typeof item === "string" && sensitiveValue(item)) {
      throw new Error("detail value is not metadata");
    }
  }
}

export function assertEvent(row) {
  assertActor(row.actor);
  if (!EVENT_ACTIONS.includes(row.action)) throw new Error("event action is not allowed");
  assertMetadataDetail(row.detail);
}

export { EXPORT_ACTIONS, EVENT_ACTIONS };
