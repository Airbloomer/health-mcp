import { selfTestAlerts } from "../src/audit.mjs";

if (process.argv.includes("--self-test")) {
  const alerts = selfTestAlerts();
  console.log(JSON.stringify({ ok: true, alerts: alerts.map((alert) => alert.kind) }));
  process.exit(0);
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const event = JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
const { buildOwnerAlert } = await import("../src/audit.mjs");
const alert = buildOwnerAlert(event);
if (!alert) {
  console.error("event is not a worker deploy or a secret change");
  process.exit(1);
}
console.log(JSON.stringify(alert));
