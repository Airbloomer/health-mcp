import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseToml } from "./toml.mjs";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "environments");

export function loadKeyEnvironments() {
  const names = ["dev.toml", "ci-test.toml", "pilot.toml"];
  return names.map((name) => {
    const text = fs.readFileSync(path.join(dir, name), "utf8");
    const doc = parseToml(text);
    return {
      file: name,
      name: doc.values.name,
      namespace: doc.values.EVIDENCE_KEY_NAMESPACE,
      version: doc.values.CONSENT_EVIDENCE_KEY_VERSION,
    };
  });
}

export function assertEnvironmentKeys(configs = loadKeyEnvironments()) {
  const namespaces = configs.map((item) => item.namespace);
  if (namespaces.some((item) => !item)) throw new Error("key namespace is missing");
  if (new Set(namespaces).size !== namespaces.length) {
    throw new Error("key version namespaces must be distinct");
  }
  const pilot = configs.find((item) => item.name === "pilot");
  const ci = configs.find((item) => item.name === "ci-test");
  if (!pilot || !ci) throw new Error("pilot and ci-test key configs are required");
  if (ci.version === pilot.version || ci.namespace === pilot.namespace) {
    throw new Error("ci-test key id equals a pilot key id");
  }
  for (const item of configs) {
    if (!String(item.version).startsWith(`${item.namespace}-`)) {
      throw new Error("key version is outside its namespace");
    }
  }
}
