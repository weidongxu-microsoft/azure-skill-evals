import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  evaluatePythonCheck,
  loadPythonWorkspace,
  pythonCheckNames,
} from "../../languages/python/checks.mjs";
import {
  evaluateRule,
  loadTodoRepositoryWorkspace,
  ruleNames,
} from "./tools/todo-repository-rules.mjs";

const goldenPath = fileURLToPath(new URL("./golden", import.meta.url));
const golden = loadTodoRepositoryWorkspace(goldenPath);
const languageWorkspace = loadPythonWorkspace(goldenPath);
const evalSpec = readFileSync(
  fileURLToPath(new URL("./eval.yaml", import.meta.url)),
  "utf8",
);

function replaceDocument(path, from, to, workspace = golden) {
  return {
    ...workspace,
    documents: workspace.documents.map((document) => ({
      ...document,
      source:
        document.path === path
          ? document.source.replaceAll("\r\n", "\n").replace(from, to)
          : document.source.replaceAll("\r\n", "\n"),
    })),
  };
}

function sourceWorkspace(source, dependencies = golden.dependencies) {
  return {
    dependencyManifests: [{ filename: "requirements.txt", content: dependencies }],
    documents: [{ path: "main.py", source }],
    applicationRoots: ["main.py"],
    topLevelPythonFiles: ["main.py"],
  };
}

test("Python golden passes every prompt rule and shared check", () => {
  assert.deepEqual(ruleNames(), [
    "prompt/sdk-pins",
    "prompt/todo-model",
    "prompt/secure-container-factory",
    "prompt/sync-crud-request-charges",
    "prompt/async-crud-request-charges",
    "prompt/etag-conflict-handling",
    "prompt/sync-parameterized-pagination",
    "prompt/async-parameterized-pagination",
    "prompt/connected-sync-then-async-demo",
  ]);
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, golden), true, rule);
  }
  for (const check of pythonCheckNames()) {
    assert.equal(evaluatePythonCheck(check, languageWorkspace), true, check);
  }
});

test("Python pins are exact, coherent, and stated in the stimulus", () => {
  assert.equal(
    golden.dependencies.replaceAll("\r\n", "\n"),
    "azure-cosmos==4.16.0\nazure-identity==1.25.3\n",
  );
  assert.match(evalSpec, /`azure-cosmos` to `4\.16\.0`/);
  assert.match(evalSpec, /`azure-identity` to `1\.25\.3`/);
  assert.equal(
    evaluateRule(
      "prompt/sdk-pins",
      sourceWorkspace(
        "def main():\n    pass\n",
        "azure-cosmos>=4.16.0\nazure-identity==1.25.3\n",
      ),
    ),
    false,
  );
  assert.equal(
    evaluateRule(
      "prompt/sdk-pins",
      sourceWorkspace(
        "def main():\n    pass\n",
        "# azure-cosmos==4.16.0\nazure-identity==1.25.3\n",
      ),
    ),
    false,
  );
  const pyproject = {
    ...sourceWorkspace("def main():\n    pass\n", ""),
    dependencyManifests: [{
      filename: "pyproject.toml",
      content: `[project]
dependencies = [
  "azure-cosmos==4.16.0",
  "azure-identity==1.25.3",
]
`,
    }],
  };
  assert.equal(evaluateRule("prompt/sdk-pins", pyproject), true);
});

test("focused Python omissions fail their own criteria", () => {
  const cases = [
    [
      "prompt/todo-model",
      replaceDocument("model.py", /description/g, "details"),
    ],
    [
      "prompt/secure-container-factory",
      replaceDocument("factory.py", "90 * 24 * 60 * 60", "89 * 24 * 60 * 60"),
    ],
    [
      "prompt/sync-crud-request-charges",
      replaceDocument(
        "repository.py",
        '                response_hook=_charge_hook("sync create"),\n',
        "",
      ),
    ],
    [
      "prompt/async-crud-request-charges",
      replaceDocument(
        "repository.py",
        "            document = await self._container.create_item(",
        "            document = self._container.create_item(",
      ),
    ],
    [
      "prompt/etag-conflict-handling",
      replaceDocument("repository.py", "                etag=item.etag,", "                etag=None,"),
    ],
    [
      "prompt/sync-parameterized-pagination",
      replaceDocument(
        "repository.py",
        '        parameters = [{"name": "@category", "value": category}]',
        "        parameters = []",
      ),
    ],
    [
      "prompt/async-parameterized-pagination",
      replaceDocument(
        "repository.py",
        "            pager = results.by_page()\n            async for page in pager:",
        "            pager = unrelated.by_page()\n            async for page in pager:",
      ),
    ],
    [
      "prompt/connected-sync-then-async-demo",
      replaceDocument("main.py", "    run_sync_demo()\n", ""),
    ],
  ];
  for (const [rule, workspace] of cases) {
    assert.equal(evaluateRule(rule, workspace), false, rule);
  }
});

test("valid Python alternate manifest, endpoint, and ETag forms pass", () => {
  let alternate = replaceDocument(
    "factory.py",
    'endpoint = os.environ["AZURE_COSMOS_ENDPOINT"]',
    'endpoint = os.getenv("AZURE_COSMOS_ENDPOINT")',
  );
  alternate = replaceDocument(
    "repository.py",
    "                etag=item.etag,\n                match_condition=MatchConditions.IfNotModified,\n",
    "                if_match=item.etag,\n",
    alternate,
  );
  assert.equal(evaluateRule("prompt/secure-container-factory", alternate), true);
  assert.equal(evaluateRule("prompt/etag-conflict-handling", alternate), true);
});

test("comments, strings, and fake Python SDK classes do not score", () => {
  const source = `
class CosmosClient:
    def create_database_if_not_exists(self):
        pass

class DefaultAzureCredential:
    pass

def main():
    notes = """
    create_item partition_key response_hook by_page continuation_token
    replace_item etag MatchConditions.IfNotModified
    """
    # CosmosClient(endpoint, credential=DefaultAzureCredential())
    print(notes)

if __name__ == "__main__":
    main()
`;
  const workspace = sourceWorkspace(source);
  for (const rule of ruleNames().filter((name) => name !== "prompt/sdk-pins")) {
    assert.equal(evaluateRule(rule, workspace), false, rule);
  }
});

test("unreachable and disconnected Python behavior does not score", () => {
  const unreachable = sourceWorkspace(`
from azure.cosmos import CosmosClient
from azure.identity import DefaultAzureCredential

def unused():
    client = CosmosClient("endpoint", credential=DefaultAzureCredential())
    client.create_database_if_not_exists(id="TodoDatabase")

def main():
    if False:
        unused()

if __name__ == "__main__":
    main()
`);
  assert.equal(evaluateRule("prompt/secure-container-factory", unreachable), false);

  const disconnected = replaceDocument(
    "main.py",
    "    run_sync_demo()\n    asyncio.run(run_async_demo())",
    "    print('ready')",
  );
  for (const rule of [
    "prompt/sync-crud-request-charges",
    "prompt/async-crud-request-charges",
    "prompt/connected-sync-then-async-demo",
  ]) {
    assert.equal(evaluateRule(rule, disconnected), false, rule);
  }
});

test("Python pagination evidence must remain on one iterator path", () => {
  const incompatible = replaceDocument(
    "repository.py",
    "            pager = results.by_page()\n            for page in pager:",
    "            pager = unrelated.by_page()\n            for page in pager:",
  );
  assert.equal(
    evaluateRule("prompt/sync-parameterized-pagination", incompatible),
    false,
  );
  assert.equal(
    evaluateRule("prompt/async-parameterized-pagination", incompatible),
    true,
  );
});
