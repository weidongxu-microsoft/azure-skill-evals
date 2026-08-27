import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  evaluateRule,
  loadWorkspace,
  ruleNames,
} from "./tools/cosmos-python-rules.mjs";

const goldenWorkspacePath = fileURLToPath(
  new URL("./golden", import.meta.url),
);
const completeWorkspace = loadWorkspace(goldenWorkspacePath);

test("lint-clean reference application passes every static rule", () => {
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, completeWorkspace), true, rule);
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

test("key authentication does not satisfy the credential rule", () => {
  const workspace = {
    ...completeWorkspace,
    python: completeWorkspace.python
      .replace(
        "from azure.identity import DefaultAzureCredential",
        "",
      )
      .replace(
        "credential = DefaultAzureCredential()",
        'credential = os.environ["COSMOS_KEY"]',
      ),
  };

  assert.equal(
    evaluateRule("language/default-azure-credential", workspace),
    false,
  );
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

  const workspace = loadWorkspace(root);

  assert.equal(workspace.pythonFiles.length, 1);
  assert.equal(workspace.python.includes("DefaultAzureCredential"), false);
});
