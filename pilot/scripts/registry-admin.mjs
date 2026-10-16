import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.argv.includes("--deploy")) {
  console.error("deploy is disabled");
  process.exit(1);
}

const policyPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "environments",
  "registry-admin.policy.json",
);
const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
if (!policy.prevent_self_review || !policy.required_reviewers) {
  console.error("registry-admin policy does not require a distinct reviewer");
  process.exit(1);
}

console.log("registry admin checks passed; deploy is not run");
