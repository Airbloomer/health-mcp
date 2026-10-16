import { REGISTRY_SCRIPT, TENANT_ID_PATTERN, resourceName } from "../src/constants.mjs";
import { assertTenantDeployTarget } from "../src/lint.mjs";

if (process.argv.includes("--deploy")) {
  console.error("deploy is disabled");
  process.exit(1);
}

const tenantId = process.env.TENANT_ID || "";
if (!TENANT_ID_PATTERN.test(tenantId)) {
  console.error("tenant id is not valid");
  process.exit(1);
}

const scriptName = resourceName(tenantId);
assertTenantDeployTarget(scriptName);
if (scriptName === REGISTRY_SCRIPT) {
  console.error("tenant deploy cannot target the registry");
  process.exit(1);
}

console.log("validated tenant target; deploy is not run");
