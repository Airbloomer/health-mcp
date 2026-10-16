import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertDistinctReviewer } from "../src/reviewer.mjs";

const policyPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "environments",
  "registry-admin.policy.json",
);
const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));

async function approversFromEnvOrApi() {
  const listed = (process.env.APPROVERS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (listed.length) return listed;
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  if (!token || !repo || !runId) return [];
  const response = await fetch(`https://api.github.com/repos/${repo}/actions/runs/${runId}/approvals`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "health-mcp-pilot",
    },
  });
  if (!response.ok) return [];
  const body = await response.json();
  if (!Array.isArray(body)) return [];
  return body
    .filter((item) => item?.state === "approved")
    .map((item) => item?.user?.login)
    .filter(Boolean);
}

const actor = process.env.ACTOR || process.env.GITHUB_ACTOR || "";
try {
  assertDistinctReviewer({ actor, approvers: await approversFromEnvOrApi(), policy });
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
console.log("reviewer is distinct from the triggering actor");
