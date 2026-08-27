import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  evaluateRule,
  ruleNames,
} from "./tools/cosmos-python-rules.mjs";
import {
  evaluatePythonCheck,
  loadPythonWorkspace,
  pythonCheckNames,
} from "../../languages/python/checks.mjs";

const goldenWorkspacePath = fileURLToPath(
  new URL("./golden", import.meta.url),
);
const completeWorkspace = loadPythonWorkspace(goldenWorkspacePath);

test("lint-clean reference application passes every prompt rule", () => {
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, completeWorkspace), true, rule);
  }
});

test("lint-clean reference application passes every Python check", () => {
  for (const check of pythonCheckNames()) {
    assert.equal(evaluatePythonCheck(check, completeWorkspace), true, check);
  }
});

test("missing cross-partition option fails only its prompt rule", () => {
  const workspace = {
    ...completeWorkspace,
    python: completeWorkspace.python.replace(
      "enable_cross_partition_query=True,",
      "",
    ),
  };

  assert.equal(
    evaluateRule("prompt/cross-partition-query", workspace),
    false,
  );
  assert.equal(evaluateRule("prompt/cosmos-client", workspace), true);
});

test("container rule accepts a constant partition-key path", () => {
  const workspace = {
    ...completeWorkspace,
    python: completeWorkspace.python
      .replace(
        'from azure.cosmos import CosmosClient, PartitionKey',
        'from azure.cosmos import CosmosClient, PartitionKey\nPARTITION_KEY_PATH = "/category"',
      )
      .replace(
        'PartitionKey(path="/category")',
        "PartitionKey(path=PARTITION_KEY_PATH)",
      ),
  };

  assert.equal(evaluateRule("prompt/create-container", workspace), true);
});

test("workspace loading ignores Python files injected by skills", () => {
  const root = mkdtempSync(join(tmpdir(), "azure-skill-evals-"));
  const skillDirectory = join(root, "injected-skill");
  mkdirSync(skillDirectory);
  writeFileSync(
    join(skillDirectory, "example.py"),
    "from azure.identity import DefaultAzureCredential\n",
  );
  writeFileSync(join(root, "cosmos_crud.py"), "print('generated')\n");
  writeFileSync(join(root, "requirements.txt"), "azure-cosmos\n");

  const workspace = loadPythonWorkspace(root);

  assert.equal(workspace.pythonFiles.length, 1);
  assert.equal(workspace.python.includes("DefaultAzureCredential"), false);
});
