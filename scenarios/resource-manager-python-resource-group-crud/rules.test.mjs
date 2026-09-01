import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  evaluateRule,
  loadResourceGroupWorkspace,
  ruleNames,
} from "./tools/resource-group-rules.mjs";

const goldenPath = fileURLToPath(new URL("./golden", import.meta.url));
const goldenWorkspace = loadResourceGroupWorkspace(goldenPath);
const dependencies = goldenWorkspace.dependencies;
const completeSource = readFileSync(
  join(goldenPath, "resource_group_crud.py"),
  "utf8",
).replaceAll("\r\n", "\n");
const sourceRules = ruleNames().filter(
  (name) => name !== "prompt/sdk-packages",
);

function workspace(
  python,
  manifest = dependencies,
  filename = "requirements.txt",
) {
  return {
    dependencies: manifest,
    dependencyManifests: [{ content: manifest, filename }],
    sources: [python],
  };
}

function withHttpHandler(body, source = completeSource) {
  return source.replace(
    `    except HttpResponseError as error:
        print(f"Resource group operation failed: {error}", file=sys.stderr)
        raise`,
    `    except HttpResponseError as error:
${body}`,
  );
}

test.skip("pinned golden passes exactly nine equally weighted rules", () => {
  assert.deepEqual(ruleNames(), [
    "prompt/sdk-packages",
    "prompt/configuration",
    "prompt/authenticated-management-client",
    "prompt/create-resource-group",
    "prompt/list-resource-groups",
    "prompt/get-resource-group",
    "prompt/update-tags",
    "prompt/delete-resource-group",
    "prompt/sdk-error-handling",
  ]);
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, goldenWorkspace), true, rule);
  }
});

test.skip("workspace discovery scores generated source and root manifests only", () => {
  const root = fileURLToPath(new URL("./.workspace-fixture", import.meta.url));
  rmSync(root, { recursive: true, force: true });
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "tests"), { recursive: true });
    mkdirSync(join(root, "generated"), { recursive: true });
    mkdirSync(join(root, ".vally"), { recursive: true });
    writeFileSync(join(root, "requirements.txt"), dependencies);
    writeFileSync(join(root, "src", "application.py"), completeSource);
    writeFileSync(join(root, "tests", "test_decoy.py"), completeSource);
    writeFileSync(join(root, "generated", "decoy.py"), completeSource);
    writeFileSync(join(root, ".vally", "skill.py"), completeSource);
    writeFileSync(join(root, "README.md"), completeSource);

    const discovered = loadResourceGroupWorkspace(root);
    assert.deepEqual(discovered.pythonFiles, [
      join(root, "src", "application.py"),
    ]);
    for (const rule of ruleNames()) {
      assert.equal(evaluateRule(rule, discovered), true, rule);
    }

    writeFileSync(join(root, "src", "application.py"), "print('generated')\n");
    const decoysOnly = loadResourceGroupWorkspace(root);
    for (const rule of sourceRules) {
      assert.equal(evaluateRule(rule, decoysOnly), false, rule);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.skip("empty, invalid, comment-only, and prose-only source fail", () => {
  for (const source of [
    "",
    "# ResourceManagementClient create_or_update begin_delete\n",
    '"""DefaultAzureCredential ResourceGroup HttpResponseError"""\n',
    "this is not valid Python",
  ]) {
    for (const rule of ruleNames()) {
      assert.equal(evaluateRule(rule, workspace(source)), false, rule);
    }
  }
});

test.skip("runtime package declarations accept standard manifest forms", () => {
  const cases = [
    [
      "requirements-prod.txt",
      "azure_identity[broker]>=1.25\nazure.mgmt.resource~=26.0",
    ],
    [
      "pyproject.toml",
      `[project]\ndependencies = ["azure-identity>=1.25", "azure-mgmt-resource>=26"]`,
    ],
    [
      "pyproject.toml",
      `[tool.poetry.dependencies]\npython = "^3.11"\nazure-identity = "1.25.3"\nazure-mgmt-resource = "26.0.0"`,
    ],
    [
      "setup.py",
      `from setuptools import setup\nsetup(install_requires=["azure-identity", "azure-mgmt-resource"])`,
    ],
  ];
  for (const [filename, manifest] of cases) {
    assert.equal(
      evaluateRule(
        "prompt/sdk-packages",
        workspace("print('app')", manifest, filename),
      ),
      true,
      filename,
    );
  }
});

test.skip("prose, development manifests, optional groups, and one package fail", () => {
  const cases = [
    [
      "requirements.txt",
      "Install azure-identity and azure-mgmt-resource.",
    ],
    [
      "requirements-dev.txt",
      "azure-identity\nazure-mgmt-resource",
    ],
    [
      "pyproject.toml",
      `[project.optional-dependencies]\ndev = ["azure-identity", "azure-mgmt-resource"]`,
    ],
    ["requirements.txt", "azure-identity==1.25.3"],
    ["requirements.txt", "azure-mgmt-resource==26.0.0"],
  ];
  for (const [filename, manifest] of cases) {
    assert.equal(
      evaluateRule(
        "prompt/sdk-packages",
        workspace("print('app')", manifest, filename),
      ),
      false,
      `${filename}: ${manifest}`,
    );
  }
});

test.skip("each missing lifecycle behavior fails its focused rule", () => {
  const mutations = [
    [
      "prompt/configuration",
      'os.environ["AZURE_SUBSCRIPTION_ID"]',
      'os.environ["SUBSCRIPTION_ID"]',
    ],
    [
      "prompt/authenticated-management-client",
      "ResourceManagementClient(credential, subscription_id)",
      "ResourceManagementClient(credential, 'hard-coded')",
    ],
    [
      "prompt/create-resource-group",
      "created = client.resource_groups.create_or_update(",
      "created = missing.create_or_update(",
    ],
    [
      "prompt/list-resource-groups",
      "for resource_group in client.resource_groups.list():",
      "for resource_group in []:",
    ],
    [
      "prompt/get-resource-group",
      "print(f\"Retrieved: {retrieved.name} in {retrieved.location}\")",
      'print("Retrieved")',
    ],
    [
      "prompt/update-tags",
      'print(f"Updated tags: {updated.tags}")',
      'print("Updated tags")',
    ],
    [
      "prompt/delete-resource-group",
      "deletion.result()",
      "deletion.wait()",
    ],
    [
      "prompt/sdk-error-handling",
      "except HttpResponseError as error:",
      "except ValueError as error:",
    ],
  ];
  for (const [rule, from, to] of mutations) {
    assert.equal(
      evaluateRule(rule, workspace(completeSource.replace(from, to))),
      false,
      rule,
    );
  }
});

test.skip("qualified imports, aliases, bound helpers, and members pass", () => {
  const alternate = workspace(`
import os
import sys
import azure.identity as identity
import azure.mgmt.resource as arm
import azure.mgmt.resource.resources.models as models
from azure.core import exceptions as errors

SUBSCRIPTION = os.environ["AZURE_SUBSCRIPTION_ID"]
NAME = os.environ["AZURE_RESOURCE_GROUP_NAME"]
LOCATION = os.environ.get("AZURE_LOCATION", "east" + "us")

class Lifecycle:
    def __init__(self, client):
        self.groups = client.resource_groups

    def execute(self):
        create = self.groups.create_or_update
        created = create(NAME, models.ResourceGroup(location=LOCATION))
        print(created.name)
        listing = self.groups.list
        results = listing()
        for group in results:
            print(group.name)
        read = self.groups.get
        found = read(resource_group_name=NAME)
        print(found.location)
        change = self.groups.update
        changed = change(NAME, {"tags": {"environment": "development"}})
        print(changed.tags)
        remove = self.groups.begin_delete
        pending = remove(resource_group_name=NAME)
        finish = pending.result
        finish()
        print("deleted:", NAME)

def main():
    credential = identity.DefaultAzureCredential()
    client = arm.ResourceManagementClient(
        credential=credential,
        subscription_id=SUBSCRIPTION,
    )
    try:
        Lifecycle(client).execute()
    except errors.HttpResponseError as failure:
        print(failure, file=sys.stderr)
        raise

main()
`);
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, alternate), true, rule);
  }
});

test.skip("reachable sync helpers can return SDK results and pollers", () => {
  const source = completeSource
    .replace(
      "def run() -> None:",
      `def create(groups, name, model):
    return groups.create_or_update(name, model)

def remove(groups, name):
    return groups.begin_delete(name)

def finish(poller):
    return poller.result()

def run() -> None:`,
    )
    .replace(
      "created = client.resource_groups.create_or_update(",
      "created = create(client.resource_groups,",
    )
    .replace(
      "deletion = client.resource_groups.begin_delete(resource_group_name)",
      "deletion = remove(client.resource_groups, resource_group_name)",
    )
    .replace("deletion.result()", "finish(deletion)");
  assert.equal(
    evaluateRule("prompt/delete-resource-group", workspace(source)),
    true,
  );
});

test.skip("fake SDK types and uncalled lifecycle helpers do not score", () => {
  const fake = workspace(`
import os
class DefaultAzureCredential: pass
class ResourceGroup:
    def __init__(self, **kwargs): pass
class ResourceManagementClient:
    def __init__(self, *args): self.resource_groups = self
    def create_or_update(self, *args): return self
    def list(self): return [self]
    def get(self, *args): return self
    def update(self, *args): return self
    def begin_delete(self, *args): return self
    def result(self): pass
subscription = os.environ["AZURE_SUBSCRIPTION_ID"]
name = os.environ["AZURE_RESOURCE_GROUP_NAME"]
location = os.environ.get("AZURE_LOCATION", "eastus")
client = ResourceManagementClient(DefaultAzureCredential(), subscription)
client.create_or_update(name, ResourceGroup(location=location))
for group in client.list(): print(group.name)
print(client.get(name).name)
print(client.update(name, {"tags": {"environment": "development"}}).tags)
poller = client.begin_delete(name)
poller.result()
print(name)
`);
  for (const rule of sourceRules.filter(
    (name) => name !== "prompt/configuration",
  )) {
    assert.equal(evaluateRule(rule, fake), false, rule);
  }
  assert.equal(evaluateRule("prompt/configuration", fake), true);

  const uncalled = completeSource.replace(
    'if __name__ == "__main__":\n    run()',
    'if __name__ == "__main__":\n    pass',
  );
  assert.equal(
    evaluateRule("prompt/create-resource-group", workspace(uncalled)),
    false,
  );
});

test.skip("configuration and operation values require exact provenance", () => {
  const cases = [
    completeSource.replace(
      '"AZURE_RESOURCE_GROUP_NAME"',
      '"RESOURCE_GROUP_NAME"',
    ),
    completeSource.replace(
      'os.environ.get("AZURE_LOCATION", "eastus")',
      'os.environ.get("AZURE_LOCATION", "westus")',
    ),
    completeSource.replace(
      "ResourceGroup(location=location)",
      'ResourceGroup(location="eastus")',
    ),
    completeSource.replace(
      "resource_group_name,\n            parameters,",
      '"hard-coded-name",\n            parameters,',
    ),
    completeSource.replace(
      "credential, subscription_id",
      "credential, resource_group_name",
    ),
  ];
  for (const source of cases) {
    assert.equal(
      evaluateRule("prompt/delete-resource-group", workspace(source)),
      false,
    );
  }
});

test.skip("ResourceGroup model, exact tag, and observed update are required", () => {
  const cases = [
    completeSource.replace(
      "parameters = ResourceGroup(location=location)",
      'parameters = {"location": location}',
    ),
    completeSource.replace(
      '"environment": "development"',
      '"environment": "production"',
    ),
    completeSource.replace(
      "updated = client.resource_groups.update(",
      "updated = client.resource_groups.get(",
    ),
    completeSource.replace(
      'print(f"Updated tags: {updated.tags}")',
      'print("environment=development")',
    ),
  ];
  for (const source of cases) {
    assert.equal(
      evaluateRule("prompt/update-tags", workspace(source)),
      false,
    );
  }
});

test.skip("list must be iterated and output real items, not hard-coded text", () => {
  const uniterated = completeSource.replace(
    `        for resource_group in client.resource_groups.list():
            print(f"Resource group: {resource_group.name}")`,
    `        groups = client.resource_groups.list()
        print("Resource groups listed")`,
  );
  assert.equal(
    evaluateRule("prompt/list-resource-groups", workspace(uniterated)),
    false,
  );

  const hardcoded = completeSource.replace(
    'print(f"Resource group: {resource_group.name}")',
    'print("Resource group")',
  );
  assert.equal(
    evaluateRule("prompt/list-resource-groups", workspace(hardcoded)),
    false,
  );

  const unrelated = completeSource.replace(
    'print(f"Retrieved: {retrieved.name} in {retrieved.location}")',
    "print(created.name)",
  );
  assert.equal(
    evaluateRule("prompt/get-resource-group", workspace(unrelated)),
    false,
  );

  const comprehension = completeSource.replace(
    `        for resource_group in client.resource_groups.list():
            print(f"Resource group: {resource_group.name}")`,
    `        print([
            resource_group.name
            for resource_group in client.resource_groups.list()
        ])`,
  );
  assert.equal(
    evaluateRule("prompt/list-resource-groups", workspace(comprehension)),
    true,
  );
});

test.skip("deletion requires exact poller result, order, and later confirmation", () => {
  const cases = [
    completeSource.replace(
      `deletion.result()
        print(f"Deleted resource group: {resource_group_name}")`,
      `print(f"Deleted resource group: {resource_group_name}")
        deletion.result()`,
    ),
    completeSource.replace("deletion.result()", "other.result()"),
    completeSource.replace("deletion.result()", "deletion.wait()"),
    completeSource.replace(
      'print(f"Deleted resource group: {resource_group_name}")',
      'print("Deleted resource group")',
    ),
    completeSource.replace(
      "deletion.result()",
      "client.resource_groups.begin_delete(resource_group_name).result()",
    ),
  ];
  for (const source of cases) {
    assert.equal(
      evaluateRule("prompt/delete-resource-group", workspace(source)),
      false,
    );
  }
});

test.skip("source-order mutation and mutually exclusive paths cannot pass", () => {
  const mutated = completeSource.replace(
    "parameters = ResourceGroup(location=location)",
    `resource_group_name = "changed"
        parameters = ResourceGroup(location=location)`,
  );
  assert.equal(
    evaluateRule("prompt/create-resource-group", workspace(mutated)),
    false,
  );

  const exclusive = completeSource.replace(
    `        created = client.resource_groups.create_or_update(
            resource_group_name,
            parameters,
        )
        print(f"Created: {created.name} in {created.location}")

        for resource_group in client.resource_groups.list():
            print(f"Resource group: {resource_group.name}")`,
    `        if external_flag:
            created = client.resource_groups.create_or_update(
                resource_group_name,
                parameters,
            )
            print(created.name)
        else:
            for resource_group in client.resource_groups.list():
                print(resource_group.name)`,
  );
  assert.equal(
    evaluateRule("prompt/list-resource-groups", workspace(exclusive)),
    false,
  );

  const unreachable = completeSource.replace(
    "        parameters = ResourceGroup(location=location)",
    `        if False:
            parameters = ResourceGroup(location=location)
            client.resource_groups.create_or_update(
                resource_group_name,
                parameters,
            )
        parameters = ResourceGroup(location=location)`,
  );
  assert.equal(
    evaluateRule("prompt/create-resource-group", workspace(unreachable)),
    true,
  );

  const mismatchedDecoy = completeSource.replace(
    "        parameters = ResourceGroup(location=location)",
    `        parameters = ResourceGroup(location=location)
        client.resource_groups.create_or_update("decoy", parameters)`,
  );
  assert.equal(
    evaluateRule("prompt/create-resource-group", workspace(mismatchedDecoy)),
    false,
  );
});

test.skip("sync management operations reject invalid await and legacy wait forms", () => {
  const awaitedCreate = completeSource.replace(
    "created = client.resource_groups.create_or_update(",
    "created = await client.resource_groups.create_or_update(",
  );
  assert.equal(
    evaluateRule("prompt/create-resource-group", workspace(awaitedCreate)),
    false,
  );

  const waitedDelete = completeSource.replace(
    "deletion.result()",
    "deletion.wait()",
  );
  assert.equal(
    evaluateRule("prompt/delete-resource-group", workspace(waitedDelete)),
    false,
  );
});

test.skip("HttpResponseError requires an exact bound diagnostic and preservation", () => {
  const failures = [
    withHttpHandler("        raise"),
    completeSource.replace(
      "except HttpResponseError as error:",
      "except HttpResponseError:",
    ),
    withHttpHandler('        print("resource group request failed")\n        raise'),
    withHttpHandler("        print(type(error))\n        raise"),
    withHttpHandler("        print(error.__class__)\n        raise"),
    withHttpHandler("        print(error)\n        pass"),
    withHttpHandler("        if should_log:\n            print(error)\n        raise"),
    completeSource.replace(
      "except HttpResponseError as error:",
      "except (HttpResponseError, ValueError) as error:",
    ),
    completeSource.replace(
      "    except HttpResponseError as error:",
      `    except Exception:
        raise
    except HttpResponseError as error:`,
    ),
  ];
  for (const source of failures) {
    assert.equal(
      evaluateRule("prompt/sdk-error-handling", workspace(source)),
      false,
    );
  }
});

test.skip("HttpResponseError diagnostics accept direct, logger, and helper forms", () => {
  const helperSource = withHttpHandler(
    "        report_http_error(error)\n        raise",
    completeSource.replace(
      "def run() -> None:",
      `def report_http_error(failure):
    print(failure.message, failure.response.status_code, file=sys.stderr)

def run() -> None:`,
    ),
  );
  const formattedHelper = withHttpHandler(
    "        logging.error(describe(error))\n        raise",
    completeSource
      .replace("import sys", "import sys\nimport logging")
      .replace(
        "def run() -> None:",
        `def describe(failure):
    return f"{failure.message}: {failure.status_code}"

def run() -> None:`,
      ),
  );
  const aliasedSink = withHttpHandler(
    "        emit(error.details, file=sys.stderr)\n        raise",
    completeSource.replace(
      "    try:",
      "    emit = print\n\n    try:",
    ),
  );
  const qualifiedException = withHttpHandler(
    "        print(error.message, error.status_code, file=sys.stderr)\n        raise",
    completeSource
      .replace(
        "from azure.core.exceptions import HttpResponseError",
        "from azure.core import exceptions as core_errors",
      )
      .replace(
        "except HttpResponseError as error:",
        "except core_errors.HttpResponseError as error:",
      ),
  );
  const cases = [
    withHttpHandler(
      "        print(error.response.status_code, error.message)\n        raise",
    ),
    withHttpHandler(
      "        sys.stderr.write(str(error))\n        raise error",
    ),
    withHttpHandler(
      `        print(error.details)
        raise RuntimeError("resource group request failed") from error`,
    ),
    withHttpHandler(
      "        print(error.message, file=sys.stderr)\n        return None",
    ),
    helperSource,
    formattedHelper,
    aliasedSink,
    qualifiedException,
  ];
  for (const source of cases) {
    assert.equal(
      evaluateRule("prompt/sdk-error-handling", workspace(source)),
      true,
    );
  }
});

test.skip("HttpResponseError diagnostics consume Python formatting fields", () => {
  const helperSource = withHttpHandler(
    "        report(error.status_code, error.message)\n        raise",
    completeSource
      .replace("import sys", "import sys\nimport logging")
      .replace(
        "def run() -> None:",
        `def report(status, message):
    logging.error(
        "HTTP %(status)s: %(message)s"
        % {"status": status, "message": message}
    )

def run() -> None:`,
      ),
  );
  const cases = [
    withHttpHandler(
      `        print(
            "HTTP {0.status_code}: {detail}".format(
                error.response, detail=error.message
            )
        )
        raise`,
    ),
    withHttpHandler(
      `        print(
            "HTTP %(status)s: %(message)s"
            % {"status": error.status_code, "message": error.message}
        )
        raise`,
    ),
    withHttpHandler(
      '        print(f"HTTP {{status}}: {error.message}")\n        raise',
    ),
    withHttpHandler(
      `        logging.error(
            "HTTP %s: %s", error.status_code, error.message
        )
        raise`,
      completeSource.replace("import sys", "import sys\nimport logging"),
    ),
    withHttpHandler(
      `        logging.error(
            "HTTP %(status)s: %(message)s",
            {"status": error.status_code, "message": error.message},
        )
        raise`,
      completeSource.replace("import sys", "import sys\nimport logging"),
    ),
    helperSource,
  ];
  for (const source of cases) {
    assert.equal(
      evaluateRule("prompt/sdk-error-handling", workspace(source)),
      true,
      source,
    );
  }
});

test.skip("HttpResponseError diagnostics reject unconsumed formatting values", () => {
  const cases = [
    '        print("HTTP {{0}}".format(error.message))\n        raise',
    '        print("HTTP {1}".format(error.message))\n        raise',
    `        print("HTTP {0}".format("fixed", error.message))
        raise`,
    `        print("HTTP %s" % ("fixed", error.message))
        raise`,
    '        print("HTTP %%s" % error.message)\n        raise',
    `        logging.error("HTTP %s", "fixed", error.message)
        raise`,
    `        logging.error("HTTP %%s", error.message)
        raise`,
    `        print("HTTP {message}".format(detail=error.message))
        raise`,
  ];
  for (const body of cases) {
    const source = withHttpHandler(
      body,
      completeSource.replace("import sys", "import sys\nimport logging"),
    );
    assert.equal(
      evaluateRule("prompt/sdk-error-handling", workspace(source)),
      false,
      body,
    );
  }
});

test.skip("unused helpers and swallowed unrelated handlers fail", () => {
  const unusedHelper = withHttpHandler(
    "        report_http_error(error)\n        raise",
    completeSource.replace(
      "def run() -> None:",
      `def report_http_error(failure):
    print("resource group request failed", file=sys.stderr)

def run() -> None:`,
    ),
  );
  assert.equal(
    evaluateRule("prompt/sdk-error-handling", workspace(unusedHelper)),
    false,
  );

  const swallowed = `${completeSource}
try:
    risky()
except ValueError:
    pass
`;
  assert.equal(
    evaluateRule("prompt/sdk-error-handling", workspace(swallowed)),
    false,
  );

  const conditionalSwallow = `${completeSource}
try:
    risky()
except ValueError as failure:
    if preserve:
        raise RuntimeError("unrelated failure") from failure
`;
  assert.equal(
    evaluateRule("prompt/sdk-error-handling", workspace(conditionalSwallow)),
    false,
  );

  const preserved = `${completeSource}
try:
    risky()
except ValueError as failure:
    raise RuntimeError("unrelated failure") from failure
`;
  assert.equal(
    evaluateRule("prompt/sdk-error-handling", workspace(preserved)),
    true,
  );

  const unreachableSwallow = `${completeSource}
try:
    risky()
except ValueError:
    raise
except ValueError:
    pass
`;
  assert.equal(
    evaluateRule("prompt/sdk-error-handling", workspace(unreachableSwallow)),
    true,
  );

  const definitionOnly = `${completeSource}
try:
    def decoy():
        risky()
except ValueError:
    pass
`;
  assert.equal(
    evaluateRule("prompt/sdk-error-handling", workspace(definitionOnly)),
    true,
  );
});
