import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { lintWorkflowText } from "./workflow-lint.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ACTION = "actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0";

function sampleWorkflow(extra = "") {
  return `name: sample
on:
  workflow_dispatch:
permissions:
  contents: read
jobs:
  t:
    runs-on: ubuntu-latest
    steps:
      - uses: ${ACTION}
${extra}`;
}

test("checked-in workflows pass the supply-chain lint", () => {
  const dir = path.join(root, ".github", "workflows");
  const errors = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".yml") && !name.endsWith(".yaml")) continue;
    const text = fs.readFileSync(path.join(dir, name), "utf8");
    errors.push(...lintWorkflowText(name, text));
  }
  assert.deepEqual(errors, []);
});

test("publish.yml may keep job-level id-token write for npm OIDC", () => {
  const text = fs.readFileSync(path.join(root, ".github/workflows/publish.yml"), "utf8");
  assert.deepEqual(lintWorkflowText("publish.yml", text), []);
  assert.ok(lintWorkflowText("other.yml", text).includes("other.yml: job permission id-token: write"));
});

test("workflow lint rejects environment on a pull_request workflow", () => {
  const text = sampleWorkflow("    environment: prod\n").replace("workflow_dispatch:", "pull_request:");
  assert.ok(lintWorkflowText("bad.yml", text).includes("bad.yml: environment in a pull_request workflow"));
  assert.equal(lintWorkflowText("ok.yml", sampleWorkflow("    environment: prod\n")).includes("environment in a pull_request workflow"), false);
});

test("workflow lint rejects job-level write-all and id-token write", () => {
  assert.ok(lintWorkflowText("bad.yml", sampleWorkflow("    permissions: write-all\n")).some((item) => item.includes("write-all")));
  const token = sampleWorkflow("    permissions:\n      id-token: write\n");
  assert.ok(lintWorkflowText("bad.yml", token).includes("bad.yml: job permission id-token: write"));
  assert.equal(lintWorkflowText("publish.yml", token).includes("job permission id-token: write"), false);
});

test("workflow lint rejects extra top-level permissions", () => {
  const text = sampleWorkflow().replace("  contents: read\n", "  contents: read\n  packages: write\n");
  assert.ok(lintWorkflowText("bad.yml", text).includes("bad.yml: extra top-level permission packages"));
});

test("workflow lint rejects secrets bracket syntax", () => {
  const text = sampleWorkflow("      - run: echo ${{ secrets['TOKEN'] }}\n");
  assert.ok(lintWorkflowText("bad.yml", text).includes("bad.yml: secrets bracket syntax"));
});

test("workflow lint rejects npm i -g and unpinned wrangler", () => {
  assert.ok(lintWorkflowText("bad.yml", sampleWorkflow("      - run: npm i -g wrangler\n")).includes("bad.yml: npm i -g"));
  assert.ok(lintWorkflowText("bad.yml", sampleWorkflow("      - run: npx wrangler@latest\n")).includes("bad.yml: unpinned wrangler"));
  assert.ok(lintWorkflowText("bad.yml", sampleWorkflow("      - run: npm exec wrangler -- version\n")).includes("bad.yml: unpinned wrangler"));
  assert.equal(
    lintWorkflowText("ok.yml", sampleWorkflow("      - run: npx wrangler@4.151.1\n")).includes("unpinned wrangler"),
    false,
  );
});

test("workflow lint rejects persist-credentials true", () => {
  const text = sampleWorkflow("        with:\n          persist-credentials: true\n");
  assert.ok(lintWorkflowText("bad.yml", text).includes("bad.yml: persist-credentials true"));
  assert.equal(lintWorkflowText("ok.yml", sampleWorkflow("        with:\n          persist-credentials: false\n")).includes("persist-credentials true"), false);
});
