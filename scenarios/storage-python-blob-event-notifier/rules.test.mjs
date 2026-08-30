import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  evaluatePythonCheck,
  loadPythonWorkspace,
} from "../../languages/python/checks.mjs";
import {
  evaluateRule,
  loadBlobEventNotifierWorkspace,
  ruleNames,
} from "./tools/blob-event-notifier-rules.mjs";

const goldenPath = fileURLToPath(new URL("./golden", import.meta.url));
const checkScript = fileURLToPath(
  new URL("./tools/check-blob-event-notifier-python.mjs", import.meta.url),
);
const analyzerScript = fileURLToPath(
  new URL("./tools/blob_event_notifier_analyzer.py", import.meta.url),
);
const goldenWorkspace = loadBlobEventNotifierWorkspace(goldenPath);
const languageWorkspace = loadPythonWorkspace(goldenPath);
const dependencies = goldenWorkspace.dependencies.replaceAll("\r\n", "\n");
const sourceRules = ruleNames().filter((name) => name !== "prompt/sdk-packages");
const languageChecks = [
  "language/correct-imports",
  "language/default-azure-credential",
  "language/client-lifecycle",
  "language/async-client",
  "language/exception-handling",
];
const documents = Object.fromEntries(
  goldenWorkspace.documents.map((document) => [
    document.path,
    document.source.replaceAll("\r\n", "\n"),
  ]),
);

function workspaceWithDocuments(updatedDocuments, manifest = dependencies) {
  return {
    dependencies: manifest,
    dependencyManifests: [{ content: manifest, filename: "requirements.txt" }],
    documents: updatedDocuments.map((document) => ({ ...document })),
  };
}

function replaceDocument(
  path,
  from,
  to,
  baseDocuments = goldenWorkspace.documents,
) {
  return workspaceWithDocuments(
    baseDocuments.map((document) =>
      document.path === path
        ? {
            ...document,
            source: document.source.replaceAll("\r\n", "\n").replace(from, to),
          }
        : { ...document, source: document.source.replaceAll("\r\n", "\n") },
    ),
  );
}

function secureGeneratorProbe(definition) {
  let workspace = replaceDocument(
    "main.py",
    "import asyncio\n",
    "import asyncio\nfrom azure.core.credentials import AzureKeyCredential as ForbiddenCredential\n",
  );
  workspace = replaceDocument(
    "main.py",
    "\ndef run_sync_demo(settings) -> None:\n",
    `\n${definition}\n\ndef run_sync_demo(settings) -> None:\n`,
    workspace.documents,
  );
  return replaceDocument(
    "main.py",
    "    run_sync_demo(settings)\n",
    "    asyncio.run(iteration_probe())\n    run_sync_demo(settings)\n",
    workspace.documents,
  );
}

test("pinned golden passes every prompt and shared Python rule", () => {
  assert.deepEqual(ruleNames(), [
    "prompt/sdk-packages",
    "prompt/sdk-event-deserialization",
    "prompt/event-routing",
    "prompt/blob-subject-and-summary",
    "prompt/race-condition-handling",
    "prompt/custom-event-publishing",
    "prompt/async-implementations",
    "prompt/secure-client-configuration",
    "prompt/ordered-demo-workflow",
  ]);
  assert.equal(
    dependencies,
    "azure-eventgrid==4.22.1\nazure-identity==1.25.3\nazure-storage-blob==12.30.1\n",
  );
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, goldenWorkspace), true, rule);
  }
  for (const check of languageChecks) {
    assert.equal(evaluatePythonCheck(check, languageWorkspace), true, check);
  }
});

test("runtime dependency manifests accept standard active forms", () => {
  const cases = [
    [
      "requirements-prod.txt",
      "azure_eventgrid>=4.22\nazure-identity~=1.25\nazure.storage.blob==12.30.1",
    ],
    [
      "pyproject.toml",
      `[project]
dependencies = [
  "azure-eventgrid>=4.22",
  "azure-identity>=1.25",
  "azure-storage-blob>=12.30",
]`,
    ],
    [
      "pyproject.toml",
      `[tool.poetry.dependencies]\npython = "^3.11"\nazure-eventgrid = "4.22.1"\nazure-identity = "1.25.3"\nazure-storage-blob = "12.30.1"`,
    ],
    [
      "setup.py",
      `from setuptools import setup

runtime_dependencies = [
    "azure-eventgrid",
    "azure-identity",
] + ["azure-storage-blob"]

setup(install_requires=runtime_dependencies)`,
    ],
    [
      "requirements.txt",
      `azure-eventgrid>=4.22; python_version >= "3.10"
azure-identity @ https://example.invalid/azure-identity.whl
azure-storage-blob!=12.29.*,>=12.30`,
    ],
    [
      "pyproject.toml",
      `[tool.poetry.dependencies]
python = "^3.11"
azure-eventgrid = { version = "^4.22", markers = "python_version >= '3.10'" }
azure-identity = ">=1.25,<2"
azure-storage-blob = "*"` ,
    ],
  ];
  for (const [filename, manifest] of cases) {
    const workspace = {
      dependencies: manifest,
      dependencyManifests: [{ content: manifest, filename }],
      documents: [{ path: "main.py", source: "print('application')\n" }],
    };
    assert.equal(evaluateRule("prompt/sdk-packages", workspace), true, filename);
  }
});

test("comments and unrelated manifest strings cannot declare SDK packages", () => {
  const cases = [
    [
      "requirements.txt",
      `# azure-eventgrid
# azure-identity
# azure-storage-blob
application-package`,
    ],
    [
      "pyproject.toml",
      `[project]
name = "sample"
description = "Mentions azure-eventgrid, azure-identity, and azure-storage-blob."
# dependencies = ["azure-eventgrid", "azure-identity", "azure-storage-blob"]

[tool.sample]
message = "azure-eventgrid azure-identity azure-storage-blob"`,
    ],
    [
      "setup.py",
      `from setuptools import setup

description = "azure-eventgrid azure-identity azure-storage-blob"
# setup(install_requires=["azure-eventgrid", "azure-identity", "azure-storage-blob"])
setup(name="sample", description=description)`,
    ],
  ];
  for (const [filename, manifest] of cases) {
    const workspace = {
      dependencies: manifest,
      dependencyManifests: [{ content: manifest, filename }],
      documents: [{ path: "main.py", source: "print('application')\n" }],
    };
    assert.equal(evaluateRule("prompt/sdk-packages", workspace), false, filename);
  }
});

test("development-only, prose, and partial manifests fail", () => {
  const cases = [
    ["requirements.txt", "Install azure-eventgrid, azure-identity, and azure-storage-blob."],
    [
      "requirements-dev.txt",
      "azure-eventgrid\nazure-identity\nazure-storage-blob\n",
    ],
    [
      "pyproject.toml",
      `[project.optional-dependencies]\ndev = ["azure-eventgrid", "azure-identity", "azure-storage-blob"]`,
    ],
    ["requirements.txt", "azure-eventgrid==4.22.1\nazure-identity==1.25.3\n"],
  ];
  for (const [filename, manifest] of cases) {
    const workspace = {
      dependencies: manifest,
      dependencyManifests: [{ content: manifest, filename }],
      documents: [{ path: "main.py", source: "print('application')\n" }],
    };
    assert.equal(evaluateRule("prompt/sdk-packages", workspace), false, filename);
  }
});

test("prose and malformed PEP 508-like declarations never count", () => {
  const cases = [
    [
      "requirements.txt",
      `azure-eventgrid is needed
azure-identity==1.25.3
azure-storage-blob==12.30.1`,
    ],
    [
      "requirements.txt",
      `azure-eventgrid>=4.22 is needed
azure-identity==1.25.3
azure-storage-blob==12.30.1`,
    ],
    [
      "pyproject.toml",
      `[project]
dependencies = [
  "azure-eventgrid; this is prose",
  "azure-identity==1.25.3",
  "azure-storage-blob==12.30.1",
]`,
    ],
    [
      "pyproject.toml",
      `[tool.poetry.dependencies]
azure-eventgrid = "is needed"
azure-identity = "1.25.3"
azure-storage-blob = "12.30.1"`,
    ],
    [
      "setup.py",
      `from setuptools import setup
setup(install_requires=[
    "azure-eventgrid is needed",
    "azure-identity==1.25.3",
    "azure-storage-blob==12.30.1",
])`,
    ],
  ];
  for (const [filename, manifest] of cases) {
    const workspace = {
      dependencies: manifest,
      dependencyManifests: [{ content: manifest, filename }],
      documents: [{ path: "main.py", source: "print('application')\n" }],
    };
    assert.equal(evaluateRule("prompt/sdk-packages", workspace), false, filename);
  }
});

test("workspace discovery ignores tests, generated files, and staged skills", () => {
  const root = fileURLToPath(new URL("./.workspace-fixture", import.meta.url));
  rmSync(root, { recursive: true, force: true });
  try {
    mkdirSync(join(root, "tests"), { recursive: true });
    mkdirSync(join(root, "generated"), { recursive: true });
    mkdirSync(join(root, ".vally"), { recursive: true });
    writeFileSync(join(root, "requirements.txt"), dependencies);
    for (const [path, source] of Object.entries(documents)) {
      writeFileSync(join(root, path), source);
    }
    writeFileSync(join(root, "tests", "test_decoy.py"), documents["main.py"]);
    writeFileSync(join(root, "generated", "decoy.py"), documents["main.py"]);
    writeFileSync(join(root, ".vally", "skill.py"), documents["main.py"]);

    const discovered = loadBlobEventNotifierWorkspace(root);
    assert.equal(discovered.topLevelPythonFiles.length, 5);
    assert.equal(discovered.documents.length, 5);
    for (const rule of ruleNames()) {
      assert.equal(evaluateRule(rule, discovered), true, rule);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workspace discovery grades only root applications and connected packages", () => {
  const decoyRoot = fileURLToPath(
    new URL("./.application-decoy-workspace", import.meta.url),
  );
  const packageRoot = fileURLToPath(
    new URL("./.connected-package-workspace", import.meta.url),
  );
  rmSync(decoyRoot, { recursive: true, force: true });
  rmSync(packageRoot, { recursive: true, force: true });
  try {
    mkdirSync(decoyRoot, { recursive: true });
    writeFileSync(join(decoyRoot, "requirements.txt"), dependencies, {
      flag: "wx",
    });
    writeFileSync(join(decoyRoot, "main.py"), "print('application')\n");
    for (const directory of ["docs", "examples", "skills", "vendor", "samples"]) {
      mkdirSync(join(decoyRoot, directory), { recursive: true });
      for (const [path, source] of Object.entries(documents)) {
        writeFileSync(join(decoyRoot, directory, path), source);
      }
    }

    const decoys = loadBlobEventNotifierWorkspace(decoyRoot);
    assert.deepEqual(
      decoys.documents.map(({ path }) => path),
      ["main.py"],
    );
    for (const rule of sourceRules) {
      assert.equal(evaluateRule(rule, decoys), false, rule);
    }

    const packageDirectory = join(packageRoot, "notifier");
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(join(packageRoot, "requirements.txt"), dependencies);
    writeFileSync(
      join(packageRoot, "main.py"),
      `from notifier.main import main

if __name__ == "__main__":
    main()
`,
    );
    writeFileSync(join(packageDirectory, "__init__.py"), "");
    for (const [path, original] of Object.entries(documents)) {
      const source = original
        .replace("from config import (", "from .config import (")
        .replace("from event_publisher import (", "from .event_publisher import (")
        .replace("from event_receiver import (", "from .event_receiver import (")
        .replace("from blob_event_handler import (", "from .blob_event_handler import (");
      writeFileSync(join(packageDirectory, path), source);
    }
    mkdirSync(join(packageRoot, "examples"), { recursive: true });
    writeFileSync(
      join(packageRoot, "examples", "complete_decoy.py"),
      documents["main.py"],
    );

    const packaged = loadBlobEventNotifierWorkspace(packageRoot);
    assert.deepEqual(
      packaged.documents.map(({ path }) => path),
      [
        "main.py",
        "notifier/__init__.py",
        "notifier/blob_event_handler.py",
        "notifier/config.py",
        "notifier/event_publisher.py",
        "notifier/event_receiver.py",
        "notifier/main.py",
      ],
    );
    for (const rule of ruleNames()) {
      assert.equal(evaluateRule(rule, packaged), true, rule);
    }

    writeFileSync(
      join(packageRoot, "main.py"),
      "from notifier.main import main\n",
    );
    const importedOnly = loadBlobEventNotifierWorkspace(packageRoot);
    for (const rule of sourceRules) {
      assert.equal(evaluateRule(rule, importedOnly), false, rule);
    }
  } finally {
    rmSync(decoyRoot, { recursive: true, force: true });
    rmSync(packageRoot, { recursive: true, force: true });
  }
});

test("workspace discovery follows only executable Python AST imports", () => {
  const root = fileURLToPath(
    new URL("./.ast-import-discovery-workspace", import.meta.url),
  );
  rmSync(root, { recursive: true, force: true });
  try {
    mkdirSync(join(root, "reachable"), { recursive: true });
    mkdirSync(join(root, "decoy"), { recursive: true });
    writeFileSync(
      join(root, "main.py"),
      `"""from decoy.complete import run"""
IMPORT_EXAMPLE = "import decoy.complete"
# from decoy.complete import run
if False:
    from decoy.complete import run
if []:
    import decoy.complete
if ():
    import decoy.complete
if {}:
    import decoy.complete
if set():
    import decoy.complete
if "":
    import decoy.complete
if b"":
    import decoy.complete
if not [1]:
    import decoy.complete
if [] or ():
    import decoy.complete
if [1] and []:
    import decoy.complete

if [1] and (1,) and {"enabled": True} and {1} and "yes" and b"yes":
    from reachable.literal_true import run as run_literal
    run_literal()

MATCH_MODE = "enabled"
match MATCH_MODE:
    case "disabled":
        import decoy.complete
    case "enabled":
        from reachable.match_case import run as run_match
        run_match()

def unused():
    import decoy.complete

def start():
    from reachable.entry import run
    run()

if __name__ == "__main__":
    start()
`,
    );
    writeFileSync(join(root, "reachable", "__init__.py"), "");
    writeFileSync(
      join(root, "reachable", "entry.py"),
      `def run():
    from . import helper
    helper.work()
`,
    );
    writeFileSync(
      join(root, "reachable", "helper.py"),
      "def work():\n    return None\n",
    );
    writeFileSync(
      join(root, "reachable", "literal_true.py"),
      "def run():\n    return None\n",
    );
    writeFileSync(
      join(root, "reachable", "match_case.py"),
      "def run():\n    return None\n",
    );
    writeFileSync(join(root, "decoy", "__init__.py"), "");
    writeFileSync(
      join(root, "decoy", "complete.py"),
      "def run():\n    return None\n",
    );

    const discovered = loadBlobEventNotifierWorkspace(root);
    assert.deepEqual(
      discovered.documents.map(({ path }) => path),
      [
        "main.py",
        "reachable/__init__.py",
        "reachable/entry.py",
        "reachable/helper.py",
        "reachable/literal_true.py",
        "reachable/match_case.py",
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workspace discovery models empty, nonempty, and unknown loop paths", () => {
  const root = fileURLToPath(
    new URL("./.loop-import-discovery-workspace", import.meta.url),
  );
  rmSync(root, { recursive: true, force: true });
  try {
    mkdirSync(join(root, "reachable"), { recursive: true });
    mkdirSync(join(root, "decoy"), { recursive: true });
    writeFileSync(
      join(root, "main.py"),
      `import asyncio

def run(values):
    for _ in ():
        import decoy.empty_tuple
    else:
        import reachable.empty_else
    for _ in []:
        import decoy.empty_list
    for _ in {}:
        import decoy.empty_dict
    for _ in set():
        import decoy.empty_set
    for _ in range(0):
        import decoy.empty_range
    for _ in [1]:
        import reachable.nonempty_body
        break
    else:
        import decoy.nonempty_else
    for _ in values:
        import reachable.unknown_body
    else:
        import reachable.unknown_else

async def async_items():
    yield 1

async def partially_failing_items():
    yield 1
    raise RuntimeError("iteration failed")

async def try_finally_failing_items():
    try:
        raise RuntimeError("iteration failed")
    except ValueError:
        return
    finally:
        if False:
            yield 1

async def yielded_then_failed_items():
    try:
        yield 1
    finally:
        raise RuntimeError("iteration failed")

async def caught_items():
    try:
        raise RuntimeError("iteration failed")
    except RuntimeError:
        return
    if False:
        yield 1

async def endless_items():
    while True:
        yield 1

async def empty_items():
    if False:
        yield 1

async def break_items():
    yield 1
    import decoy.break_generator_post_yield

async def never_awaited():
    import decoy.unawaited

async def run_normal_exhaustion():
    async for _ in empty_items():
        import decoy.empty_generator_body
    else:
        import reachable.empty_generator_else
    import reachable.empty_generator_after

async def run_exceptional_iteration():
    async for _ in partially_failing_items():
        import reachable.exceptional_generator_body
    else:
        import decoy.exceptional_generator_else
    import decoy.exceptional_generator_after

async def run_try_finally_iteration():
    async for _ in try_finally_failing_items():
        import decoy.try_finally_generator_body
    else:
        import decoy.try_finally_generator_else
    import decoy.try_finally_generator_after

async def run_yielded_then_failed_iteration():
    async for _ in yielded_then_failed_items():
        import reachable.yielded_then_failed_body
    else:
        import decoy.yielded_then_failed_else
    import decoy.yielded_then_failed_after

async def run_caught_iteration():
    async for _ in caught_items():
        import decoy.caught_generator_body
    else:
        import reachable.caught_generator_else
    import reachable.caught_generator_after

async def run_endless_iteration():
    async for _ in endless_items():
        import reachable.endless_generator_body
    else:
        import decoy.endless_generator_else
    import decoy.endless_generator_after

async def run_break_iteration():
    async for _ in break_items():
        import reachable.break_generator_body
        break
    else:
        import decoy.break_generator_else
    import reachable.break_generator_after

async def run_async():
    async for _ in async_items():
        import reachable.async_body
    else:
        import reachable.async_else
    async for _ in ():
        import decoy.empty_async
    else:
        import decoy.invalid_async_else
    import decoy.invalid_async_after

run(object())
never_awaited()
asyncio.run(run_normal_exhaustion())
asyncio.run(run_exceptional_iteration())
asyncio.run(run_try_finally_iteration())
asyncio.run(run_yielded_then_failed_iteration())
asyncio.run(run_caught_iteration())
asyncio.run(run_endless_iteration())
asyncio.run(run_break_iteration())
asyncio.run(run_async())
`,
    );
    for (const name of [
      "empty_else",
      "empty_generator_after",
      "empty_generator_else",
      "exceptional_generator_body",
      "caught_generator_after",
      "caught_generator_else",
      "endless_generator_body",
      "nonempty_body",
      "unknown_body",
      "unknown_else",
      "async_body",
      "async_else",
      "break_generator_after",
      "break_generator_body",
      "yielded_then_failed_body",
    ]) {
      writeFileSync(join(root, "reachable", `${name}.py`), "");
    }
    for (const name of [
      "empty_tuple",
      "empty_list",
      "empty_dict",
      "empty_set",
      "empty_range",
      "empty_async",
      "break_generator_else",
      "break_generator_post_yield",
      "empty_generator_body",
      "exceptional_generator_after",
      "exceptional_generator_else",
      "invalid_async_after",
      "invalid_async_else",
      "nonempty_else",
      "caught_generator_body",
      "endless_generator_after",
      "endless_generator_else",
      "try_finally_generator_after",
      "try_finally_generator_body",
      "try_finally_generator_else",
      "unawaited",
      "yielded_then_failed_after",
      "yielded_then_failed_else",
    ]) {
      writeFileSync(join(root, "decoy", `${name}.py`), "");
    }
    writeFileSync(join(root, "reachable", "__init__.py"), "");
    writeFileSync(join(root, "decoy", "__init__.py"), "");

    assert.deepEqual(
      loadBlobEventNotifierWorkspace(root).documents.map(({ path }) => path),
      [
        "main.py",
        "reachable/__init__.py",
        "reachable/async_body.py",
        "reachable/async_else.py",
        "reachable/break_generator_after.py",
        "reachable/break_generator_body.py",
        "reachable/caught_generator_after.py",
        "reachable/caught_generator_else.py",
        "reachable/empty_else.py",
        "reachable/empty_generator_after.py",
        "reachable/empty_generator_else.py",
        "reachable/endless_generator_body.py",
        "reachable/exceptional_generator_body.py",
        "reachable/nonempty_body.py",
        "reachable/unknown_body.py",
        "reachable/unknown_else.py",
        "reachable/yielded_then_failed_body.py",
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("coroutine bodies run only through recognized await and scheduling paths", () => {
  const addProbe = (definition, invocation) => {
    let workspace = replaceDocument(
      "main.py",
      "import asyncio\n",
      "import asyncio\nfrom azure.core.credentials import AzureKeyCredential as ForbiddenCredential\n",
    );
    workspace = replaceDocument(
      "main.py",
      "\ndef run_sync_demo(settings) -> None:\n",
      `\n${definition}\n\ndef run_sync_demo(settings) -> None:\n`,
      workspace.documents,
    );
    return replaceDocument(
      "main.py",
      "    run_sync_demo(settings)\n",
      `    ${invocation}\n    run_sync_demo(settings)\n`,
      workspace.documents,
    );
  };

  const unawaited = addProbe(
    `async def credential_probe() -> None:
    ForbiddenCredential("secret")
`,
    "credential_probe()",
  );
  assert.equal(
    evaluateRule("prompt/secure-client-configuration", unawaited),
    true,
  );

  for (const [definition, invocation] of [
    [
      `async def credential_probe() -> None:
    ForbiddenCredential("secret")
`,
      "asyncio.run(credential_probe())",
    ],
    [
      `async def credential_probe() -> None:
    ForbiddenCredential("secret")

async def await_probe() -> None:
    await credential_probe()
`,
      "asyncio.run(await_probe())",
    ],
    [
      `async def credential_probe() -> None:
    ForbiddenCredential("secret")

async def schedule_probe() -> None:
    task = asyncio.create_task(credential_probe())
    await task
`,
      "asyncio.run(schedule_probe())",
    ],
    [
      `async def credential_probe() -> None:
    ForbiddenCredential("secret")

async def schedule_probe() -> None:
    async with asyncio.TaskGroup() as group:
        group.create_task(credential_probe())
`,
      "asyncio.run(schedule_probe())",
    ],
  ]) {
    assert.equal(
      evaluateRule(
        "prompt/secure-client-configuration",
        addProbe(definition, invocation),
      ),
      false,
      invocation,
    );
  }

  const unawaitedDemo = replaceDocument(
    "main.py",
    "    asyncio.run(run_async_demo(settings))",
    "    run_async_demo(settings)",
  );
  assert.equal(
    evaluateRule("prompt/async-implementations", unawaitedDemo),
    false,
  );
  assert.equal(
    evaluateRule("prompt/ordered-demo-workflow", unawaitedDemo),
    false,
  );

  for (const definition of [
    `def credential_decorator_factory():
    def decorate(function):
        ForbiddenCredential("definition-time decorator")
        return function
    return decorate

@credential_decorator_factory()
def deferred_probe() -> None:
    pass
`,
    `def credential_decorator_factory():
    def decorate(definition):
        ForbiddenCredential("definition-time class decorator")
        return definition
    return decorate

@credential_decorator_factory()
class DeferredProbe:
    pass
`,
  ]) {
    assert.equal(
      evaluateRule(
        "prompt/secure-client-configuration",
        addProbe(definition, "pass"),
      ),
      false,
      definition,
    );
  }

  const decoratedBody = addProbe(
    `def quiet_decorator_factory():
    def decorate(function):
        return function
    return decorate

@quiet_decorator_factory()
def deferred_probe() -> None:
    ForbiddenCredential("decorated body remains deferred")
`,
    "pass",
  );
  assert.equal(
    evaluateRule("prompt/secure-client-configuration", decoratedBody),
    true,
  );
});

test("async for executes only proven async iterables", () => {
  const addProbe = (definition) => {
    let workspace = replaceDocument(
      "main.py",
      "import asyncio\n",
      "import asyncio\nfrom azure.core.credentials import AzureKeyCredential as ForbiddenCredential\n",
    );
    workspace = replaceDocument(
      "main.py",
      "\ndef run_sync_demo(settings) -> None:\n",
      `\n${definition}\n\ndef run_sync_demo(settings) -> None:\n`,
      workspace.documents,
    );
    return replaceDocument(
      "main.py",
      "    run_sync_demo(settings)\n",
      "    asyncio.run(iteration_probe())\n    run_sync_demo(settings)\n",
      workspace.documents,
    );
  };

  const invalid = addProbe(`async def iteration_probe() -> None:
    async for _ in [1]:
        ForbiddenCredential("body")
    else:
        ForbiddenCredential("else")
`);
  assert.equal(
    evaluateRule("prompt/secure-client-configuration", invalid),
    true,
  );

  const invalidFollowing = addProbe(`async def iteration_probe() -> None:
    async for _ in [1]:
        pass
    ForbiddenCredential("unreachable after invalid async iteration")
`);
  assert.equal(
    evaluateRule("prompt/secure-client-configuration", invalidFollowing),
    true,
  );

  const exceptional = addProbe(`async def failing_items():
    raise RuntimeError("iteration failed")
    yield 1

async def iteration_probe() -> None:
    async for _ in failing_items():
        pass
    else:
        ForbiddenCredential("unreachable exceptional else")
    ForbiddenCredential("unreachable exceptional continuation")
`);
  assert.equal(
    evaluateRule("prompt/secure-client-configuration", exceptional),
    true,
  );

  const partiallyExceptional = addProbe(`async def failing_items():
    yield 1
    raise RuntimeError("iteration failed")

async def iteration_probe() -> None:
    async for _ in failing_items():
        pass
    else:
        ForbiddenCredential("unreachable exceptional else")
    ForbiddenCredential("unreachable exceptional continuation")
`);
  assert.equal(
    evaluateRule("prompt/secure-client-configuration", partiallyExceptional),
    true,
  );

  const tryFinallyExceptional = addProbe(`async def failing_items():
    try:
        raise RuntimeError("iteration failed")
    except ValueError:
        return
    finally:
        if False:
            yield 1

async def iteration_probe() -> None:
    async for _ in failing_items():
        pass
    else:
        ForbiddenCredential("unreachable mismatched-handler else")
    ForbiddenCredential("unreachable mismatched-handler continuation")
`);
  assert.equal(
    evaluateRule("prompt/secure-client-configuration", tryFinallyExceptional),
    true,
  );

  const yieldedThenFailed = addProbe(`async def failing_items():
    try:
        yield 1
    finally:
        raise RuntimeError("iteration failed")

async def iteration_probe() -> None:
    async for _ in failing_items():
        pass
    else:
        ForbiddenCredential("unreachable finally-raise else")
    ForbiddenCredential("unreachable finally-raise continuation")
`);
  assert.equal(
    evaluateRule("prompt/secure-client-configuration", yieldedThenFailed),
    true,
  );

  const caughtAndExhausted = addProbe(`async def caught_items():
    try:
        raise RuntimeError("iteration failed")
    except RuntimeError:
        return
    if False:
        yield 1

async def iteration_probe() -> None:
    async for _ in caught_items():
        pass
    else:
        ForbiddenCredential("caught exception exhausts normally")
`);
  assert.equal(
    evaluateRule("prompt/secure-client-configuration", caughtAndExhausted),
    false,
  );

  const endless = addProbe(`async def endless_items():
    while True:
        yield 1

async def iteration_probe() -> None:
    async for _ in endless_items():
        pass
    else:
        ForbiddenCredential("unreachable endless-generator else")
    ForbiddenCredential("unreachable endless-generator continuation")
`);
  assert.equal(
    evaluateRule("prompt/secure-client-configuration", endless),
    true,
  );

  const exhausted = addProbe(`async def empty_items():
    if False:
        yield 1

async def iteration_probe() -> None:
    async for _ in empty_items():
        pass
    else:
        ForbiddenCredential("successful exhaustion else")
`);
  assert.equal(
    evaluateRule("prompt/secure-client-configuration", exhausted),
    false,
  );

  const valid = addProbe(`async def async_items():
    yield 1

async def iteration_probe() -> None:
    async for _ in async_items():
        ForbiddenCredential("body")
`);
  assert.equal(
    evaluateRule("prompt/secure-client-configuration", valid),
    false,
  );

  const broken = addProbe(`async def async_items():
    yield 1
    ForbiddenCredential("post-yield")

async def iteration_probe() -> None:
    async for _ in async_items():
        break
`);
  assert.equal(
    evaluateRule("prompt/secure-client-configuration", broken),
    true,
  );

  for (const body of ["continue", "pass"]) {
    const resumed = addProbe(`async def async_items():
    yield 1
    ForbiddenCredential("resumed post-yield")

async def iteration_probe() -> None:
    async for _ in async_items():
        ${body}
`);
    assert.equal(
      evaluateRule("prompt/secure-client-configuration", resumed),
      false,
      body,
    );
  }

  const consumerRaises = addProbe(`async def async_items():
    yield 1
    ForbiddenCredential("post-yield after consumer failure")

async def iteration_probe() -> None:
    async for _ in async_items():
        raise RuntimeError("consumer failed")
`);
  assert.equal(
    evaluateRule("prompt/secure-client-configuration", consumerRaises),
    true,
  );

  const conditionalBreak = addProbe(`async def async_items(selector):
    yield 1
    if selector:
        ForbiddenCredential("conditional post-yield")

async def iteration_probe() -> None:
    async for _ in async_items(object()):
        break
`);
  assert.equal(
    evaluateRule("prompt/secure-client-configuration", conditionalBreak),
    true,
  );

  for (const [body, expected] of [
    ["break", true],
    ["continue", false],
  ]) {
    const globalMutation = addProbe(`from azure.identity import DefaultAzureCredential

SelectedCredential = DefaultAzureCredential

def use_selected_credential() -> None:
    SelectedCredential("secret")

async def async_items():
    global SelectedCredential
    yield 1
    SelectedCredential = ForbiddenCredential

async def iteration_probe() -> None:
    async for _ in async_items():
        ${body}
    use_selected_credential()
`);
    assert.equal(
      evaluateRule(
        "prompt/secure-client-configuration",
        globalMutation,
      ),
      expected,
      `global mutation after ${body}`,
    );
  }

  for (const [initial, replacement, expected, label] of [
    [
      "DefaultAzureCredential",
      "ForbiddenCredential",
      false,
      "consumer global mutation is visible after resumption",
    ],
    [
      "ForbiddenCredential",
      "DefaultAzureCredential",
      true,
      "consumer global repair is visible after resumption",
    ],
  ]) {
    const resumedGlobal = addProbe(`from azure.identity import DefaultAzureCredential

SelectedCredential = ${initial}

async def async_items():
    global SelectedCredential
    yield 1
    SelectedCredential("secret")

async def iteration_probe() -> None:
    global SelectedCredential
    async for _ in async_items():
        SelectedCredential = ${replacement}
        continue
`);
    assert.equal(
      evaluateRule("prompt/secure-client-configuration", resumedGlobal),
      expected,
      label,
    );
  }

  for (const [initial, replacement, expected, label] of [
    [
      "DefaultAzureCredential",
      "ForbiddenCredential",
      false,
      "consumer nonlocal mutation is visible after resumption",
    ],
    [
      "ForbiddenCredential",
      "DefaultAzureCredential",
      true,
      "consumer nonlocal repair is visible after resumption",
    ],
  ]) {
    const resumedNonlocal = addProbe(`from azure.identity import DefaultAzureCredential

async def iteration_probe() -> None:
    SelectedCredential = ${initial}

    async def async_items():
        nonlocal SelectedCredential
        yield 1
        SelectedCredential("secret")

    async for _ in async_items():
        SelectedCredential = ${replacement}
        continue
`);
    assert.equal(
      evaluateRule("prompt/secure-client-configuration", resumedNonlocal),
      expected,
      label,
    );
  }

  for (const [initial, replacement, expected, label] of [
    [
      "False",
      "True",
      false,
      "resumed generator conditions observe a forbidden global mutation",
    ],
    [
      "True",
      "False",
      true,
      "resumed generator conditions observe a safe global mutation",
    ],
  ]) {
    const resumedCondition = addProbe(`UseForbidden = ${initial}

async def async_items():
    global UseForbidden
    yield 1
    if UseForbidden:
        ForbiddenCredential("conditional resumed call")

async def iteration_probe() -> None:
    global UseForbidden
    async for _ in async_items():
        UseForbidden = ${replacement}
        continue
`);
    assert.equal(
      evaluateRule("prompt/secure-client-configuration", resumedCondition),
      expected,
      label,
    );
  }
});

test("async generator continuations retain consumer external state per path", () => {
  const addProbe = (definition) => {
    let workspace = replaceDocument(
      "main.py",
      "import asyncio\n",
      "import asyncio\nfrom azure.core.credentials import AzureKeyCredential as ForbiddenCredential\n",
    );
    workspace = replaceDocument(
      "main.py",
      "\ndef run_sync_demo(settings) -> None:\n",
      `\n${definition}\n\ndef run_sync_demo(settings) -> None:\n`,
      workspace.documents,
    );
    return replaceDocument(
      "main.py",
      "    run_sync_demo(settings)\n",
      "    asyncio.run(iteration_probe())\n    run_sync_demo(settings)\n",
      workspace.documents,
    );
  };

  for (const [forbiddenBranch, defaultBranch] of [
    ["if", "else"],
    ["else", "if"],
  ]) {
    const branches = {
      if: forbiddenBranch === "if"
        ? "SelectedCredential = ForbiddenCredential"
        : "SelectedCredential = DefaultAzureCredential",
      else: defaultBranch === "else"
        ? "SelectedCredential = DefaultAzureCredential"
        : "SelectedCredential = ForbiddenCredential",
    };
    const workspace = addProbe(`from azure.identity import DefaultAzureCredential

SelectedCredential = DefaultAzureCredential

async def conditional_items():
    global SelectedCredential
    yield 1
    SelectedCredential("path-specific global credential")

async def iteration_probe() -> None:
    global SelectedCredential
    async for _ in conditional_items():
        if object():
            ${branches.if}
            continue
        else:
            ${branches.else}
            continue
`);
    assert.equal(
      evaluateRule("prompt/secure-client-configuration", workspace),
      false,
      `forbidden ${forbiddenBranch} branch resumes`,
    );
  }

  const nonlocal = addProbe(`from azure.identity import DefaultAzureCredential

async def iteration_probe() -> None:
    SelectedCredential = DefaultAzureCredential

    async def conditional_items():
        nonlocal SelectedCredential
        yield 1
        SelectedCredential("path-specific nonlocal credential")

    async for _ in conditional_items():
        if object():
            SelectedCredential = ForbiddenCredential
            continue
        else:
            SelectedCredential = DefaultAzureCredential
            continue
`);
  assert.equal(
    evaluateRule("prompt/secure-client-configuration", nonlocal),
    false,
  );

  const moduleState = `from azure.identity import DefaultAzureCredential
from azure.core.credentials import AzureKeyCredential as ForbiddenCredential

SelectedCredential = DefaultAzureCredential

def choose_forbidden() -> None:
    global SelectedCredential
    SelectedCredential = ForbiddenCredential

def choose_default() -> None:
    global SelectedCredential
    SelectedCredential = DefaultAzureCredential

async def conditional_items():
    global SelectedCredential
    yield 1
    SelectedCredential("path-specific module credential")
`;
  const moduleProbe = (forbiddenControl) => {
    let workspace = replaceDocument(
      "main.py",
      "import asyncio\n",
      "import asyncio\nfrom continuation_state import choose_default, choose_forbidden, conditional_items\n",
    );
    workspace = replaceDocument(
      "main.py",
      "\ndef run_sync_demo(settings) -> None:\n",
      `
async def iteration_probe() -> None:
    async for _ in conditional_items():
        if object():
            choose_forbidden()
            ${forbiddenControl}
        else:
            choose_default()
            continue


def run_sync_demo(settings) -> None:
`,
      workspace.documents,
    );
    workspace = replaceDocument(
      "main.py",
      "    run_sync_demo(settings)\n",
      "    asyncio.run(iteration_probe())\n    run_sync_demo(settings)\n",
      workspace.documents,
    );
    return workspaceWithDocuments([
      ...workspace.documents,
      { path: "continuation_state.py", source: moduleState },
    ]);
  };

  assert.equal(
    evaluateRule(
      "prompt/secure-client-configuration",
      moduleProbe("continue"),
    ),
    false,
    "both module-binding branches resume",
  );
  assert.equal(
    evaluateRule(
      "prompt/secure-client-configuration",
      moduleProbe("break"),
    ),
    true,
    "a forbidden module-binding break does not resume",
  );
});

test("async generator compound callees observe consumer rebinding", () => {
  const addProbe = (definition) => {
    let workspace = replaceDocument(
      "main.py",
      "import asyncio\n",
      "import asyncio\nfrom azure.core.credentials import AzureKeyCredential as ForbiddenCredential\n",
    );
    workspace = replaceDocument(
      "main.py",
      "\ndef run_sync_demo(settings) -> None:\n",
      `\n${definition}\n\ndef run_sync_demo(settings) -> None:\n`,
      workspace.documents,
    );
    return replaceDocument(
      "main.py",
      "    run_sync_demo(settings)\n",
      "    asyncio.run(iteration_probe())\n    run_sync_demo(settings)\n",
      workspace.documents,
    );
  };

  const forms = [
    {
      label: "list subscript",
      setup: (credential) => `Selected = [${credential}]`,
      rebind: (credential) => `Selected = [${credential}]`,
      globals: "global Selected",
      callee: "Selected[0]",
    },
    {
      label: "dict subscript",
      setup: (credential) => `Selected = {"credential": ${credential}}`,
      rebind: (credential) =>
        `Selected = {"credential": ${credential}}`,
      globals: "global Selected",
      callee: 'Selected["credential"]',
    },
    {
      label: "object attribute",
      setup: (credential) => `class Holder:
    pass

Selected = Holder()
Selected.credential = ${credential}`,
      rebind: (credential) => `Selected = Holder()
        Selected.credential = ${credential}`,
      globals: "global Selected",
      callee: "Selected.credential",
    },
    {
      label: "called object attribute",
      setup: (credential) => `class Holder:
    pass

Selected = Holder()
Selected.credential = ${credential}

def selected_holder():
    return Selected`,
      rebind: (credential) => `Selected = Holder()
        Selected.credential = ${credential}`,
      globals: "global Selected",
      callee: "selected_holder().credential",
    },
    {
      label: "conditional expression",
      setup: (credential) =>
        `UseForbidden = ${credential === "ForbiddenCredential" ? "True" : "False"}`,
      rebind: (credential) =>
        `UseForbidden = ${credential === "ForbiddenCredential" ? "True" : "False"}`,
      globals: "global UseForbidden",
      callee:
        "(ForbiddenCredential if UseForbidden else DefaultAzureCredential)",
    },
    {
      label: "called factory",
      setup: (credential) => `SelectedCredential = ${credential}

def selected_factory():
    return SelectedCredential`,
      rebind: (credential) => `SelectedCredential = ${credential}`,
      globals: "global SelectedCredential",
      callee: "selected_factory()",
    },
    {
      label: "composite boolean and subscript",
      setup: (credential) => `Selected = [${credential}]`,
      rebind: (credential) => `Selected = [${credential}]`,
      globals: "global Selected",
      callee: "(Selected and Selected[0])",
    },
  ];

  for (const form of forms) {
    for (const [initial, replacement, expected, direction] of [
      [
        "DefaultAzureCredential",
        "ForbiddenCredential",
        false,
        "unsafe consumer rebind",
      ],
      [
        "ForbiddenCredential",
        "DefaultAzureCredential",
        true,
        "safe consumer repair",
      ],
    ]) {
      const probe = addProbe(`from azure.identity import DefaultAzureCredential

${form.setup(initial)}

async def async_items():
    yield 1
    ${form.callee}("secret")

async def iteration_probe() -> None:
    ${form.globals}
    async for _ in async_items():
        ${form.rebind(replacement)}
        continue
`);
      assert.equal(
        evaluateRule("prompt/secure-client-configuration", probe),
        expected,
        `${form.label}: ${direction}`,
      );
    }
  }

  const localCapture = (credential) =>
    addProbe(`from azure.identity import DefaultAzureCredential

async def async_items():
    selected = [${credential}]
    yield 1
    selected[0]("secret")

async def iteration_probe() -> None:
    async for _ in async_items():
        continue
`);
  assert.equal(
    evaluateRule(
      "prompt/secure-client-configuration",
      localCapture("DefaultAzureCredential"),
    ),
    true,
    "a safe local compound callee remains valid",
  );
  assert.equal(
    evaluateRule(
      "prompt/secure-client-configuration",
      localCapture("ForbiddenCredential"),
    ),
    false,
    "a forbidden local compound callee is not deferred as external",
  );

  for (const [initial, replacement, expected, label] of [
    [
      "DefaultAzureCredential",
      "ForbiddenCredential",
      false,
      "captured outer list rebinding is visible",
    ],
    [
      "ForbiddenCredential",
      "DefaultAzureCredential",
      true,
      "captured outer list repair is visible",
    ],
  ]) {
    const captured = addProbe(`from azure.identity import DefaultAzureCredential

async def iteration_probe() -> None:
    selected = [${initial}]

    async def async_items():
        yield 1
        selected[0]("secret")

    async for _ in async_items():
        selected = [${replacement}]
        continue
`);
    assert.equal(
      evaluateRule("prompt/secure-client-configuration", captured),
      expected,
      label,
    );
  }
});

test("async generator compound callees observe subscript mutations and deletions", () => {
  const addProbe = (definition) => {
    let workspace = replaceDocument(
      "main.py",
      "import asyncio\n",
      "import asyncio\nfrom azure.core.credentials import AzureKeyCredential as ForbiddenCredential\n",
    );
    workspace = replaceDocument(
      "main.py",
      "\ndef run_sync_demo(settings) -> None:\n",
      `\n${definition}\n\ndef run_sync_demo(settings) -> None:\n`,
      workspace.documents,
    );
    return replaceDocument(
      "main.py",
      "    run_sync_demo(settings)\n",
      "    asyncio.run(iteration_probe())\n    run_sync_demo(settings)\n",
      workspace.documents,
    );
  };

  const forms = [
    {
      label: "list index",
      setup: (credential) => `Selected = [${credential}]`,
      mutate: (credential) => `Selected[0] = ${credential}`,
      remove: "del Selected[0]",
      callee: "Selected[0]",
    },
    {
      label: "negative list index",
      setup: (credential) => `Selected = [${credential}]`,
      mutate: (credential) => `Selected[-1] = ${credential}`,
      remove: "del Selected[-1]",
      callee: "Selected[-1]",
    },
    {
      label: "list slice",
      setup: (credential) => `Selected = [${credential}]`,
      mutate: (credential) => `Selected[:] = [${credential}]`,
      remove: "del Selected[:]",
      callee: "Selected[0]",
    },
    {
      label: "dict key",
      setup: (credential) =>
        `Selected = {"credential": ${credential}}`,
      mutate: (credential) =>
        `Selected["credential"] = ${credential}`,
      remove: 'del Selected["credential"]',
      callee: 'Selected["credential"]',
    },
    {
      label: "nested list subscript",
      setup: (credential) =>
        `Selected = {"credentials": [${credential}]}`,
      mutate: (credential) =>
        `Selected["credentials"][0] = ${credential}`,
      remove: 'del Selected["credentials"][0]',
      callee: 'Selected["credentials"][0]',
    },
  ];

  for (const form of forms) {
    for (const [initial, replacement, expected, label] of [
      [
        "DefaultAzureCredential",
        "ForbiddenCredential",
        false,
        "unsafe consumer mutation",
      ],
      [
        "ForbiddenCredential",
        "DefaultAzureCredential",
        true,
        "safe consumer repair",
      ],
    ]) {
      const consumerMutation = addProbe(`from azure.identity import DefaultAzureCredential

${form.setup(initial)}

async def async_items():
    yield 1
    ${form.callee}("secret")

async def iteration_probe() -> None:
    async for _ in async_items():
        ${form.mutate(replacement)}
        continue
`);
      assert.equal(
        evaluateRule("prompt/secure-client-configuration", consumerMutation),
        expected,
        `${form.label}: ${label}`,
      );

      const generatorMutation = addProbe(`from azure.identity import DefaultAzureCredential

${form.setup(initial)}

async def async_items():
    yield 1
    ${form.mutate(replacement)}
    ${form.callee}("secret")

async def iteration_probe() -> None:
    async for _ in async_items():
        ${form.mutate(initial)}
        continue
`);
      assert.equal(
        evaluateRule("prompt/secure-client-configuration", generatorMutation),
        expected,
        `${form.label}: resumed generator mutation overrides consumer state`,
      );
    }

    const consumerDeletion = addProbe(`from azure.identity import DefaultAzureCredential

${form.setup("ForbiddenCredential")}

async def async_items():
    yield 1
    ${form.callee}("secret")

async def iteration_probe() -> None:
    async for _ in async_items():
        ${form.remove}
        continue
`);
    assert.equal(
      evaluateRule("prompt/secure-client-configuration", consumerDeletion),
      true,
      `${form.label}: consumer deletion removes the forbidden callee`,
    );

    const generatorDeletion = addProbe(`from azure.identity import DefaultAzureCredential

${form.setup("ForbiddenCredential")}

async def async_items():
    yield 1
    ${form.remove}
    ${form.callee}("secret")

async def iteration_probe() -> None:
    async for _ in async_items():
        ${form.mutate("ForbiddenCredential")}
        continue
`);
    assert.equal(
      evaluateRule("prompt/secure-client-configuration", generatorDeletion),
      true,
      `${form.label}: resumed generator deletion overrides consumer state`,
    );
  }

  const aliasMutation = addProbe(`from azure.identity import DefaultAzureCredential

Selected = [DefaultAzureCredential]
Alias = Selected

async def async_items():
    yield 1
    Selected[0]("secret")

async def iteration_probe() -> None:
    async for _ in async_items():
        Alias[0] = ForbiddenCredential
        continue
`);
  assert.equal(
    evaluateRule("prompt/secure-client-configuration", aliasMutation),
    false,
    "subscript mutations preserve container aliases",
  );
});

test("async generator snapshots preserve distinct equal container identities", () => {
  const addProbe = (definition) => {
    let workspace = replaceDocument(
      "main.py",
      "import asyncio\n",
      "import asyncio\nfrom azure.core.credentials import AzureKeyCredential as ForbiddenCredential\n",
    );
    workspace = replaceDocument(
      "main.py",
      "\ndef run_sync_demo(settings) -> None:\n",
      `\n${definition}\n\ndef run_sync_demo(settings) -> None:\n`,
      workspace.documents,
    );
    return replaceDocument(
      "main.py",
      "    run_sync_demo(settings)\n",
      "    asyncio.run(iteration_probe())\n    run_sync_demo(settings)\n",
      workspace.documents,
    );
  };

  for (const [label, definition] of [
    [
      "module binding",
      `from azure.identity import DefaultAzureCredential

Selected = [DefaultAzureCredential]
Original = Selected

async def equal_items():
    global Selected
    yield 1
    Selected = [DefaultAzureCredential]
    Original[0] = ForbiddenCredential
    yield 2
    Selected[0]("secret")

async def iteration_probe() -> None:
    async for _ in equal_items():
        continue`,
    ],
    [
      "closure binding",
      `from azure.identity import DefaultAzureCredential

async def iteration_probe() -> None:
    Selected = [DefaultAzureCredential]
    Original = Selected

    async def equal_items():
        nonlocal Selected
        yield 1
        Selected = [DefaultAzureCredential]
        Original[0] = ForbiddenCredential
        yield 2
        Selected[0]("secret")

    async for _ in equal_items():
        continue`,
    ],
    [
      "object attribute",
      `from azure.identity import DefaultAzureCredential

class Holder:
    pass

Selected = Holder()
Selected.credential = [DefaultAzureCredential]
Original = Selected.credential

async def equal_items():
    yield 1
    Selected.credential = [DefaultAzureCredential]
    Original[0] = ForbiddenCredential
    yield 2
    Selected.credential[0]("secret")

async def iteration_probe() -> None:
    async for _ in equal_items():
        continue`,
    ],
    [
      "sequence element",
      `from azure.identity import DefaultAzureCredential

Selected = [[DefaultAzureCredential]]
Original = Selected[0]

async def equal_items():
    yield 1
    Selected[0] = [DefaultAzureCredential]
    Original[0] = ForbiddenCredential
    yield 2
    Selected[0][0]("secret")

async def iteration_probe() -> None:
    async for _ in equal_items():
        continue`,
    ],
    [
      "mapping value after deletion",
      `from azure.identity import DefaultAzureCredential

Selected = {"credential": [DefaultAzureCredential]}
Original = Selected["credential"]

async def equal_items():
    yield 1
    del Selected["credential"]
    yield 2
    Selected["credential"] = [DefaultAzureCredential]
    Original[0] = ForbiddenCredential
    yield 3
    Selected["credential"][0]("secret")

async def iteration_probe() -> None:
    async for _ in equal_items():
        continue`,
    ],
  ]) {
    assert.equal(
      evaluateRule(
        "prompt/secure-client-configuration",
        addProbe(definition),
      ),
      true,
      `${label}: a distinct equal replacement breaks the old alias`,
    );
  }

  const sameIdentity = addProbe(`from azure.identity import DefaultAzureCredential

Selected = {"credential": [DefaultAzureCredential]}
Original = Selected["credential"]

async def equal_items():
    yield 1
    del Selected["credential"]
    yield 2
    Selected["credential"] = Original
    Original[0] = ForbiddenCredential
    yield 3
    Selected["credential"][0]("secret")

async def iteration_probe() -> None:
    async for _ in equal_items():
        continue`);
  assert.equal(
    evaluateRule("prompt/secure-client-configuration", sameIdentity),
    false,
    "reinserting the same container preserves its alias",
  );
});

test("async generator replay preserves containers across parameter aliases", () => {
  const addProbe = (definition) => {
    let workspace = replaceDocument(
      "main.py",
      "import asyncio\n",
      "import asyncio\nfrom azure.core.credentials import AzureKeyCredential as ForbiddenCredential\n",
    );
    workspace = replaceDocument(
      "main.py",
      "\ndef run_sync_demo(settings) -> None:\n",
      `\n${definition}\n\ndef run_sync_demo(settings) -> None:\n`,
      workspace.documents,
    );
    return replaceDocument(
      "main.py",
      "    run_sync_demo(settings)\n",
      "    asyncio.run(iteration_probe())\n    run_sync_demo(settings)\n",
      workspace.documents,
    );
  };

  for (const [label, container, mutate, callee] of [
    [
      "list",
      "[CREDENTIAL]",
      "Alias[0] = CREDENTIAL",
      'Selected[0]("secret")',
    ],
    [
      "dict",
      '{"credential": CREDENTIAL}',
      'Alias["credential"] = CREDENTIAL',
      'Selected["credential"]("secret")',
    ],
  ]) {
    for (const [initial, replacement, expected, direction] of [
      [
        "DefaultAzureCredential",
        "ForbiddenCredential",
        false,
        "unsafe mutation reaches every alias",
      ],
      [
        "ForbiddenCredential",
        "DefaultAzureCredential",
        true,
        "secure repair reaches every alias",
      ],
    ]) {
      const definition = `from azure.identity import DefaultAzureCredential

Selected = ${container.replace("CREDENTIAL", initial)}

def update_selected(Alias):
    ${mutate.replace("CREDENTIAL", replacement)}

async def alias_items():
    yield 1
    yield 2
    ${callee}

async def iteration_probe() -> None:
    async for _ in alias_items():
        update_selected(Selected)
        continue`;
      assert.equal(
        evaluateRule(
          "prompt/secure-client-configuration",
          addProbe(definition),
        ),
        expected,
        `${label}: ${direction}`,
      );
    }
  }

  const capturedAlias = addProbe(`from azure.identity import DefaultAzureCredential

Selected = [DefaultAzureCredential]

def build_mutator(Alias):
    def mutate():
        Alias[0] = ForbiddenCredential
    return mutate

mutate_selected = build_mutator(Selected)

async def alias_items():
    yield 1
    yield 2
    Selected[0]("secret")

async def iteration_probe() -> None:
    async for _ in alias_items():
        mutate_selected()
        continue`);
  assert.equal(
    evaluateRule("prompt/secure-client-configuration", capturedAlias),
    false,
    "a parameter alias remains shared after capture",
  );
});

test("async generator resumed callees observe mutable parameters", () => {
  const addProbe = (definition) => {
    let workspace = replaceDocument(
      "main.py",
      "import asyncio\n",
      "import asyncio\nfrom azure.core.credentials import AzureKeyCredential as ForbiddenCredential\n",
    );
    workspace = replaceDocument(
      "main.py",
      "\ndef run_sync_demo(settings) -> None:\n",
      `\n${definition}\n\ndef run_sync_demo(settings) -> None:\n`,
      workspace.documents,
    );
    return replaceDocument(
      "main.py",
      "    run_sync_demo(settings)\n",
      "    asyncio.run(iteration_probe())\n    run_sync_demo(settings)\n",
      workspace.documents,
    );
  };

  const forms = [
    {
      label: "list",
      setup: (credential) => `[${credential}]`,
      mutate: (credential) => `Shared[0] = ${credential}`,
      remove: "del Shared[0]",
      callee: 'Selected[0]("secret")',
    },
    {
      label: "dict",
      setup: (credential) => `{"credential": ${credential}}`,
      mutate: (credential) =>
        `Shared["credential"] = ${credential}`,
      remove: 'del Shared["credential"]',
      callee: 'Selected["credential"]("secret")',
    },
    {
      label: "nested container",
      setup: (credential) => `{"credentials": [${credential}]}`,
      mutate: (credential) =>
        `Shared["credentials"][0] = ${credential}`,
      remove: 'del Shared["credentials"][0]',
      callee: 'Selected["credentials"][0]("secret")',
    },
  ];

  for (const form of forms) {
    for (const [initial, replacement, expected, direction] of [
      [
        "DefaultAzureCredential",
        "ForbiddenCredential",
        false,
        "unsafe consumer mutation",
      ],
      [
        "ForbiddenCredential",
        "DefaultAzureCredential",
        true,
        "safe consumer repair",
      ],
    ]) {
      const workspace = addProbe(`from azure.identity import DefaultAzureCredential

Shared = ${form.setup(initial)}

async def alias_items(Selected):
    yield 1
    ${form.callee}

async def iteration_probe() -> None:
    async for _ in alias_items(Shared):
        ${form.mutate(replacement)}
        continue`);
      assert.equal(
        evaluateRule("prompt/secure-client-configuration", workspace),
        expected,
        `${form.label}: ${direction}`,
      );
    }

    const deletion = addProbe(`from azure.identity import DefaultAzureCredential

Shared = ${form.setup("ForbiddenCredential")}

async def alias_items(Selected):
    yield 1
    ${form.callee}

async def iteration_probe() -> None:
    async for _ in alias_items(Shared):
        ${form.remove}
        continue`);
    assert.equal(
      evaluateRule("prompt/secure-client-configuration", deletion),
      true,
      `${form.label}: consumer deletion is visible through a parameter`,
    );
  }

  for (const [initial, replacement, expected, direction] of [
    [
      "DefaultAzureCredential",
      "ForbiddenCredential",
      true,
      "an unsafe top-level replacement stays distinct",
    ],
    [
      "ForbiddenCredential",
      "DefaultAzureCredential",
      false,
      "a safe top-level replacement cannot repair the original",
    ],
  ]) {
    const rebound = addProbe(`from azure.identity import DefaultAzureCredential

Shared = [${initial}]

async def alias_items(Selected):
    yield 1
    Selected[0]("secret")

async def iteration_probe() -> None:
    global Shared
    async for _ in alias_items(Shared):
        Shared = [${replacement}]
        continue`);
    assert.equal(
      evaluateRule("prompt/secure-client-configuration", rebound),
      expected,
      direction,
    );
  }

  const distinctReplacement = addProbe(`from azure.identity import DefaultAzureCredential

Shared = {"credential": [DefaultAzureCredential]}
Original = Shared["credential"]

async def alias_items(Selected):
    yield 1
    Selected["credential"][0]("secret")

async def iteration_probe() -> None:
    async for _ in alias_items(Shared):
        Shared["credential"] = [DefaultAzureCredential]
        Original[0] = ForbiddenCredential
        continue`);
  assert.equal(
    evaluateRule("prompt/secure-client-configuration", distinctReplacement),
    true,
    "a distinct parameter replacement is isolated from the old identity",
  );

  for (const [initial, replacement, expected, direction] of [
    [
      "DefaultAzureCredential",
      "ForbiddenCredential",
      false,
      "unsafe same-object reinsertion",
    ],
    [
      "ForbiddenCredential",
      "DefaultAzureCredential",
      true,
      "safe same-object reinsertion",
    ],
  ]) {
    const reinserted = addProbe(`from azure.identity import DefaultAzureCredential

Shared = {"credential": [${initial}]}
Original = Shared["credential"]

async def alias_items(Selected):
    yield 1
    Selected["credential"][0]("secret")

async def iteration_probe() -> None:
    async for _ in alias_items(Shared):
        del Shared["credential"]
        Shared["credential"] = Original
        Original[0] = ${replacement}
        continue`);
    assert.equal(
      evaluateRule("prompt/secure-client-configuration", reinserted),
      expected,
      direction,
    );
  }
});

test("async generator resumed callees observe yielded local containers", () => {
  const addProbe = (definition) => {
    let workspace = replaceDocument(
      "main.py",
      "import asyncio\n",
      "import asyncio\nfrom azure.core.credentials import AzureKeyCredential as ForbiddenCredential\n",
    );
    workspace = replaceDocument(
      "main.py",
      "\ndef run_sync_demo(settings) -> None:\n",
      `\n${definition}\n\ndef run_sync_demo(settings) -> None:\n`,
      workspace.documents,
    );
    return replaceDocument(
      "main.py",
      "    run_sync_demo(settings)\n",
      "    asyncio.run(iteration_probe())\n    run_sync_demo(settings)\n",
      workspace.documents,
    );
  };

  const forms = [
    {
      label: "list",
      setup: (credential) => `[${credential}]`,
      mutate: (credential) => `Alias[0] = ${credential}`,
      remove: "del Alias[0]",
      callee: 'Selected[0]("secret")',
    },
    {
      label: "dict",
      setup: (credential) => `{"credential": ${credential}}`,
      mutate: (credential) =>
        `Alias["credential"] = ${credential}`,
      remove: 'del Alias["credential"]',
      callee: 'Selected["credential"]("secret")',
    },
    {
      label: "nested container",
      setup: (credential) => `{"credentials": [${credential}]}`,
      mutate: (credential) =>
        `Alias["credentials"][0] = ${credential}`,
      remove: 'del Alias["credentials"][0]',
      callee: 'Selected["credentials"][0]("secret")',
    },
  ];

  for (const form of forms) {
    for (const [initial, replacement, expected, direction] of [
      [
        "DefaultAzureCredential",
        "ForbiddenCredential",
        false,
        "unsafe yielded-alias mutation",
      ],
      [
        "ForbiddenCredential",
        "DefaultAzureCredential",
        true,
        "safe yielded-alias repair",
      ],
    ]) {
      const workspace = addProbe(`from azure.identity import DefaultAzureCredential

async def alias_items():
    Selected = ${form.setup(initial)}
    yield Selected
    ${form.callee}

async def iteration_probe() -> None:
    async for Alias in alias_items():
        ${form.mutate(replacement)}
        continue`);
      assert.equal(
        evaluateRule("prompt/secure-client-configuration", workspace),
        expected,
        `${form.label}: ${direction}`,
      );
    }

    const deletion = addProbe(`from azure.identity import DefaultAzureCredential

async def alias_items():
    Selected = ${form.setup("ForbiddenCredential")}
    yield Selected
    ${form.callee}

async def iteration_probe() -> None:
    async for Alias in alias_items():
        ${form.remove}
        continue`);
    assert.equal(
      evaluateRule("prompt/secure-client-configuration", deletion),
      true,
      `${form.label}: consumer deletion is visible through a yielded alias`,
    );
  }

  for (const [initial, replacement, expected, direction] of [
    [
      "DefaultAzureCredential",
      "ForbiddenCredential",
      true,
      "an unsafe yielded alias rebind stays distinct",
    ],
    [
      "ForbiddenCredential",
      "DefaultAzureCredential",
      false,
      "a safe yielded alias rebind cannot repair the original",
    ],
  ]) {
    const rebound = addProbe(`from azure.identity import DefaultAzureCredential

async def alias_items():
    Selected = [${initial}]
    yield Selected
    Selected[0]("secret")

async def iteration_probe() -> None:
    async for Alias in alias_items():
        Alias = [${replacement}]
        continue`);
    assert.equal(
      evaluateRule("prompt/secure-client-configuration", rebound),
      expected,
      direction,
    );
  }

  for (const [initial, replacement, expected, direction] of [
    [
      "DefaultAzureCredential",
      "ForbiddenCredential",
      false,
      "unsafe nested child mutation",
    ],
    [
      "ForbiddenCredential",
      "DefaultAzureCredential",
      true,
      "safe nested child repair",
    ],
  ]) {
    const nestedChild = addProbe(`from azure.identity import DefaultAzureCredential

async def alias_items():
    Selected = {"credentials": [${initial}]}
    yield Selected["credentials"]
    Selected["credentials"][0]("secret")

async def iteration_probe() -> None:
    async for Alias in alias_items():
        Alias[0] = ${replacement}
        continue`);
    assert.equal(
      evaluateRule("prompt/secure-client-configuration", nestedChild),
      expected,
      direction,
    );
  }

  const distinctReplacement = addProbe(`from azure.identity import DefaultAzureCredential

async def alias_items():
    Selected = {"credential": [DefaultAzureCredential]}
    yield Selected
    Selected["credential"][0]("secret")

async def iteration_probe() -> None:
    async for Alias in alias_items():
        Original = Alias["credential"]
        Alias["credential"] = [DefaultAzureCredential]
        Original[0] = ForbiddenCredential
        continue`);
  assert.equal(
    evaluateRule("prompt/secure-client-configuration", distinctReplacement),
    true,
    "a distinct yielded-local replacement is isolated from the old identity",
  );

  for (const [initial, replacement, expected, direction] of [
    [
      "DefaultAzureCredential",
      "ForbiddenCredential",
      false,
      "unsafe yielded-local reinsertion",
    ],
    [
      "ForbiddenCredential",
      "DefaultAzureCredential",
      true,
      "safe yielded-local reinsertion",
    ],
  ]) {
    const reinserted = addProbe(`from azure.identity import DefaultAzureCredential

async def alias_items():
    Selected = {"credential": [${initial}]}
    yield Selected
    Selected["credential"][0]("secret")

async def iteration_probe() -> None:
    async for Alias in alias_items():
        Original = Alias["credential"]
        del Alias["credential"]
        Alias["credential"] = Original
        Original[0] = ${replacement}
        continue`);
    assert.equal(
      evaluateRule("prompt/secure-client-configuration", reinserted),
      expected,
      direction,
    );
  }
});

test("escaped generator collections observe every in-place mutating method", () => {
  const cases = [
    {
      label: "list append",
      initial: (credential) =>
        `[${credential === "DefaultAzureCredential" ? "ForbiddenCredential" : "DefaultAzureCredential"}]`,
      mutate: (credential) => `Alias.append(${credential})`,
      callee: 'Selected[-1]("secret")',
    },
    {
      label: "list extend",
      initial: (credential) =>
        `[${credential === "DefaultAzureCredential" ? "ForbiddenCredential" : "DefaultAzureCredential"}]`,
      mutate: (credential) => `Alias.extend([${credential}])`,
      callee: 'Selected[-1]("secret")',
    },
    {
      label: "list insert",
      initial: (credential) =>
        `[${credential === "DefaultAzureCredential" ? "ForbiddenCredential" : "DefaultAzureCredential"}]`,
      mutate: (credential) => `Alias.insert(0, ${credential})`,
      callee: 'Selected[0]("secret")',
    },
    {
      label: "list clear",
      initial: (credential) =>
        `[${credential === "DefaultAzureCredential" ? "ForbiddenCredential" : "DefaultAzureCredential"}]`,
      mutate: () => "Alias.clear()",
      callee: (credential) =>
        `(Selected or [${credential}])[0]("secret")`,
    },
    {
      label: "list pop",
      initial: (credential) =>
        `[${credential}, ${credential === "DefaultAzureCredential" ? "ForbiddenCredential" : "DefaultAzureCredential"}]`,
      mutate: () => "Alias.pop()",
      callee: 'Selected[-1]("secret")',
    },
    {
      label: "list remove",
      initial: (credential) =>
        `[${credential === "DefaultAzureCredential" ? "ForbiddenCredential" : "DefaultAzureCredential"}, ${credential}]`,
      mutate: (credential) =>
        `Alias.remove(${credential === "DefaultAzureCredential" ? "ForbiddenCredential" : "DefaultAzureCredential"})`,
      callee: 'Selected[0]("secret")',
    },
    {
      label: "list reverse",
      initial: (credential) =>
        `[${credential === "DefaultAzureCredential" ? "ForbiddenCredential" : "DefaultAzureCredential"}, ${credential}]`,
      mutate: () => "Alias.reverse()",
      callee: 'Selected[0]("secret")',
    },
    {
      label: "list sort",
      initial: (credential) =>
        `[("z", ${credential === "DefaultAzureCredential" ? "ForbiddenCredential" : "DefaultAzureCredential"}), ("a", ${credential})]`,
      mutate: () => "Alias.sort()",
      callee: 'Selected[0][1]("secret")',
    },
    {
      label: "dict update",
      initial: (credential) =>
        `{"credential": ${credential === "DefaultAzureCredential" ? "ForbiddenCredential" : "DefaultAzureCredential"}}`,
      mutate: (credential) =>
        `Alias.update({"credential": ${credential}})`,
      callee: 'Selected["credential"]("secret")',
    },
    {
      label: "dict setdefault",
      initial: () => "{}",
      mutate: (credential) =>
        `Alias.setdefault("credential", ${credential})`,
      callee: 'Selected["credential"]("secret")',
    },
    {
      label: "dict pop",
      initial: (credential) =>
        `{"credential": ${credential === "DefaultAzureCredential" ? "ForbiddenCredential" : "DefaultAzureCredential"}}`,
      mutate: () => 'Alias.pop("credential")',
      callee: (credential) =>
        `Selected.get("credential", ${credential})("secret")`,
    },
    {
      label: "dict popitem",
      initial: (credential) =>
        `{"credential": ${credential}, "removed": ${credential === "DefaultAzureCredential" ? "ForbiddenCredential" : "DefaultAzureCredential"}}`,
      mutate: () => "Alias.popitem()",
      callee: 'Selected["credential"]("secret")',
    },
    {
      label: "dict clear",
      initial: (credential) =>
        `{"credential": ${credential === "DefaultAzureCredential" ? "ForbiddenCredential" : "DefaultAzureCredential"}}`,
      mutate: () => "Alias.clear()",
      callee: (credential) =>
        `(Selected or {"credential": ${credential}})["credential"]("secret")`,
    },
    {
      label: "set add",
      initial: () => "set()",
      mutate: (credential) => `Alias.add(${credential})`,
      callee: "Selected.pop()(\"secret\")",
    },
    {
      label: "set update",
      initial: () => "set()",
      mutate: (credential) => `Alias.update([${credential}])`,
      callee: "Selected.pop()(\"secret\")",
    },
    {
      label: "set difference_update",
      initial: (credential) =>
        `{${credential}, ${credential === "DefaultAzureCredential" ? "ForbiddenCredential" : "DefaultAzureCredential"}}`,
      mutate: (credential) =>
        `Alias.difference_update([${credential === "DefaultAzureCredential" ? "ForbiddenCredential" : "DefaultAzureCredential"}])`,
      callee: "Selected.pop()(\"secret\")",
    },
    {
      label: "set intersection_update",
      initial: (credential) =>
        `{${credential}, ${credential === "DefaultAzureCredential" ? "ForbiddenCredential" : "DefaultAzureCredential"}}`,
      mutate: (credential) =>
        `Alias.intersection_update([${credential}])`,
      callee: "Selected.pop()(\"secret\")",
    },
    {
      label: "set symmetric_difference_update",
      initial: (credential) =>
        `{${credential === "DefaultAzureCredential" ? "ForbiddenCredential" : "DefaultAzureCredential"}}`,
      mutate: (credential) =>
        `Alias.symmetric_difference_update([${credential === "DefaultAzureCredential" ? "ForbiddenCredential" : "DefaultAzureCredential"}, ${credential}])`,
      callee: "Selected.pop()(\"secret\")",
    },
    {
      label: "set discard",
      initial: (credential) =>
        `{${credential}, ${credential === "DefaultAzureCredential" ? "ForbiddenCredential" : "DefaultAzureCredential"}}`,
      mutate: (credential) =>
        `Alias.discard(${credential === "DefaultAzureCredential" ? "ForbiddenCredential" : "DefaultAzureCredential"})`,
      callee: "Selected.pop()(\"secret\")",
    },
    {
      label: "set remove",
      initial: (credential) =>
        `{${credential}, ${credential === "DefaultAzureCredential" ? "ForbiddenCredential" : "DefaultAzureCredential"}}`,
      mutate: (credential) =>
        `Alias.remove(${credential === "DefaultAzureCredential" ? "ForbiddenCredential" : "DefaultAzureCredential"})`,
      callee: "Selected.pop()(\"secret\")",
    },
    {
      label: "set pop",
      initial: (credential) =>
        `{${credential === "DefaultAzureCredential" ? "ForbiddenCredential" : "DefaultAzureCredential"}}`,
      mutate: (credential) =>
        `Alias.pop()\n        Alias.add(${credential})`,
      callee: "Selected.pop()(\"secret\")",
    },
    {
      label: "set clear",
      initial: (credential) =>
        `{${credential === "DefaultAzureCredential" ? "ForbiddenCredential" : "DefaultAzureCredential"}}`,
      mutate: () => "Alias.clear()",
      callee: (credential) =>
        `(Selected or {${credential}}).pop()("secret")`,
    },
  ];

  for (const [index, form] of cases.entries()) {
    const aliasDirections = form.label.endsWith("_update")
      ? [false, true]
      : [index % 2 === 1];
    for (const yieldedLocal of aliasDirections) {
      for (const [credential, expected] of [
        ["DefaultAzureCredential", true],
        ["ForbiddenCredential", false],
      ]) {
        const callee =
          typeof form.callee === "function"
            ? form.callee(credential)
            : form.callee;
        const generator = yieldedLocal
          ? `async def alias_items():
    Selected = ${form.initial(credential)}
    yield Selected
    ${callee}`
          : `Shared = ${form.initial(credential)}

async def alias_items(Selected):
    yield 1
    ${callee}`;
        const iterator = yieldedLocal
          ? "async for Alias in alias_items():"
          : "Alias = Shared\n    async for _ in alias_items(Shared):";
        const probe = secureGeneratorProbe(`from azure.identity import DefaultAzureCredential

${generator}

async def iteration_probe() -> None:
    ${iterator}
        ${form.mutate(credential)}
        continue`);
        assert.equal(
          evaluateRule("prompt/secure-client-configuration", probe),
          expected,
          `${form.label}: ${yieldedLocal ? "yielded local" : "parameter"} ${credential}`,
        );
      }
    }
  }
});

test("escaped generator set updates preserve same-object identity", () => {
  const directions = [
    {
      label: "parameter",
      generator: (initial) => `Shared = {${initial}}

async def alias_items(Selected):
    yield 1
    Selected.pop()("secret")`,
      iterator: "Alias = Shared\n    async for _ in alias_items(Shared):",
    },
    {
      label: "yielded local",
      generator: (initial) => `async def alias_items():
    Selected = {${initial}}
    yield Selected
    Selected.pop()("secret")`,
      iterator: "async for Alias in alias_items():",
    },
  ];

  for (const method of [
    "difference_update",
    "intersection_update",
    "symmetric_difference_update",
  ]) {
    for (const direction of directions) {
      for (const [initial, replacement, expected] of [
        ["ForbiddenCredential", "DefaultAzureCredential", true],
        ["DefaultAzureCredential", "ForbiddenCredential", false],
      ]) {
        const reset =
          method === "intersection_update"
            ? `Alias.${method}(Alias)
        Original.clear()
        Original.add(${replacement})`
            : `Alias.${method}(Alias)
        Original.add(${replacement})`;
        const probe = secureGeneratorProbe(`from azure.identity import DefaultAzureCredential

${direction.generator(initial)}

async def iteration_probe() -> None:
    ${direction.iterator}
        Original = Alias
        ${reset}
        continue`);
        assert.equal(
          evaluateRule("prompt/secure-client-configuration", probe),
          expected,
          `${method}: ${direction.label} ${initial} -> ${replacement}`,
        );
      }
    }
  }
});

test("escaped generator list AugAssign mutates the original identity", () => {
  const variants = [
    {
      label: "parameter +=",
      generator: (initial) => `Shared = [${initial}]

async def alias_items(Selected):
    yield 1
    Selected[-1]("secret")`,
      iterator: "Alias = Shared\n    async for _ in alias_items(Shared):",
      mutate: (replacement) => `Alias += [${replacement}]`,
    },
    {
      label: "yielded local +=",
      generator: (initial) => `async def alias_items():
    Selected = [${initial}]
    yield Selected
    Selected[-1]("secret")`,
      iterator: "async for Alias in alias_items():",
      mutate: (replacement) => `Alias += [${replacement}]`,
    },
    {
      label: "parameter *= 0",
      generator: (initial) => `Shared = [${initial}]

async def alias_items(Selected):
    yield 1
    Selected[0]("secret")`,
      iterator: "Alias = Shared\n    async for _ in alias_items(Shared):",
      mutate: (replacement) =>
        `Alias *= 0\n        Alias.append(${replacement})`,
    },
    {
      label: "yielded local *= 0",
      generator: (initial) => `async def alias_items():
    Selected = [${initial}]
    yield Selected
    Selected[0]("secret")`,
      iterator: "async for Alias in alias_items():",
      mutate: (replacement) =>
        `Alias *= 0\n        Alias.append(${replacement})`,
    },
    {
      label: "parameter *= positive",
      generator: (initial) => `Shared = [${initial}]

async def alias_items(Selected):
    yield 1
    Selected[1]("secret")`,
      iterator: "Alias = Shared\n    async for _ in alias_items(Shared):",
      mutate: (replacement) =>
        `Alias *= 2\n        Alias[1] = ${replacement}`,
    },
    {
      label: "yielded local *= positive",
      generator: (initial) => `async def alias_items():
    Selected = [${initial}]
    yield Selected
    Selected[1]("secret")`,
      iterator: "async for Alias in alias_items():",
      mutate: (replacement) =>
        `Alias *= 2\n        Alias[1] = ${replacement}`,
    },
  ];

  for (const variant of variants) {
    for (const [initial, replacement, expected] of [
      ["ForbiddenCredential", "DefaultAzureCredential", true],
      ["DefaultAzureCredential", "ForbiddenCredential", false],
    ]) {
      const probe = secureGeneratorProbe(`from azure.identity import DefaultAzureCredential

${variant.generator(initial)}

async def iteration_probe() -> None:
    ${variant.iterator}
        ${variant.mutate(replacement)}
        continue`);
      assert.equal(
        evaluateRule("prompt/secure-client-configuration", probe),
        expected,
        `${variant.label}: ${replacement}`,
      );
    }
  }
});

test("resumed generator in-place mutations override consumer state", () => {
  const cases = [
    {
      label: "list methods",
      initial: "[]",
      generatorMutation: (credential) =>
        `Selected.clear()
    Selected.append(${credential})`,
      consumerMutation: (credential) =>
        `Alias.clear()
        Alias.append(${credential})`,
      callee: 'Selected[0]("secret")',
    },
    {
      label: "dict methods",
      initial: "{}",
      generatorMutation: (credential) =>
        `Selected.update({"credential": ${credential}})`,
      consumerMutation: (credential) =>
        `Alias.update({"credential": ${credential}})`,
      callee: 'Selected["credential"]("secret")',
    },
    {
      label: "set methods",
      initial: "set()",
      generatorMutation: (credential) =>
        `Selected.clear()
    Selected.add(${credential})`,
      consumerMutation: (credential) =>
        `Alias.clear()
        Alias.add(${credential})`,
      callee: 'Selected.pop()("secret")',
    },
    {
      label: "list +=",
      initial: "[]",
      generatorMutation: (credential) => `Selected += [${credential}]`,
      consumerMutation: (credential) =>
        `Alias.clear()
        Alias.append(${credential})`,
      callee: 'Selected[-1]("secret")',
    },
    {
      label: "list *= 0",
      initial: "[DefaultAzureCredential]",
      generatorMutation: (credential) =>
        `Selected *= 0
    Selected.append(${credential})`,
      consumerMutation: (credential) =>
        `Alias.clear()
        Alias.append(${credential})`,
      callee: 'Selected[0]("secret")',
    },
  ];

  for (const [index, form] of cases.entries()) {
    const yieldedLocal = index % 2 === 0;
    for (const [generatorCredential, consumerCredential, expected] of [
      ["DefaultAzureCredential", "ForbiddenCredential", true],
      ["ForbiddenCredential", "DefaultAzureCredential", false],
    ]) {
      const generator = yieldedLocal
        ? `async def alias_items():
    Selected = ${form.initial}
    yield Selected
    ${form.generatorMutation(generatorCredential)}
    ${form.callee}`
        : `Shared = ${form.initial}

async def alias_items(Selected):
    yield 1
    ${form.generatorMutation(generatorCredential)}
    ${form.callee}`;
      const iterator = yieldedLocal
        ? "async for Alias in alias_items():"
        : "Alias = Shared\n    async for _ in alias_items(Shared):";
      const probe = secureGeneratorProbe(`from azure.identity import DefaultAzureCredential

${generator}

async def iteration_probe() -> None:
    ${iterator}
        ${form.consumerMutation(consumerCredential)}
        continue`);
      assert.equal(
        evaluateRule("prompt/secure-client-configuration", probe),
        expected,
        `${form.label}: ${generatorCredential} overrides ${consumerCredential}`,
      );
    }
  }
});

test("mutating collection methods preserve removed and reinserted identities", () => {
  const variants = [
    {
      label: "list parameter pop and insert",
      generator: (initial) => `Shared = [[${initial}]]

async def alias_items(Selected):
    yield 1
    Selected[0][0]("secret")`,
      iterator: "Alias = Shared\n    async for _ in alias_items(Shared):",
      mutate: (replacement) => `Original = Alias.pop()
        Alias.insert(0, Original)
        Original[0] = ${replacement}`,
    },
    {
      label: "dict yielded-local pop and setdefault",
      generator: (initial) => `async def alias_items():
    Selected = {"credential": [${initial}]}
    yield Selected
    Selected["credential"][0]("secret")`,
      iterator: "async for Alias in alias_items():",
      mutate: (replacement) => `Original = Alias.pop("credential")
        Alias.setdefault("credential", Original)
        Original[0] = ${replacement}`,
    },
    {
      label: "set parameter pop and add",
      generator: (initial) => `Shared = {${initial}}

async def alias_items(Selected):
    yield 1
    Selected.pop()("secret")`,
      iterator: "Alias = Shared\n    async for _ in alias_items(Shared):",
      mutate: () => `Original = Alias.pop()
        Alias.add(Original)`,
    },
  ];

  for (const variant of variants) {
    for (const [initial, replacement, expectedAfterMutation] of [
      ["ForbiddenCredential", "DefaultAzureCredential", true],
      ["DefaultAzureCredential", "ForbiddenCredential", false],
    ]) {
      const effectiveReplacement =
        variant.label.startsWith("set") ? initial : replacement;
      const expected = variant.label.startsWith("set")
        ? initial === "DefaultAzureCredential"
        : expectedAfterMutation;
      const probe = secureGeneratorProbe(`from azure.identity import DefaultAzureCredential

${variant.generator(initial)}

async def iteration_probe() -> None:
    ${variant.iterator}
        ${variant.mutate(effectiveReplacement)}
        continue`);
      assert.equal(
        evaluateRule("prompt/secure-client-configuration", probe),
        expected,
        `${variant.label}: ${initial} -> ${effectiveReplacement}`,
      );
    }
  }
});

test("async generator resumed conditions observe shared mutable values", () => {
  const addProbe = (definition) => {
    let workspace = replaceDocument(
      "main.py",
      "import asyncio\n",
      "import asyncio\nfrom azure.core.credentials import AzureKeyCredential as ForbiddenCredential\n",
    );
    workspace = replaceDocument(
      "main.py",
      "\ndef run_sync_demo(settings) -> None:\n",
      `\n${definition}\n\ndef run_sync_demo(settings) -> None:\n`,
      workspace.documents,
    );
    return replaceDocument(
      "main.py",
      "    run_sync_demo(settings)\n",
      "    asyncio.run(iteration_probe())\n    run_sync_demo(settings)\n",
      workspace.documents,
    );
  };

  for (const [initial, replacement, expected, direction] of [
    ["False", "True", false, "unsafe parameter condition"],
    ["True", "False", true, "safe parameter condition"],
  ]) {
    const parameter = addProbe(`from azure.identity import DefaultAzureCredential

Shared = {"flags": [${initial}]}

async def conditional_items(Selected):
    yield 1
    if Selected["flags"][0]:
        ForbiddenCredential("secret")

async def iteration_probe() -> None:
    async for _ in conditional_items(Shared):
        Shared["flags"][0] = ${replacement}
        continue`);
    assert.equal(
      evaluateRule("prompt/secure-client-configuration", parameter),
      expected,
      direction,
    );
  }

  for (const [initial, replacement, expected, direction] of [
    ["False", "True", false, "unsafe yielded-local condition"],
    ["True", "False", true, "safe yielded-local condition"],
  ]) {
    const yieldedLocal = addProbe(`from azure.identity import DefaultAzureCredential

async def conditional_items():
    Selected = [${initial}]
    yield Selected
    if Selected[0]:
        ForbiddenCredential("secret")

async def iteration_probe() -> None:
    async for Alias in conditional_items():
        Alias[0] = ${replacement}
        continue`);
    assert.equal(
      evaluateRule("prompt/secure-client-configuration", yieldedLocal),
      expected,
      direction,
    );
  }
});

test("async generator replay distinguishes replacements and preserves reinsertion", () => {
  const addProbe = (definition) => {
    let workspace = replaceDocument(
      "main.py",
      "import asyncio\n",
      "import asyncio\nfrom azure.core.credentials import AzureKeyCredential as ForbiddenCredential\n",
    );
    workspace = replaceDocument(
      "main.py",
      "\ndef run_sync_demo(settings) -> None:\n",
      `\n${definition}\n\ndef run_sync_demo(settings) -> None:\n`,
      workspace.documents,
    );
    return replaceDocument(
      "main.py",
      "    run_sync_demo(settings)\n",
      "    asyncio.run(iteration_probe())\n    run_sync_demo(settings)\n",
      workspace.documents,
    );
  };

  const replacement = addProbe(`from azure.identity import DefaultAzureCredential

Selected = [DefaultAzureCredential]
Alias = Selected

def poison(Alias):
    Alias[0] = ForbiddenCredential

async def alias_items():
    global Selected
    yield 1
    Selected = [DefaultAzureCredential]
    yield 2
    Selected[0]("secret")

async def iteration_probe() -> None:
    async for _ in alias_items():
        poison(Alias)
        continue`);
  assert.equal(
    evaluateRule("prompt/secure-client-configuration", replacement),
    true,
    "a new equal list remains distinct from the old parameter alias",
  );

  const reinserted = addProbe(`from azure.identity import DefaultAzureCredential

Selected = {"credential": [DefaultAzureCredential]}
Alias = Selected["credential"]

def poison(Alias):
    Alias[0] = ForbiddenCredential

async def alias_items():
    yield 1
    del Selected["credential"]
    yield 2
    Selected["credential"] = Alias
    yield 3
    Selected["credential"][0]("secret")

async def iteration_probe() -> None:
    async for _ in alias_items():
        poison(Alias)
        continue`);
  assert.equal(
    evaluateRule("prompt/secure-client-configuration", reinserted),
    false,
    "delete and reinsert preserve the original parameter alias",
  );

  const replacementAfterDelete = addProbe(`from azure.identity import DefaultAzureCredential

Selected = {"credential": [DefaultAzureCredential]}
Alias = Selected["credential"]

def poison(Alias):
    Alias[0] = ForbiddenCredential

async def alias_items():
    yield 1
    del Selected["credential"]
    yield 2
    Selected["credential"] = [DefaultAzureCredential]
    yield 3
    Selected["credential"][0]("secret")

async def iteration_probe() -> None:
    async for _ in alias_items():
        poison(Alias)
        continue`);
  assert.equal(
    evaluateRule(
      "prompt/secure-client-configuration",
      replacementAfterDelete,
    ),
    true,
    "a new equal list after deletion remains identity-distinct",
  );
});

test("nested async-for loop control determines generator resumption", () => {
  const addProbe = (body) => {
    let workspace = replaceDocument(
      "main.py",
      "import asyncio\n",
      "import asyncio\nfrom azure.core.credentials import AzureKeyCredential as ForbiddenCredential\nfrom contextlib import nullcontext\n",
    );
    workspace = replaceDocument(
      "main.py",
      "\ndef run_sync_demo(settings) -> None:\n",
      `\nasync def controlled_items():
    yield 1
    ForbiddenCredential("resumed")

async def iteration_probe() -> None:
    async for _ in controlled_items():
${body}


def run_sync_demo(settings) -> None:
`,
      workspace.documents,
    );
    workspace = replaceDocument(
      "main.py",
      "    run_sync_demo(settings)\n",
      "    asyncio.run(iteration_probe())\n    run_sync_demo(settings)\n",
      workspace.documents,
    );
    return workspace;
  };

  for (const [label, body] of [
    [
      "try-finally break",
      `        try:
            break
        finally:
            pass`,
    ],
    [
      "finally overrides continue",
      `        try:
            continue
        finally:
            break`,
    ],
    [
      "with-nested break",
      `        with nullcontext():
            break`,
    ],
    [
      "match-nested break",
      `        match 1:
            case 1:
                break`,
    ],
    [
      "compound nested break",
      `        if True:
            try:
                with nullcontext():
                    match "stop":
                        case "stop":
                            break
            finally:
                pass`,
    ],
  ]) {
    assert.equal(
      evaluateRule("prompt/secure-client-configuration", addProbe(body)),
      true,
      label,
    );
  }

  assert.equal(
    evaluateRule(
      "prompt/secure-client-configuration",
      addProbe(`        try:
            break
        finally:
            continue`),
    ),
    false,
    "finally continue overrides break and resumes the generator",
  );
});

test("discovery follows nested consumer outcomes before resuming generators", () => {
  const discover = (body) => {
    const result = spawnSync("python", [analyzerScript, "--discover"], {
      encoding: "utf8",
      input: JSON.stringify({
        applicationPaths: ["main.py"],
        documents: [
          {
            path: "main.py",
            source: `import asyncio

async def controlled_items():
    yield 1
    from support import resumed
    resumed.run()

async def main():
    async for _ in controlled_items():
${body}

asyncio.run(main())
`,
          },
          {
            path: "support/resumed.py",
            source: "def run():\n    pass\n",
          },
        ],
      }),
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  };

  for (const [label, body] of [
    [
      "try-finally break",
      `        try:
            break
        finally:
            pass`,
    ],
    [
      "with-nested break",
      `        with object():
            break`,
    ],
    [
      "match-nested break",
      `        match 1:
            case 1:
                break`,
    ],
  ]) {
    assert.deepEqual(discover(body), ["main.py"], label);
  }

  assert.deepEqual(
    discover(`        try:
            break
        finally:
            continue`),
    ["main.py", "support/resumed.py"],
    "finally continue overrides break",
  );
});

test("async generator yields preserve exclusive path constraints", () => {
  const withGenerators = (eventGridBody, cloudBody) => {
    let candidate = replaceDocument(
      "main.py",
      "import asyncio\n",
      `import asyncio
from azure.core.messaging import CloudEvent
from azure.eventgrid import EventGridEvent
`,
    );
    candidate = replaceDocument(
      "main.py",
      "    receive_event_grid_events_async,\n",
      "    receive_event_grid_events_async,\n    route_event_async,\n",
      candidate.documents,
    );
    candidate = replaceDocument(
      "main.py",
      "\ndef run_sync_demo(settings) -> None:\n",
      `
async def generated_event_grid_events(payload_selector):
${eventGridBody}


async def generated_cloud_events(payload_selector):
${cloudBody}


def run_sync_demo(settings) -> None:
`,
      candidate.documents,
    );
    return replaceDocument(
      "main.py",
      `            await receive_event_grid_events_async(
                EVENT_GRID_PAYLOADS,
                blob_service_client,
            )
            await receive_cloud_events_async(
                CLOUD_EVENT_PAYLOADS,
                blob_service_client,
            )`,
      `            async for event in generated_event_grid_events(settings):
                await route_event_async(event, blob_service_client)
                continue
            async for event in generated_cloud_events(settings):
                await route_event_async(event, blob_service_client)
                continue`,
      candidate.documents,
    );
  };

  const exclusive = withGenerators(
    `    if payload_selector:
        yield EventGridEvent.from_json(EVENT_GRID_PAYLOADS[0])
    else:
        yield EventGridEvent.from_json(EVENT_GRID_PAYLOADS[1])`,
    `    if payload_selector:
        yield CloudEvent.from_json(CLOUD_EVENT_PAYLOADS[0])
    else:
        yield CloudEvent.from_json(CLOUD_EVENT_PAYLOADS[1])`,
  );
  assert.equal(
    evaluateRule("prompt/ordered-demo-workflow", exclusive),
    false,
  );

  const sequential = withGenerators(
    `    yield EventGridEvent.from_json(EVENT_GRID_PAYLOADS[0])
    yield EventGridEvent.from_json(EVENT_GRID_PAYLOADS[1])`,
    `    yield CloudEvent.from_json(CLOUD_EVENT_PAYLOADS[0])
    yield CloudEvent.from_json(CLOUD_EVENT_PAYLOADS[1])`,
  );
  assert.equal(
    evaluateRule("prompt/ordered-demo-workflow", sequential),
    true,
  );
});

test("async generator loop back-edges resume with changed environments", () => {
  const addProbe = (generatorBody, consumerBody) => {
    let workspace = replaceDocument(
      "main.py",
      "import asyncio\n",
      "import asyncio\nfrom azure.core.credentials import AzureKeyCredential as ForbiddenCredential\n",
    );
    workspace = replaceDocument(
      "main.py",
      "\ndef run_sync_demo(settings) -> None:\n",
      `\n${generatorBody}\n\nasync def iteration_probe() -> None:
    async for _ in backedge_items():
        ${consumerBody}


def run_sync_demo(settings) -> None:
`,
      workspace.documents,
    );
    return replaceDocument(
      "main.py",
      "    run_sync_demo(settings)\n",
      "    asyncio.run(iteration_probe())\n    run_sync_demo(settings)\n",
      workspace.documents,
    );
  };

  const generators = [
    `async def backedge_items():
    first = True
    while True:
        yield 1
        if first:
            first = False
            continue
        ForbiddenCredential("later while iteration")
        return`,
    `async def backedge_items():
    first = True
    for _ in range(3):
        yield 1
        if first:
            first = False
            continue
        ForbiddenCredential("later for iteration")
        return`,
    `async def backedge_items():
    first = True
    for _ in iter((1, 2, 3)):
        yield 1
        if first:
            first = False
            continue
        ForbiddenCredential("later abstract for iteration")
        return`,
  ];

  for (const generator of generators) {
    assert.equal(
      evaluateRule(
        "prompt/secure-client-configuration",
        addProbe(generator, "continue"),
      ),
      false,
      generator,
    );
    assert.equal(
      evaluateRule(
        "prompt/secure-client-configuration",
        addProbe(generator, "break"),
      ),
      true,
      `break does not resume ${generator}`,
    );
  }
});

test("del invalidates local, global, and nonlocal SDK bindings in source order", () => {
  const addProbe = (definition) => {
    let workspace = replaceDocument(
      "main.py",
      "import asyncio\n",
      "import asyncio\nfrom azure.core.credentials import AzureKeyCredential as ForbiddenCredential\n",
    );
    workspace = replaceDocument(
      "main.py",
      "\ndef run_sync_demo(settings) -> None:\n",
      `\n${definition}\n\ndef run_sync_demo(settings) -> None:\n`,
      workspace.documents,
    );
    return replaceDocument(
      "main.py",
      "    run_sync_demo(settings)\n",
      "    deletion_probe()\n    run_sync_demo(settings)\n",
      workspace.documents,
    );
  };

  for (const definition of [
    `def deletion_probe() -> None:
    alias = ForbiddenCredential
    del alias
    alias("secret")
`,
    `global_alias = ForbiddenCredential

def deletion_probe() -> None:
    global global_alias
    del global_alias
    global_alias("secret")
`,
    `def deletion_probe() -> None:
    alias = ForbiddenCredential

    def nested() -> None:
        nonlocal alias
        del alias
        alias("secret")

    nested()
`,
  ]) {
    assert.equal(
      evaluateRule(
        "prompt/secure-client-configuration",
        addProbe(definition),
      ),
      true,
      definition,
    );
  }

  const afterUse = addProbe(`def deletion_probe() -> None:
    alias = ForbiddenCredential
    alias("secret")
    del alias
`);
  assert.equal(
    evaluateRule("prompt/secure-client-configuration", afterUse),
    false,
  );
});

test("Python sources must satisfy compile-time semantics before analysis", () => {
  const misplacedFuture = replaceDocument(
    "main.py",
    "import asyncio\n",
    "import asyncio\nfrom __future__ import annotations\n",
  );
  const topLevelReturn = replaceDocument(
    "main.py",
    'if __name__ == "__main__":\n    main()\n',
    'if __name__ == "__main__":\n    main()\n\nreturn\n',
  );
  for (const invalid of [misplacedFuture, topLevelReturn]) {
    for (const rule of sourceRules) {
      assert.equal(evaluateRule(rule, invalid), false, rule);
    }
  }
  assert.equal(
    evaluateRule("prompt/event-routing", goldenWorkspace),
    true,
  );
});

test("literal truthiness consistently excludes impossible runtime calls", () => {
  const falseConditions = [
    "[]",
    "()",
    "{}",
    "set()",
    '""',
    'b""',
    "not [1]",
    "[] or ()",
    "[1] and []",
    "() != ()",
  ];
  for (const condition of falseConditions) {
    const unreachable = replaceDocument(
      "main.py",
      "def run_sync_demo(settings) -> None:\n",
      `def run_sync_demo(settings) -> None:
    if ${condition}:
        from azure.core.credentials import AzureKeyCredential
        AzureKeyCredential("secret")
`,
    );
    assert.equal(
      evaluateRule("prompt/secure-client-configuration", unreachable),
      true,
      condition,
    );
  }

  for (const condition of [
    "[1]",
    "(1,)",
    '{"enabled": True}',
    "{1}",
    '"enabled"',
    'b"enabled"',
    "not []",
    "[] or [1]",
    "() == ()",
  ]) {
    const reachable = replaceDocument(
      "main.py",
      "def run_sync_demo(settings) -> None:\n",
      `def run_sync_demo(settings) -> None:
    if ${condition}:
        from azure.core.credentials import AzureKeyCredential
        AzureKeyCredential("secret")
`,
    );
    assert.equal(
      evaluateRule("prompt/secure-client-configuration", reachable),
      false,
      condition,
    );
  }
});

test("reachable module control flow and match cases enforce authentication", () => {
  const reachableBodies = [
    `if True:
    ForbiddenCredential("secret")`,
    `for _ in [1]:
    ForbiddenCredential("secret")`,
    `while True:
    ForbiddenCredential("secret")
    break`,
    `with DefaultAzureCredential():
    ForbiddenCredential("secret")`,
    `try:
    print("attempt")
except RuntimeError:
    print("handled")
finally:
    ForbiddenCredential("secret")`,
    `match "created":
    case "created":
        ForbiddenCredential("secret")
    case _:
        print("unmatched")`,
    `match "created":
    case _:
        ForbiddenCredential("secret")`,
    `[ForbiddenCredential("secret") for _ in [1]]`,
    `match 1:
    case int():
        ForbiddenCredential("secret")`,
    `class ReachableConfiguration:
    credential = ForbiddenCredential("secret")`,
    `def reachable_default(
    credential=ForbiddenCredential("secret"),
):
    return credential`,
    `@ForbiddenCredential("secret")
def decorated():
    return None`,
  ];
  for (const body of reachableBodies) {
    const insecure = replaceDocument(
      "main.py",
      "\ndef run_sync_demo(settings) -> None:\n",
      `
from azure.core.credentials import AzureKeyCredential as ForbiddenCredential

${body}

def run_sync_demo(settings) -> None:
`,
    );
    assert.equal(
      evaluateRule("prompt/secure-client-configuration", insecure),
      false,
      body,
    );
  }

  for (const body of [
    `if False:
    ForbiddenCredential("secret")`,
    `for _ in ():
    ForbiddenCredential("secret")`,
    `while False:
    ForbiddenCredential("secret")`,
    `match "created":
    case "deleted":
        ForbiddenCredential("secret")
    case _:
        print("safe fallback")`,
    `match "created":
    case "created" if False:
        ForbiddenCredential("secret")
    case _:
        print("safe fallback")`,
    `[ForbiddenCredential("secret") for _ in ()]`,
    `match 1:
    case str():
        ForbiddenCredential("secret")
    case _:
        print("safe fallback")`,
    `if False:
    class UnreachableConfiguration:
        credential = ForbiddenCredential("secret")`,
  ]) {
    const valid = replaceDocument(
      "main.py",
      "\ndef run_sync_demo(settings) -> None:\n",
      `
from azure.core.credentials import AzureKeyCredential as ForbiddenCredential

${body}

def run_sync_demo(settings) -> None:
`,
    );
    assert.equal(
      evaluateRule("prompt/secure-client-configuration", valid),
      true,
      body,
    );
  }
});

test("runtime annotations execute unless annotation evaluation is postponed", () => {
  const annotations = [
    "ANNOTATED: ForbiddenCredential('secret')",
    `class Annotated:
    field: ForbiddenCredential("secret")`,
    `def annotated_parameter(
    value: ForbiddenCredential("secret"),
):
    return value`,
    `def annotated_return() -> ForbiddenCredential("secret"):
    return None`,
    `class AnnotatedMethod:
    def method(self, value: ForbiddenCredential("secret")):
        return value`,
  ];
  for (const annotation of annotations) {
    let executable = replaceDocument(
      "main.py",
      "from __future__ import annotations\n\n",
      "from azure.core.credentials import AzureKeyCredential as ForbiddenCredential\n\n",
    );
    executable = replaceDocument(
      "main.py",
      "\ndef run_sync_demo(settings) -> None:\n",
      `\n${annotation}\n\n\ndef run_sync_demo(settings) -> None:\n`,
      executable.documents,
    );
    assert.equal(
      evaluateRule("prompt/secure-client-configuration", executable),
      false,
      annotation,
    );

    let postponed = replaceDocument(
      "main.py",
      "from __future__ import annotations\n",
      "from __future__ import annotations\nfrom azure.core.credentials import AzureKeyCredential as ForbiddenCredential\n",
    );
    postponed = replaceDocument(
      "main.py",
      "\ndef run_sync_demo(settings) -> None:\n",
      `\n${annotation}\n\n\ndef run_sync_demo(settings) -> None:\n`,
      postponed.documents,
    );
    assert.equal(
      evaluateRule("prompt/secure-client-configuration", postponed),
      true,
      `postponed: ${annotation}`,
    );
  }
});

test("entrypoint rejects workspaces without a top-level application file", () => {
  const root = fileURLToPath(new URL("./.no-top-level", import.meta.url));
  rmSync(root, { recursive: true, force: true });
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "requirements.txt"), dependencies);
    writeFileSync(join(root, "src", "main.py"), documents["main.py"]);
    const result = spawnSync(
      "node",
      [checkScript, "prompt/sdk-event-deserialization"],
      { cwd: root, encoding: "utf8", windowsHide: true },
    );
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /No top-level generated application Python files were found\./,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("comments, strings, invalid syntax, and local fake SDK types cannot pass", () => {
  const fake = `
class EventGridEvent:
    @classmethod
    def from_json(cls, payload):
        return cls()

class CloudEvent(EventGridEvent):
    pass

class DefaultAzureCredential:
    pass

class BlobServiceClient:
    def get_blob_client(self, container, blob):
        return self

class EventGridPublisherClient:
    def send(self, events):
        return None

def main():
    EventGridEvent.from_json("{}")
    CloudEvent.from_json("{}")
    BlobServiceClient().get_blob_client("container", "blob").download_blob()
    EventGridPublisherClient().send([])

main()
`;
  for (const source of [
    "",
    "# EventGridEvent.from_json CloudEvent.from_json BlobServiceClient\n",
    '"""DefaultAzureCredential EventGridPublisherClient send download_blob"""\n',
    "this is not valid Python",
    fake,
  ]) {
    const workspace = workspaceWithDocuments([{ path: "main.py", source }]);
    for (const rule of sourceRules) {
      assert.equal(evaluateRule(rule, workspace), false, rule);
    }
  }
});

test("SDK event imports shadowed by later local classes cannot pass", () => {
  let shadowed = replaceDocument(
    "event_receiver.py",
    "from azure.core.messaging import CloudEvent",
    `from azure.core.messaging import CloudEvent

class CloudEvent:
    @classmethod
    def from_json(cls, payload):
        return cls()
`,
  );
  shadowed = replaceDocument(
    "event_receiver.py",
    "from azure.eventgrid import EventGridEvent",
    `from azure.eventgrid import EventGridEvent

class EventGridEvent:
    @classmethod
    def from_json(cls, payload):
        return cls()
`,
    shadowed.documents,
  );
  assert.equal(
    evaluateRule("prompt/sdk-event-deserialization", shadowed),
    false,
  );
  assert.equal(evaluateRule("prompt/async-implementations", shadowed), false);
});

test("relative SDK aliases and function-local imports remain trusted", () => {
  const packagedDocuments = goldenWorkspace.documents.map((document) => ({
    path: `notifier/${document.path}`,
    source: document.source
      .replace("from config import (", "from .config import (")
      .replace("from event_publisher import (", "from .event_publisher import (")
      .replace("from event_receiver import (", "from .event_receiver import (")
      .replace(
        "from azure.core.messaging import CloudEvent\n",
        "from .sdk_aliases import CloudEventAlias as CloudEvent\n",
      )
      .replace(
        "from azure.eventgrid import EventGridEvent\n",
        "from .sdk_aliases import GridEventAlias as EventGridEvent\n",
      )
      .replace(
        "from blob_event_handler import (",
        "from .blob_event_handler import (",
      ),
  }));
  const relativeAliases = workspaceWithDocuments([
    {
      path: "main.py",
      source: `from notifier.main import main

if __name__ == "__main__":
    main()
`,
    },
    { path: "notifier/__init__.py", source: "" },
    {
      path: "notifier/sdk_aliases.py",
      source: `from azure.core.messaging import CloudEvent as CloudEventAlias
from azure.eventgrid import EventGridEvent as GridEventAlias
`,
    },
    ...packagedDocuments,
  ]);
  for (const rule of sourceRules) {
    assert.equal(evaluateRule(rule, relativeAliases), true, rule);
  }

  let localImports = replaceDocument(
    "event_receiver.py",
    "from azure.core.messaging import CloudEvent\nfrom azure.eventgrid import EventGridEvent\n",
    "",
  );
  for (const [signature, imports] of [
    [
      `def route_event(
    event: EventGridEvent | CloudEvent,
    blob_service_client: BlobServiceClient,
) -> None:
`,
      `def route_event(
    event: EventGridEvent | CloudEvent,
    blob_service_client: BlobServiceClient,
) -> None:
    from azure.core.messaging import CloudEvent as CloudEvent
    from azure.eventgrid import EventGridEvent as EventGridEvent
`,
    ],
    [
      `def receive_event_grid_events(
    payloads: Iterable[str | bytes],
    blob_service_client: BlobServiceClient,
) -> None:
`,
      `def receive_event_grid_events(
    payloads: Iterable[str | bytes],
    blob_service_client: BlobServiceClient,
) -> None:
    from azure.eventgrid import EventGridEvent as EventGridEvent
`,
    ],
    [
      `def receive_cloud_events(
    payloads: Iterable[str | bytes],
    blob_service_client: BlobServiceClient,
) -> None:
`,
      `def receive_cloud_events(
    payloads: Iterable[str | bytes],
    blob_service_client: BlobServiceClient,
) -> None:
    from azure.core.messaging import CloudEvent as CloudEvent
`,
    ],
    [
      `async def route_event_async(
    event: EventGridEvent | CloudEvent,
    blob_service_client: AsyncBlobServiceClient,
) -> None:
`,
      `async def route_event_async(
    event: EventGridEvent | CloudEvent,
    blob_service_client: AsyncBlobServiceClient,
) -> None:
    from azure.core.messaging import CloudEvent as CloudEvent
    from azure.eventgrid import EventGridEvent as EventGridEvent
`,
    ],
    [
      `async def receive_event_grid_events_async(
    payloads: Iterable[str | bytes],
    blob_service_client: AsyncBlobServiceClient,
) -> None:
`,
      `async def receive_event_grid_events_async(
    payloads: Iterable[str | bytes],
    blob_service_client: AsyncBlobServiceClient,
) -> None:
    from azure.eventgrid import EventGridEvent as EventGridEvent
`,
    ],
    [
      `async def receive_cloud_events_async(
    payloads: Iterable[str | bytes],
    blob_service_client: AsyncBlobServiceClient,
) -> None:
`,
      `async def receive_cloud_events_async(
    payloads: Iterable[str | bytes],
    blob_service_client: AsyncBlobServiceClient,
) -> None:
    from azure.core.messaging import CloudEvent as CloudEvent
`,
    ],
  ]) {
    localImports = replaceDocument(
      "event_receiver.py",
      signature,
      imports,
      localImports.documents,
    );
  }
  for (const rule of sourceRules) {
    assert.equal(evaluateRule(rule, localImports), true, rule);
  }
});

test("function-local SDK lookalikes cannot shadow official event types", () => {
  let shadowed = replaceDocument(
    "event_receiver.py",
    `def receive_event_grid_events(
    payloads: Iterable[str | bytes],
    blob_service_client: BlobServiceClient,
) -> None:
`,
    `def receive_event_grid_events(
    payloads: Iterable[str | bytes],
    blob_service_client: BlobServiceClient,
) -> None:
    class EventGridEvent:
        @classmethod
        def from_json(cls, payload):
            return cls()
`,
  );
  shadowed = replaceDocument(
    "event_receiver.py",
    `def receive_cloud_events(
    payloads: Iterable[str | bytes],
    blob_service_client: BlobServiceClient,
) -> None:
`,
    `def receive_cloud_events(
    payloads: Iterable[str | bytes],
    blob_service_client: BlobServiceClient,
) -> None:
    class CloudEvent:
        @classmethod
        def from_json(cls, payload):
            return cls()
`,
    shadowed.documents,
  );
  assert.equal(
    evaluateRule("prompt/sdk-event-deserialization", shadowed),
    false,
  );
});

test("function lexical bindings shadow SDK globals before their statements", () => {
  const original = `    for payload in payloads:
        route_event(EventGridEvent.from_json(payload), blob_service_client)
`;
  for (const lateBinding of [
    "    EventGridEvent = object()\n",
    "    from azure.eventgrid import EventGridEvent\n",
    "    class EventGridEvent:\n        pass\n",
    "    def EventGridEvent():\n        return None\n",
    "    del EventGridEvent\n",
  ]) {
    const shadowed = replaceDocument(
      "event_receiver.py",
      original,
      `${original}${lateBinding}`,
    );
    assert.equal(
      evaluateRule("prompt/sdk-event-deserialization", shadowed),
      false,
      lateBinding,
    );
  }

  const parameterShadow = replaceDocument(
    "event_receiver.py",
    `def receive_event_grid_events(
    payloads: Iterable[str | bytes],
    blob_service_client: BlobServiceClient,
) -> None:
`,
    `def receive_event_grid_events(
    payloads: Iterable[str | bytes],
    blob_service_client: BlobServiceClient,
    EventGridEvent=object,
) -> None:
`,
  );
  assert.equal(
    evaluateRule("prompt/sdk-event-deserialization", parameterShadow),
    false,
  );

  const globalDelete = replaceDocument(
    "event_receiver.py",
    original,
    `    global EventGridEvent
${original}    if False:
        del EventGridEvent
`,
  );
  assert.equal(
    evaluateRule("prompt/sdk-event-deserialization", globalDelete),
    true,
  );

  const validAlias = replaceDocument(
    "event_receiver.py",
    original,
    `    GridEventAlias = EventGridEvent
    for payload in payloads:
        route_event(GridEventAlias.from_json(payload), blob_service_client)
    class UnrelatedSdkName:
        pass
`,
  );
  assert.equal(
    evaluateRule("prompt/sdk-event-deserialization", validAlias),
    true,
  );
});

test("workspace Azure modules shadow official SDK imports", () => {
  for (const path of ["azure.py", "azure/__init__.py"]) {
    const shadowed = workspaceWithDocuments([
      ...goldenWorkspace.documents,
      {
        path,
        source: `
class EventGridEvent:
    @classmethod
    def from_json(cls, payload):
        return cls()

class CloudEvent(EventGridEvent):
    pass
`,
      },
    ]);
    for (const rule of sourceRules) {
      assert.equal(evaluateRule(rule, shadowed), false, `${path}: ${rule}`);
    }
  }
});

test("each missing core behavior fails its focused rule", () => {
  const cases = [
    [
      "prompt/sdk-event-deserialization",
      replaceDocument(
        "event_receiver.py",
        "route_event(EventGridEvent.from_json(payload), blob_service_client)",
        "route_event(payload, blob_service_client)",
      ),
    ],
    [
      "prompt/event-routing",
      replaceDocument(
        "event_receiver.py",
        "elif event_type == BLOB_DELETED:",
        "elif event_type == BLOB_CREATED:",
      ),
    ],
    [
      "prompt/blob-subject-and-summary",
      replaceDocument(
        "blob_event_handler.py",
        "f\"access_tier={properties.blob_tier}\"",
        'f"access_tier=unknown"',
      ),
    ],
    [
      "prompt/race-condition-handling",
      replaceDocument(
        "blob_event_handler.py",
        "except ResourceNotFoundError:",
        "except ValueError:",
      ),
    ],
    [
      "prompt/custom-event-publishing",
      replaceDocument(
        "event_publisher.py",
        "client.send(list(events))",
        "print(list(events))",
      ),
    ],
    [
      "prompt/async-implementations",
      replaceDocument(
        "event_publisher.py",
        "await client.send(list(events))",
        "client.send(list(events))",
      ),
    ],
    [
      "prompt/secure-client-configuration",
      replaceDocument(
        "config.py",
        'event_grid_topic_endpoint=os.environ["AZURE_EVENT_GRID_TOPIC_ENDPOINT"],',
        'event_grid_topic_endpoint="https://example.invalid/api/events",',
      ),
    ],
    [
      "prompt/ordered-demo-workflow",
      replaceDocument(
        "main.py",
        "run_sync_demo(settings)\n    asyncio.run(run_async_demo(settings))",
        "asyncio.run(run_async_demo(settings))\n    run_sync_demo(settings)",
      ),
    ],
  ];
  for (const [rule, workspace] of cases) {
    assert.equal(evaluateRule(rule, workspace), false, rule);
  }
});

test("routing selectors must derive from the deserialized event type", () => {
  let unrelated = replaceDocument(
    "event_receiver.py",
    "    event_type = event.event_type if isinstance(event, EventGridEvent) else event.type",
    `    event.event_type
    event.type
    event_type = BLOB_CREATED if event.subject else BLOB_DELETED`,
  );
  unrelated = replaceDocument(
    "event_receiver.py",
    "    event_type = event.event_type if isinstance(event, EventGridEvent) else event.type",
    `    event.event_type
    event.type
    event_type = BLOB_CREATED if event.subject else BLOB_DELETED`,
    unrelated.documents,
  );
  assert.equal(evaluateRule("prompt/event-routing", unrelated), false);

  let aliases = replaceDocument(
    "event_receiver.py",
    "    event_type = event.event_type if isinstance(event, EventGridEvent) else event.type",
    `    deserialized_type = (
        event.event_type if isinstance(event, EventGridEvent) else event.type
    )
    event_type = deserialized_type`,
  );
  aliases = replaceDocument(
    "event_receiver.py",
    "    event_type = event.event_type if isinstance(event, EventGridEvent) else event.type",
    `    deserialized_type = (
        event.event_type if isinstance(event, EventGridEvent) else event.type
    )
    event_type = deserialized_type`,
    aliases.documents,
  );
  assert.equal(evaluateRule("prompt/event-routing", aliases), true);

  for (const replacement of [
    `    event_type = event.event_type if isinstance(event, EventGridEvent) else event.type
    event_type = event.subject`,
    `    event_type = event.event_type if isinstance(event, EventGridEvent) else event.type
    event_type = BLOB_CREATED`,
    `    event_type = event.event_type if isinstance(event, EventGridEvent) else event.type
    if event.subject:
        event_type = event.event_type if isinstance(event, EventGridEvent) else event.type
    else:
        event_type = BLOB_DELETED`,
  ]) {
    let reassigned = replaceDocument(
      "event_receiver.py",
      "    event_type = event.event_type if isinstance(event, EventGridEvent) else event.type",
      replacement,
    );
    reassigned = replaceDocument(
      "event_receiver.py",
      "    event_type = event.event_type if isinstance(event, EventGridEvent) else event.type",
      replacement,
      reassigned.documents,
    );
    assert.equal(
      evaluateRule("prompt/event-routing", reassigned),
      false,
      replacement,
    );
  }

  const validReassignment = `    event_type = (
        event.event_type if isinstance(event, EventGridEvent) else event.type
    )
    preserved_type = event_type
    event_type = preserved_type`;
  let reassignedAlias = replaceDocument(
    "event_receiver.py",
    "    event_type = event.event_type if isinstance(event, EventGridEvent) else event.type",
    validReassignment,
  );
  reassignedAlias = replaceDocument(
    "event_receiver.py",
    "    event_type = event.event_type if isinstance(event, EventGridEvent) else event.type",
    validReassignment,
    reassignedAlias.documents,
  );
  assert.equal(evaluateRule("prompt/event-routing", reassignedAlias), true);

  const validBranchMerge = `    extracted_type = (
        event.event_type if isinstance(event, EventGridEvent) else event.type
    )
    event_type = extracted_type
    if event.subject:
        event_type = extracted_type
    else:
        event_type = (
            event.event_type if isinstance(event, EventGridEvent) else event.type
        )`;
  let mergedAliases = replaceDocument(
    "event_receiver.py",
    "    event_type = event.event_type if isinstance(event, EventGridEvent) else event.type",
    validBranchMerge,
  );
  mergedAliases = replaceDocument(
    "event_receiver.py",
    "    event_type = event.event_type if isinstance(event, EventGridEvent) else event.type",
    validBranchMerge,
    mergedAliases.documents,
  );
  assert.equal(evaluateRule("prompt/event-routing", mergedAliases), true);

  for (const predicate of [
    "event_type != BLOB_CREATED",
    "not (event_type == BLOB_CREATED)",
  ]) {
    let negated = replaceDocument(
      "event_receiver.py",
      "event_type == BLOB_CREATED",
      predicate,
    );
    negated = replaceDocument(
      "event_receiver.py",
      "event_type == BLOB_CREATED",
      predicate,
      negated.documents,
    );
    assert.equal(evaluateRule("prompt/event-routing", negated), false);
    assert.equal(
      evaluateRule("prompt/ordered-demo-workflow", negated),
      false,
    );
  }
});

test("routing constants resolve exactly at each predicate", () => {
  const withPredicates = (setup, created, deleted) =>
    workspaceWithDocuments(
      goldenWorkspace.documents.map((document) => ({
        ...document,
        source: document.source
          .replaceAll("\r\n", "\n")
          .replaceAll(
            "    event_type = event.event_type if isinstance(event, EventGridEvent) else event.type",
            `    event_type = event.event_type if isinstance(event, EventGridEvent) else event.type${setup}`,
          )
          .replaceAll("event_type == BLOB_CREATED", created)
          .replaceAll("event_type == BLOB_DELETED", deleted),
      })),
    );

  for (const candidate of [
    withPredicates(
      "",
      "event_type == BLOB_CREATED.lower()",
      "event_type == BLOB_DELETED.lower()",
    ),
    withPredicates(
      "",
      'event_type == BLOB_CREATED + ".Unexpected"',
      'event_type == BLOB_DELETED + ".Unexpected"',
    ),
    withPredicates(
      `
    expected_created = "Microsoft.Storage.BlobCreated"
    expected_deleted = "Microsoft.Storage.BlobDeleted"
    expected_created = event.subject
    expected_deleted = event.subject`,
      "event_type == expected_created",
      "event_type == expected_deleted",
    ),
  ]) {
    assert.equal(evaluateRule("prompt/event-routing", candidate), false);
  }

  for (const candidate of [
    withPredicates(
      "",
      'event_type == "Microsoft.Storage.BlobCreated"',
      'event_type == "Microsoft.Storage.BlobDeleted"',
    ),
    withPredicates(
      `
    expected_created = BLOB_CREATED
    expected_deleted = BLOB_DELETED`,
      "event_type == expected_created",
      "event_type == expected_deleted",
    ),
    withPredicates(
      `
    expected_created = "Microsoft.Storage." + "BlobCreated"
    expected_deleted = "Microsoft.Storage." + "BlobDeleted"`,
      "event_type == expected_created",
      "event_type == expected_deleted",
    ),
    withPredicates(
      `
    if event.subject:
        expected_created = BLOB_CREATED
        expected_deleted = BLOB_DELETED
    else:
        expected_created = "Microsoft.Storage.BlobCreated"
        expected_deleted = "Microsoft.Storage.BlobDeleted"`,
      "event_type == expected_created",
      "event_type == expected_deleted",
    ),
  ]) {
    assert.equal(evaluateRule("prompt/event-routing", candidate), true);
  }
});

test("Python routing behavior stays within the selected route closure", () => {
  const fixedClient = replaceDocument(
    "blob_event_handler.py",
    "        blob_client = blob_service_client.get_blob_client(container, blob_name)",
    `        parsed_but_unused = blob_service_client.get_blob_client(container, blob_name)
        blob_client = blob_service_client.get_blob_client(
            "fixed-container",
            "fixed/blob.txt",
        )`,
  );
  assert.equal(evaluateRule("prompt/event-routing", fixedClient), false);
  assert.equal(
    evaluateRule("prompt/blob-subject-and-summary", fixedClient),
    false,
  );

  const unrelatedDeletion = replaceDocument(
    "blob_event_handler.py",
    '    logger.info("Deleted blob %s from container %s", blob_name, container)',
    '    logger.info("Unrelated lifecycle message")',
  );
  assert.equal(
    evaluateRule("prompt/event-routing", unrelatedDeletion),
    false,
  );

  let wrappers = replaceDocument(
    "event_receiver.py",
    "\ndef route_event(\n",
    `
def dispatch_created(subject, blob_service_client) -> None:
    handle_blob_created(subject, blob_service_client)


def dispatch_deleted(subject) -> None:
    handle_blob_deleted(subject)


def route_event(
`,
  );
  wrappers = replaceDocument(
    "event_receiver.py",
    '        handle_blob_created(event.subject or "", blob_service_client)',
    '        dispatch_created(event.subject or "", blob_service_client)',
    wrappers.documents,
  );
  wrappers = replaceDocument(
    "event_receiver.py",
    '        handle_blob_deleted(event.subject or "")',
    '        dispatch_deleted(event.subject or "")',
    wrappers.documents,
  );
  assert.equal(evaluateRule("prompt/event-routing", wrappers), true);
  assert.equal(
    evaluateRule("prompt/blob-subject-and-summary", wrappers),
    true,
  );
});

test("unknown-event fallbacks require recognized standard logging", () => {
  let fakeLogger = replaceDocument(
    "event_receiver.py",
    "import logging",
    `class FakeLogger:
    def warning(self, *args) -> None:
        pass`,
  );
  fakeLogger = replaceDocument(
    "event_receiver.py",
    "logger = logging.getLogger(__name__)",
    "logger = FakeLogger()",
    fakeLogger.documents,
  );
  assert.equal(evaluateRule("prompt/event-routing", fakeLogger), false);

  let fakeFunction = replaceDocument(
    "event_receiver.py",
    "logger = logging.getLogger(__name__)",
    `logger = logging.getLogger(__name__)


def warning(*args) -> None:
    pass`,
  );
  fakeFunction = replaceDocument(
    "event_receiver.py",
    "logger.warning(",
    "warning(",
    fakeFunction.documents,
  );
  fakeFunction = replaceDocument(
    "event_receiver.py",
    "logger.warning(",
    "warning(",
    fakeFunction.documents,
  );
  assert.equal(evaluateRule("prompt/event-routing", fakeFunction), false);

  let standardWarnings = replaceDocument(
    "event_receiver.py",
    "import logging",
    "import logging\nimport warnings",
  );
  standardWarnings = replaceDocument(
    "event_receiver.py",
    "logger.warning(",
    "warnings.warn(",
    standardWarnings.documents,
  );
  standardWarnings = replaceDocument(
    "event_receiver.py",
    "logger.warning(",
    "warnings.warn(",
    standardWarnings.documents,
  );
  assert.equal(evaluateRule("prompt/event-routing", standardWarnings), true);

  let helperWarning = replaceDocument(
    "event_receiver.py",
    'logger.warning("Unrecognized Event Grid event type: %s", event_type)',
    "warn_unknown_event(event_type)",
  );
  helperWarning = replaceDocument(
    "event_receiver.py",
    'logger.warning("Unrecognized Event Grid event type: %s", event_type)',
    "warn_unknown_event(event_type)",
    helperWarning.documents,
  );
  helperWarning = replaceDocument(
    "event_receiver.py",
    "\ndef route_event(\n",
    `
def warn_unknown_event(event_type: str) -> None:
    logger.warning("Unrecognized Event Grid event type: %s", event_type)


def route_event(
`,
    helperWarning.documents,
  );
  assert.equal(evaluateRule("prompt/event-routing", helperWarning), true);

  for (const path of ["logging.py", "logging/__init__.py"]) {
    const shadowed = workspaceWithDocuments([
      ...goldenWorkspace.documents,
      {
        path,
        source: `
class Logger:
    def warning(self, *args) -> None:
        pass

def getLogger(*args):
    return Logger()
`,
      },
    ]);
    assert.equal(
      evaluateRule("prompt/event-routing", shadowed),
      false,
      path,
    );
  }

  for (const path of ["warnings.py", "warnings/__init__.py"]) {
    const shadowed = workspaceWithDocuments([
      ...standardWarnings.documents,
      {
        path,
        source: "def warn(*args):\n    pass\n",
      },
    ]);
    assert.equal(
      evaluateRule("prompt/event-routing", shadowed),
      false,
      path,
    );
  }

  let localShadow = replaceDocument(
    "event_receiver.py",
    "logger = logging.getLogger(__name__)",
    `logger = logging.getLogger(__name__)


class NoOpLogging:
    def warning(self, *args) -> None:
        pass`,
  );
  localShadow = replaceDocument(
    "event_receiver.py",
    'logger.warning("Unrecognized Event Grid event type: %s", event_type)',
    `logging = NoOpLogging()
        logging.warning("Unrecognized Event Grid event type: %s", event_type)`,
    localShadow.documents,
  );
  localShadow = replaceDocument(
    "event_receiver.py",
    'logger.warning("Unrecognized Event Grid event type: %s", event_type)',
    `logging = NoOpLogging()
        logging.warning("Unrecognized Event Grid event type: %s", event_type)`,
    localShadow.documents,
  );
  assert.equal(evaluateRule("prompt/event-routing", localShadow), false);

  let monkeyPatched = replaceDocument(
    "event_receiver.py",
    "logger = logging.getLogger(__name__)",
    `logger = logging.getLogger(__name__)
logging.warning = lambda *args: None`,
  );
  monkeyPatched = replaceDocument(
    "event_receiver.py",
    "logger.warning(",
    "logging.warning(",
    monkeyPatched.documents,
  );
  monkeyPatched = replaceDocument(
    "event_receiver.py",
    "logger.warning(",
    "logging.warning(",
    monkeyPatched.documents,
  );
  assert.equal(evaluateRule("prompt/event-routing", monkeyPatched), false);

  const mutatedLogger = replaceDocument(
    "event_receiver.py",
    "logger = logging.getLogger(__name__)",
    `logger = logging.getLogger(__name__)
logger.warning = lambda *args: None`,
  );
  assert.equal(evaluateRule("prompt/event-routing", mutatedLogger), false);
});

test("unknown-event warning scans respect deferred Python scopes", () => {
  const warning =
    'logger.warning("Unrecognized Event Grid event type: %s", event_type)';
  const replaceFallbacks = (sync, async) => {
    let candidate = replaceDocument(
      "event_receiver.py",
      warning,
      "__SYNC_FALLBACK_WARNING__",
    );
    candidate = replaceDocument(
      "event_receiver.py",
      warning,
      "__ASYNC_FALLBACK_WARNING__",
      candidate.documents,
    );
    candidate = replaceDocument(
      "event_receiver.py",
      "__SYNC_FALLBACK_WARNING__",
      sync,
      candidate.documents,
    );
    return replaceDocument(
      "event_receiver.py",
      "__ASYNC_FALLBACK_WARNING__",
      async,
      candidate.documents,
    );
  };

  for (const [label, statement] of [
    [
      "uncalled nested function",
      `def deferred_warning() -> None:
            logger.warning("Unrecognized Event Grid event type: %s", event_type)`,
    ],
    [
      "uncalled nested lambda",
      `deferred_warning = lambda: logger.warning(
            "Unrecognized Event Grid event type: %s", event_type)`,
    ],
    [
      "uncalled nested class method",
      `class DeferredWarning:
            def emit(self) -> None:
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)`,
    ],
  ]) {
    assert.equal(
      evaluateRule(
        "prompt/event-routing",
        replaceFallbacks(statement, statement),
      ),
      false,
      label,
    );
  }

  const calledFunctions = replaceFallbacks(
    `def emit_warning() -> None:
            logger.warning("Unrecognized Event Grid event type: %s", event_type)
        emit_warning()`,
    `async def emit_warning() -> None:
            logger.warning("Unrecognized Event Grid event type: %s", event_type)
        await emit_warning()`,
  );
  assert.equal(evaluateRule("prompt/event-routing", calledFunctions), true);

  const calledLambdas = replaceFallbacks(
    `emit_warning = lambda: logger.warning(
            "Unrecognized Event Grid event type: %s", event_type)
        emit_warning()`,
    `emit_warning = lambda: logger.warning(
            "Unrecognized Event Grid event type: %s", event_type)
        emit_warning()`,
  );
  assert.equal(evaluateRule("prompt/event-routing", calledLambdas), true);

  const calledClasses = replaceFallbacks(
    `class WarningHelper:
            def emit(self) -> None:
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
        WarningHelper().emit()`,
    `class WarningHelper:
            async def emit(self) -> None:
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
        await WarningHelper().emit()`,
  );
  assert.equal(evaluateRule("prompt/event-routing", calledClasses), true);

  const deferredMutations = replaceFallbacks(
    `def mutate_logger() -> None:
            logger.warning = lambda *args: None
        logger.warning("Unrecognized Event Grid event type: %s", event_type)`,
    `class LoggerMutation:
            def apply(self) -> None:
                logger.warning = lambda *args: None
        logger.warning("Unrecognized Event Grid event type: %s", event_type)`,
  );
  assert.equal(evaluateRule("prompt/event-routing", deferredMutations), true);

  for (const [label, statement] of [
    [
      "nested function default",
      `def deferred_warning(
            value=logger.warning(
                "Unrecognized Event Grid event type: %s", event_type),
        ) -> None:
            pass`,
    ],
    [
      "nested lambda positional default",
      `deferred_warning = lambda value=logger.warning(
            "Unrecognized Event Grid event type: %s", event_type): None`,
    ],
    [
      "nested lambda keyword-only default",
      `deferred_warning = lambda *, value=logger.warning(
            "Unrecognized Event Grid event type: %s", event_type): None`,
    ],
    [
      "nested function decorator",
      `def warning_decorator(function):
            logger.warning(
                "Unrecognized Event Grid event type: %s", event_type)
            return function

        @warning_decorator
        def deferred_warning() -> None:
            pass`,
    ],
    [
      "class body statement",
      `class DefinitionWarning:
            logger.warning(
                "Unrecognized Event Grid event type: %s", event_type)`,
    ],
    [
      "class method default",
      `class DefinitionWarning:
            def deferred_warning(
                self,
                value=logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type),
            ) -> None:
                pass`,
    ],
  ]) {
    assert.equal(
      evaluateRule(
        "prompt/event-routing",
        replaceFallbacks(statement, statement),
      ),
      true,
      label,
    );
  }

  const annotationStatement = `def deferred_warning(
            value: logger.warning(
                "Unrecognized Event Grid event type: %s", event_type),
        ) -> None:
            pass`;
  assert.equal(
    evaluateRule(
      "prompt/event-routing",
      replaceFallbacks(annotationStatement, annotationStatement),
    ),
    false,
    "postponed nested annotations",
  );
  const runtimeAnnotations = replaceDocument(
    "event_receiver.py",
    "from __future__ import annotations\n\n",
    "",
    replaceFallbacks(
      annotationStatement,
      annotationStatement,
    ).documents,
  );
  assert.equal(
    evaluateRule("prompt/event-routing", runtimeAnnotations),
    true,
    "runtime nested annotations",
  );

  for (const decoratedDefinition of [
    `@warning_factory()
        def deferred_warning() -> None:
            pass`,
    `@warning_factory()
        class DefinitionWarning:
            pass`,
  ]) {
    const factoryDecorator = `def warning_factory():
            def decorate(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition
            return decorate

        ${decoratedDefinition}`;
    assert.equal(
      evaluateRule(
        "prompt/event-routing",
        replaceFallbacks(factoryDecorator, factoryDecorator),
      ),
      true,
      decoratedDefinition,
    );
  }

  for (const [label, factory, expected] of [
    [
      "lambda defaults mutate factory state in positional then keyword-only order",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = [noisy, quiet]
            deferred = lambda first=(decorators.pop(), None)[1], *, second=(
                decorators.reverse(), None
            )[1]: decorators.pop()
            return decorators.pop()

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      true,
    ],
    [
      "lambda bodies remain deferred while factories select decorators",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = [noisy, quiet]
            deferred = lambda: decorators.pop()
            return decorators.pop()

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      false,
    ],
    [
      "unreachable returned decorator",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            if False:
                return noisy
            return quiet

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      false,
    ],
    [
      "dominating return excludes later decorator",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            if True:
                return quiet
            return noisy

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      false,
    ],
    [
      "reaching returned decorator",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            if False:
                return quiet
            selected = noisy
            return selected

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      true,
    ],
    [
      "all reachable returned decorators warn",
      `def warning_factory(selector):
            def noisy_one(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def noisy_two(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            if selector:
                return noisy_one
            return noisy_two

        @warning_factory(event_type)
        def deferred_warning() -> None:
            pass`,
      true,
    ],
    [
      "for return makes later noisy decorator unreachable",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            for _ in [0]:
                return quiet
            return noisy

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      false,
    ],
    [
      "for returns the warning decorator",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            for _ in [0]:
                return noisy
            return quiet

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      true,
    ],
    [
      "for target returns the quiet decorator",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            for selected in [quiet]:
                return selected
            return noisy

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      false,
    ],
    [
      "for target returns the warning decorator",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            for selected in [noisy]:
                return selected
            return quiet

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      true,
    ],
    [
      "loop raise makes later noisy decorator unreachable",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            for _ in [0]:
                raise RuntimeError("factory failed")
            return noisy

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      false,
    ],
    [
      "while return makes later noisy decorator unreachable",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            while True:
                return quiet
            return noisy

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      false,
    ],
    [
      "later while iteration returns the quiet decorator",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            first = True
            while True:
                if first:
                    first = False
                    continue
                return quiet
            return noisy

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      false,
    ],
    [
      "loop-carried AugAssign selects the warning decorator",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = (quiet, noisy)
            index = 0
            for _ in [0]:
                index += 1
            return decorators[index]

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      true,
    ],
    [
      "loop-carried AugAssign selects the quiet decorator",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = (noisy, quiet)
            index = 0
            while index < 1:
                index += 1
            return decorators[index]

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      false,
    ],
    [
      "nonlocal helper selects the warning decorator",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = (quiet, noisy)
            index = 0

            def advance():
                nonlocal index
                index += 1

            advance()
            return decorators[index]

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      true,
    ],
    [
      "nonlocal reset after AugAssign selects the quiet decorator",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = (quiet, noisy)
            index = 0

            def advance():
                nonlocal index
                index += 1

            def reset():
                nonlocal index
                index = 0

            advance()
            reset()
            return decorators[index]

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      false,
    ],
    [
      "global helper selects the warning decorator",
      `def warning_factory():
            global decorator_index

            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = (quiet, noisy)
            decorator_index = 0

            def advance():
                global decorator_index
                decorator_index += 1

            advance()
            return decorators[decorator_index]

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      true,
    ],
    [
      "captured collection mutation invalidates the selected decorator",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = [noisy]

            def reset():
                decorators[0] = quiet

            reset()
            return decorators[0]

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      false,
    ],
    [
      "captured chained list alias selects the quiet decorator",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = [noisy]
            alias = decorators
            chained = alias

            def reset():
                chained[0] = quiet

            reset()
            return decorators[0]

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      false,
    ],
    [
      "captured chained list alias selects the warning decorator",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = [quiet]
            alias = decorators
            chained = alias

            def select():
                chained[0] = noisy

            select()
            return decorators[0]

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      true,
    ],
    [
      "unreachable chained alias mutation preserves the warning decorator",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = [noisy]
            alias = decorators

            if False:
                alias[0] = quiet
            return decorators[0]

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      true,
    ],
    [
      "conditional chained alias mutation fails closed",
      `def warning_factory(selector):
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = [noisy]
            alias = decorators

            if selector:
                alias[0] = quiet
            return decorators[0]

        @warning_factory(event_type)
        def deferred_warning() -> None:
            pass`,
      false,
    ],
    [
      "captured dict alias update selects the quiet decorator",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = {"selected": noisy}
            alias = decorators

            def reset():
                alias.update(selected=quiet)

            reset()
            return decorators["selected"]

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      false,
    ],
    [
      "captured dict alias item assignment selects the warning decorator",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = {"selected": quiet}
            alias = decorators

            def select():
                alias["selected"] = noisy

            select()
            return decorators["selected"]

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      true,
    ],
    [
      "discarded popitem through a captured chained alias removes the warning decorator",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = {"remaining": quiet, "discarded": noisy}
            alias = decorators
            chained = alias

            def discard_last():
                chained.popitem()

            discard_last()
            return decorators.popitem()[1]

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      false,
    ],
    [
      "discarded popitem through a captured chained alias preserves the warning decorator",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = {"remaining": noisy, "discarded": quiet}
            alias = decorators
            chained = alias

            def discard_last():
                chained.popitem()

            discard_last()
            return decorators.popitem()[1]

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      true,
    ],
    [
      "tuple expression evaluates a subscripted popitem mutation",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = {"remaining": noisy, "discarded": quiet}
            (decorators.popitem()[1], None)
            return decorators.popitem()[1]

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      true,
    ],
    [
      "tuple expression popitem mutation may remove the warning decorator",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = {"remaining": quiet, "discarded": noisy}
            (decorators.popitem()[1], None)
            return decorators.popitem()[1]

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      false,
    ],
    [
      "nested call arguments evaluate subscripted popitem mutations",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = {"remaining": noisy, "discarded": quiet}
            str(decorators.popitem()[1])
            return decorators.popitem()[1]

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      true,
    ],
    [
      "callable expressions evaluate chained popitem results",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = {"remaining": noisy, "discarded": quiet}
            decorators.popitem()[1](lambda definition: definition)
            return decorators.popitem()[1]

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      true,
    ],
    [
      "arbitrary tuple expressions evaluate nested mutations left to right",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = {
                "remaining": noisy,
                "discarded_one": quiet,
                "discarded_two": quiet,
            }
            (
                decorators.popitem()[1],
                decorators.popitem()[1],
            )
            return decorators.popitem()[1]

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      true,
    ],
    [
      "false chained comparisons skip later comparator mutations",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = {"remaining": noisy, "selected": quiet}
            1 < 0 < (decorators.popitem(), 1)[1]
            return decorators.popitem()[1]

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      false,
    ],
    [
      "true chained comparisons evaluate later comparator mutations",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = {"remaining": noisy, "discarded": quiet}
            0 < 1 < (decorators.popitem(), 2)[1]
            return decorators.popitem()[1]

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      true,
    ],
    [
      "unknown chained comparisons merge skipped comparator mutations",
      `def warning_factory(selector):
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = {"remaining": noisy, "selected": quiet}
            selector < 0 < (decorators.popitem(), 1)[1]
            return decorators.popitem()[1]

        @warning_factory(event_type)
        def deferred_warning() -> None:
            pass`,
      false,
    ],
    [
      "joined strings evaluate formatted mutations",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = {"remaining": noisy, "discarded": quiet}
            f"{(decorators.popitem(), '')[1]}"
            return decorators.popitem()[1]

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      true,
    ],
    [
      "nested format specifications evaluate their mutations",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = {"remaining": noisy, "discarded": quiet}
            f"{0:{(decorators.popitem(), '')[1]}}"
            return decorators.popitem()[1]

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      true,
    ],
    [
      "slice expressions recursively evaluate nested mutations",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = {"remaining": noisy, "discarded": quiet}
            values = [0]
            values[(decorators.popitem(), 0)[1]:]
            return decorators.popitem()[1]

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      true,
    ],
    [
      "eager comprehensions evaluate nested mutations",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = {"remaining": noisy, "discarded": quiet}
            [decorators.popitem() for _ in [0]]
            return decorators.popitem()[1]

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      true,
    ],
    [
      "generator bodies remain deferred at expression creation",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = {"remaining": noisy, "selected": quiet}
            (decorators.popitem() for _ in [0])
            return decorators.popitem()[1]

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      false,
    ],
    [
      "generator outer iterables evaluate at expression creation",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = {"remaining": noisy, "discarded": quiet}
            (None for _ in (decorators.popitem(), [0])[1])
            return decorators.popitem()[1]

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      true,
    ],
    [
      "false and short-circuits nested mutations",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = {"remaining": noisy, "selected": quiet}
            False and decorators.popitem()
            return decorators.popitem()[1]

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      false,
    ],
    [
      "true and evaluates its nested mutation",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = {"remaining": noisy, "discarded": quiet}
            True and decorators.popitem()
            return decorators.popitem()[1]

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      true,
    ],
    [
      "unknown short-circuit paths merge nested mutations conservatively",
      `def warning_factory(selector):
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = {"remaining": quiet, "selected": noisy}
            selector and decorators.popitem()
            return decorators.popitem()[1]

        @warning_factory(event_type)
        def deferred_warning() -> None:
            pass`,
      false,
    ],
    [
      "captured set self update preserves the warning decorator",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            decorators = {noisy}
            alias = decorators
            alias.update(alias)
            return decorators.pop()

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      true,
    ],
    [
      "captured set self difference_update preserves alias identity",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = {quiet}
            alias = decorators
            alias.difference_update(alias)
            alias.add(noisy)
            return decorators.pop()

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      true,
    ],
    [
      "captured set self intersection_update preserves alias identity",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = {quiet}
            alias = decorators
            alias.intersection_update(alias)
            alias.clear()
            alias.add(noisy)
            return decorators.pop()

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      true,
    ],
    [
      "captured set self symmetric_difference_update preserves alias identity",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = {quiet}
            alias = decorators
            alias.symmetric_difference_update(alias)
            alias.add(noisy)
            return decorators.pop()

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      true,
    ],
    [
      "set difference_update uses the receiver after nested alias mutation",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = {quiet}
            receiver = decorators
            argument_alias = decorators
            receiver.difference_update(
                argument_alias,
                (
                    argument_alias.add(noisy),
                    {quiet},
                )[1],
            )
            return noisy if decorators or receiver or argument_alias else quiet

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      false,
    ],
    [
      "set mutators retain the bound receiver when arguments rebind its name",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = {noisy}
            receiver = decorators
            receiver.difference_update(
                (receiver := {noisy})
            )
            return noisy if decorators else quiet

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      false,
    ],
    [
      "set intersection_update preserves self arguments through later mutation",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = {quiet}
            receiver = decorators
            argument_alias = decorators
            receiver.intersection_update(
                argument_alias,
                (
                    argument_alias.add(noisy),
                    {noisy},
                )[1],
            )
            return decorators.pop()

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      true,
    ],
    [
      "set symmetric_difference_update uses the receiver after nested alias mutation",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = {quiet}
            receiver = decorators
            argument_alias = decorators
            receiver.symmetric_difference_update(
                (
                    argument_alias.clear(),
                    argument_alias.add(noisy),
                    argument_alias,
                )[2]
            )
            return noisy if decorators or receiver or argument_alias else quiet

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      false,
    ],
    [
      "list append uses the receiver after nested alias mutation",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = [quiet]
            receiver = decorators
            argument_alias = decorators
            receiver.append(
                (
                    argument_alias.clear(),
                    noisy,
                )[1]
            )
            return decorators[0]

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      true,
    ],
    [
      "list extend preserves self arguments through nested alias mutation",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = [quiet]
            receiver = decorators
            argument_alias = decorators
            receiver.extend(
                (
                    argument_alias.clear(),
                    argument_alias.append(noisy),
                    argument_alias,
                )[2]
            )
            return decorators[1]

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      true,
    ],
    [
      "dict setdefault uses the receiver after nested alias mutation",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = {"selected": quiet}
            receiver = decorators
            argument_alias = decorators
            receiver.setdefault(
                "selected",
                (
                    argument_alias.clear(),
                    noisy,
                )[1],
            )
            return decorators["selected"]

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      true,
    ],
    [
      "dict update preserves self arguments through nested alias mutation",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = {"selected": quiet}
            receiver = decorators
            argument_alias = decorators
            receiver.update(
                (
                    argument_alias.clear(),
                    argument_alias.setdefault("selected", noisy),
                    argument_alias,
                )[2]
            )
            return decorators["selected"]

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      true,
    ],
    [
      "set update executes a nested helper that selects the warning decorator",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = {quiet}
            receiver = decorators
            alias = decorators

            def select():
                alias.clear()
                return {noisy}

            receiver.update(select())
            return decorators.pop()

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      true,
    ],
    [
      "set update executes a nested helper that selects the quiet decorator",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = {noisy}
            receiver = decorators
            alias = decorators

            def reset():
                alias.clear()
                return {quiet}

            receiver.update(reset())
            return decorators.pop()

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      false,
    ],
    [
      "set update retains its receiver when a nested helper rebinds that name",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = {quiet}
            receiver = decorators
            alias = decorators

            def select():
                nonlocal receiver
                alias.clear()
                receiver = {quiet}
                return {noisy}

            receiver.update(select())
            return decorators.pop()

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      true,
    ],
    [
      "set update does not follow a helper-rebound receiver name",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = {noisy}
            receiver = decorators
            alias = decorators

            def reset():
                nonlocal receiver
                alias.clear()
                receiver = {noisy}
                return {quiet}

            receiver.update(reset())
            return decorators.pop()

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      false,
    ],
    [
      "set update retains an earlier self argument across a later helper mutation",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = {quiet}
            receiver = decorators
            alias = decorators

            def select():
                alias.clear()
                return {noisy}

            receiver.update(alias, select())
            return decorators.pop()

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      true,
    ],
    [
      "set update retains an earlier self argument when a helper selects quiet",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = {noisy}
            receiver = decorators
            alias = decorators

            def reset():
                alias.clear()
                return {quiet}

            receiver.update(alias, reset())
            return decorators.pop()

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      false,
    ],
    [
      "list append executes a nested helper that selects the warning decorator",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = [quiet]
            receiver = decorators
            alias = decorators

            def select():
                alias.clear()
                return noisy

            receiver.append(select())
            return decorators[0]

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      true,
    ],
    [
      "list append executes a nested helper that selects the quiet decorator",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = [noisy]
            receiver = decorators
            alias = decorators

            def reset():
                alias.clear()
                return quiet

            receiver.append(reset())
            return decorators[0]

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      false,
    ],
    [
      "list extend preserves helper argument identity for the warning decorator",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = [quiet]
            receiver = decorators
            alias = decorators

            def select(values):
                values.clear()
                values.append(noisy)
                return values

            receiver.extend(select(alias))
            return decorators[1]

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      true,
    ],
    [
      "list extend preserves helper argument identity for the quiet decorator",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = [noisy]
            receiver = decorators
            alias = decorators

            def reset(values):
                values.clear()
                values.append(quiet)
                return values

            receiver.extend(reset(alias))
            return decorators[1]

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      false,
    ],
    [
      "dict setdefault evaluates a nested helper before preserving an existing key",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = {"selected": quiet}
            receiver = decorators
            alias = decorators

            def select():
                alias.update(selected=noisy)
                return quiet

            receiver.setdefault("selected", select())
            return decorators["selected"]

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      true,
    ],
    [
      "dict setdefault keeps a quiet value selected by its nested helper",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = {"selected": noisy}
            receiver = decorators
            alias = decorators

            def reset():
                alias.update(selected=quiet)
                return noisy

            receiver.setdefault("selected", reset())
            return decorators["selected"]

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      false,
    ],
    [
      "dict update preserves a nested helper self argument for the warning decorator",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = {"selected": quiet}
            receiver = decorators
            alias = decorators

            def select(values):
                values.clear()
                values.setdefault("selected", noisy)
                return values

            receiver.update(select(alias))
            return decorators["selected"]

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      true,
    ],
    [
      "dict update preserves a nested helper self argument for the quiet decorator",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = {"selected": noisy}
            receiver = decorators
            alias = decorators

            def reset(values):
                values.clear()
                values.setdefault("selected", quiet)
                return values

            receiver.update(reset(alias))
            return decorators["selected"]

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      false,
    ],
    [
      "raised sibling helper stops later nested mutator arguments after warning selection",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = {quiet}
            receiver = decorators
            alias = decorators

            def stop():
                alias.clear()
                alias.add(noisy)
                raise ValueError("stop")

            def late():
                alias.clear()
                alias.add(quiet)
                return alias

            try:
                receiver.update(stop(), late())
            except ValueError:
                pass
            return decorators.pop()

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      true,
    ],
    [
      "raised sibling helper stops later nested mutator arguments after quiet selection",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = {noisy}
            receiver = decorators
            alias = decorators

            def stop():
                alias.clear()
                alias.add(quiet)
                raise ValueError("stop")

            def late():
                alias.clear()
                alias.add(noisy)
                return alias

            try:
                receiver.update(stop(), late())
            except ValueError:
                pass
            return decorators.pop()

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      false,
    ],
    [
      "branching nested helper preserves warning outcomes across return and raise",
      `def warning_factory(selector):
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = {quiet}
            receiver = decorators
            alias = decorators

            def select(flag):
                alias.clear()
                if flag:
                    return {noisy}
                alias.add(noisy)
                raise ValueError("stop")

            try:
                receiver.update(select(selector))
            except ValueError:
                pass
            return decorators.pop()

        @warning_factory(event_type)
        def deferred_warning() -> None:
            pass`,
      true,
    ],
    [
      "branching nested helper preserves quiet outcomes across return and raise",
      `def warning_factory(selector):
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = {noisy}
            receiver = decorators
            alias = decorators

            def reset(flag):
                alias.clear()
                if flag:
                    return {quiet}
                alias.add(quiet)
                raise ValueError("stop")

            try:
                receiver.update(reset(selector))
            except ValueError:
                pass
            return decorators.pop()

        @warning_factory(event_type)
        def deferred_warning() -> None:
            pass`,
      false,
    ],
    [
      "passing a deferred local helper does not execute it",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = [noisy]
            receiver = decorators
            alias = decorators

            def reset():
                alias.clear()
                alias.append(quiet)

            receiver.append(reset)
            return decorators[0]

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      true,
    ],
    [
      "unknown nested callables that receive aliases fail closed",
      `def warning_factory(callback):
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            decorators = [noisy]
            receiver = decorators
            alias = decorators
            receiver.append(callback(alias))
            return decorators[0]

        @warning_factory(event_type)
        def deferred_warning() -> None:
            pass`,
      false,
    ],
    [
      "starred helper arguments preserve mutable aliases",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = [quiet]
            alias = decorators
            packed = (alias,)

            def select(values):
                values.clear()
                values.append(noisy)
                return values[0]

            return select(*packed)

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      true,
    ],
    [
      "double-starred helper arguments bind kwargs without disconnecting values",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = [noisy]
            options = {"values": decorators}

            def reset(**kwargs):
                values = kwargs["values"]
                values.clear()
                values.append(quiet)
                return values[0]

            return reset(**options)

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      false,
    ],
    [
      "starred and double-starred helper operands retain Python evaluation order",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = [quiet]
            alias = decorators

            def select(values, *, marker):
                return values[0]

            def later():
                alias.clear()
                alias.append(noisy)
                return {"marker": None}

            return select(*(alias,), **later())

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      true,
    ],
    [
      "unresolved starred helper operands do not execute the helper",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = [noisy]

            def reset(value):
                decorators.clear()
                decorators.append(quiet)
                return quiet

            reset(*event_type)
            return decorators[0]

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      true,
    ],
    [
      "unresolved helper operands invalidate aliases on reachable conditional paths",
      `def warning_factory(selector):
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            decorators = [noisy]

            def observe(*values):
                return None

            observe(*(decorators if selector else selector))
            return decorators[0]

        @warning_factory(event_type)
        def deferred_warning() -> None:
            pass`,
      false,
    ],
    [
      "unresolved helper operands ignore aliases on unreachable conditional paths",
      `def warning_factory(selector):
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            decorators = [noisy]

            def observe(*values):
                return None

            observe(*(decorators if False else selector))
            return decorators[0]

        @warning_factory(event_type)
        def deferred_warning() -> None:
            pass`,
      true,
    ],
    [
      "unresolved double-starred helper operands invalidate nested aliases",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            decorators = [noisy]
            options = {"values": decorators}

            def observe(**kwargs):
                return None

            observe(**options[event_type])
            return decorators[0]

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      false,
    ],
    [
      "unknown calls invalidate mutable aliases nested through containers",
      `def warning_factory(callback):
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            decorators = [noisy]
            nested = ({"payload": [decorators]},)
            callback(nested)
            return decorators[0]

        @warning_factory(event_type)
        def deferred_warning() -> None:
            pass`,
      false,
    ],
    [
      "unknown calls invalidate nested set aliases",
      `def warning_factory(callback):
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            decorators = {noisy}
            callback((decorators,))
            return decorators.pop()

        @warning_factory(event_type)
        def deferred_warning() -> None:
            pass`,
      false,
    ],
    [
      "unknown calls inspect starred and double-starred argument containers",
      `def warning_factory(callback):
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            decorators = [noisy]
            callback(*({"payload": (decorators,)},))
            callback(**{"payload": {"nested": decorators}})
            return decorators[0]

        @warning_factory(event_type)
        def deferred_warning() -> None:
            pass`,
      false,
    ],
    [
      "unknown calls inspect attribute and subscript arguments",
      `def warning_factory(callback):
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            decorators = [noisy]
            wrapper = {"payload": decorators}
            callback(decorators.clear)
            callback(wrapper["payload"])
            return decorators[0]

        @warning_factory(event_type)
        def deferred_warning() -> None:
            pass`,
      false,
    ],
    [
      "captured set alias methods select the quiet decorator",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = {noisy}
            alias = decorators

            def reset():
                alias.clear()
                alias.add(quiet)

            reset()
            return decorators.pop()

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      false,
    ],
    [
      "captured set alias methods select the warning decorator",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = {quiet}
            alias = decorators

            def select():
                alias.clear()
                alias.add(noisy)

            select()
            return decorators.pop()

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      true,
    ],
    [
      "nonmutating helper argument preserves the warning decorator",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            decorators = [noisy]
            alias = decorators

            def observe(values):
                pass

            observe(alias)
            return decorators[0]

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      true,
    ],
    [
      "unsupported collection mutation fails closed",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = [noisy]
            decorators[0] = quiet
            return decorators[0]

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      false,
    ],
    [
      "unknown helper mutation fails closed",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            def mutate(decorators):
                decorators[0] = quiet

            decorators = [noisy]
            mutate(decorators)
            return decorators[0]

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      false,
    ],
    [
      "unrelated attribute mutation preserves selected decorator",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            class Holder:
                pass

            holder = Holder()
            holder.selected = None
            return noisy

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      true,
    ],
    [
      "handled raise returns the quiet decorator",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            try:
                raise ValueError("select quiet")
            except ValueError:
                return quiet
            return noisy

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      false,
    ],
    [
      "raise arguments apply warning mutations before the handler",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = {quiet}
            alias = decorators

            def select():
                alias.clear()
                alias.add(noisy)
                return "selected"

            try:
                raise ValueError(select())
            except ValueError:
                pass
            return decorators.pop()

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      true,
    ],
    [
      "raise helpers may return the handled exception after mutating aliases",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = {quiet}
            alias = decorators

            def make_error():
                alias.clear()
                alias.add(noisy)
                return ValueError("selected")

            try:
                raise make_error()
            except ValueError:
                pass
            return decorators.pop()

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      true,
    ],
    [
      "an exception raised by an earlier raise argument skips later arguments",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = {quiet}
            alias = decorators

            def stop():
                alias.clear()
                alias.add(noisy)
                raise TypeError("stop")

            def late():
                alias.clear()
                alias.add(quiet)
                return "late"

            try:
                raise ValueError(stop(), late())
            except (TypeError, ValueError):
                pass
            return decorators.pop()

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      true,
    ],
    [
      "compound raise expressions stop after a warning-selecting helper raises",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = {quiet}
            alias = decorators

            def stop():
                alias.clear()
                alias.add(noisy)
                raise TypeError("stop")

            def late():
                alias.clear()
                alias.add(quiet)
                return ValueError("late")

            try:
                raise (stop(), late())[0]
            except (TypeError, ValueError):
                pass
            return decorators.pop()

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      true,
    ],
    [
      "compound raise expressions stop after a quiet-selecting helper raises",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = {noisy}
            alias = decorators

            def stop():
                alias.clear()
                alias.add(quiet)
                raise TypeError("stop")

            def late():
                alias.clear()
                alias.add(noisy)
                return ValueError("late")

            try:
                raise (stop(), late())[0]
            except (TypeError, ValueError):
                pass
            return decorators.pop()

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      false,
    ],
    [
      "compound raise causes stop after a warning-selecting helper raises",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = {quiet}
            alias = decorators

            def stop():
                alias.clear()
                alias.add(noisy)
                raise TypeError("stop")

            def late():
                alias.clear()
                alias.add(quiet)
                return RuntimeError("late")

            try:
                raise ValueError("outer") from (stop(), late())[0]
            except (TypeError, ValueError):
                pass
            return decorators.pop()

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      true,
    ],
    [
      "compound raise causes stop after a quiet-selecting helper raises",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = {noisy}
            alias = decorators

            def stop():
                alias.clear()
                alias.add(quiet)
                raise TypeError("stop")

            def late():
                alias.clear()
                alias.add(noisy)
                return RuntimeError("late")

            try:
                raise ValueError("outer") from (stop(), late())[0]
            except (TypeError, ValueError):
                pass
            return decorators.pop()

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      false,
    ],
    [
      "raise causes evaluate after the exception expression",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = {quiet}
            alias = decorators

            def select():
                alias.clear()
                alias.add(noisy)
                return "selected"

            try:
                raise ValueError("outer") from RuntimeError(select())
            except ValueError:
                pass
            return decorators.pop()

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      true,
    ],
    [
      "finally return overrides the quiet decorator",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            try:
                return quiet
            finally:
                return noisy

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      true,
    ],
    [
      "with return makes later noisy decorator unreachable",
      `def warning_factory():
            from contextlib import nullcontext

            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            with nullcontext():
                return quiet
            return noisy

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      false,
    ],
    [
      "matching case returns the quiet decorator",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            match "quiet":
                case "quiet":
                    return quiet
                case _:
                    return noisy
            return noisy

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      false,
    ],
    [
      "matching case returns the warning decorator",
      `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            match "noisy":
                case "noisy":
                    return noisy
                case _:
                    return quiet
            return quiet

        @warning_factory()
        def deferred_warning() -> None:
            pass`,
      true,
    ],
  ]) {
    assert.equal(
      evaluateRule(
        "prompt/event-routing",
        replaceFallbacks(factory, factory),
      ),
      expected,
      label,
    );
  }

  const abruptExpressions = [
    "(stop(), late())[0]",
    "[stop(), late()]",
    "{stop(), late()}",
    "{stop(): late()}",
    "stop() + late()",
    "stop() < late()",
    "stop() and late()",
    "late() if stop() else late()",
    'f"{stop()}{late()}"',
    'f"{0:{stop()}{late()}}"',
    "[0][stop():late()]",
    "str(stop(), late())",
    "stop()(late())",
    "(lambda value=stop(): late(), late())",
    "[late() for _ in stop()]",
    "[late() for _ in [0] if stop()]",
    "[stop() + late() for _ in [0]]",
    "{stop(): late() for _ in [0]}",
    "[late() for _ in [0] for _ in stop()]",
  ];
  const abruptFactory = (initial, selected, delayed) => `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = {${initial}}
            alias = decorators

            def stop():
                alias.clear()
                alias.add(${selected})
                raise TypeError("stop")

            def late():
                alias.clear()
                alias.add(${delayed})
                return 1

${abruptExpressions
  .map(
    (expression) => `            try:
                ${expression}
            except TypeError:
                pass`,
  )
  .join("\n\n")}
            return decorators.pop()

        @warning_factory()
        def deferred_warning() -> None:
            pass`;
  for (const [label, factory, expected] of [
    [
      "compound expressions stop after a warning-selecting abrupt helper",
      abruptFactory("quiet", "noisy", "quiet"),
      true,
    ],
    [
      "compound expressions stop after a quiet-selecting abrupt helper",
      abruptFactory("noisy", "quiet", "noisy"),
      false,
    ],
  ]) {
    assert.equal(
      evaluateRule(
        "prompt/event-routing",
        replaceFallbacks(factory, factory),
      ),
      expected,
      label,
    );
  }

  const deferredDecoratedBody = `def quiet_factory():
            def decorate(definition):
                return definition
            return decorate

        @quiet_factory()
        def deferred_warning() -> None:
            logger.warning(
                "Unrecognized Event Grid event type: %s", event_type)`;
  assert.equal(
    evaluateRule(
      "prompt/event-routing",
      replaceFallbacks(deferredDecoratedBody, deferredDecoratedBody),
    ),
    false,
    "decorated body remains deferred",
  );
});

test("factory comprehensions and abrupt expressions preserve Python order", () => {
  const warning =
    'logger.warning("Unrecognized Event Grid event type: %s", event_type)';
  const factoryWorkspace = (factory) => {
    let candidate = replaceDocument(
      "event_receiver.py",
      warning,
      "__SYNC_FALLBACK_WARNING__",
    );
    candidate = replaceDocument(
      "event_receiver.py",
      warning,
      "__ASYNC_FALLBACK_WARNING__",
      candidate.documents,
    );
    candidate = replaceDocument(
      "event_receiver.py",
      "__SYNC_FALLBACK_WARNING__",
      factory,
      candidate.documents,
    );
    return replaceDocument(
      "event_receiver.py",
      "__ASYNC_FALLBACK_WARNING__",
      factory,
      candidate.documents,
    );
  };
  const warningFactory = (initial, selected, operation) => `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            first = {${initial}}
            second = {${initial}}
            selector = [first, second]

            def update(value):
                value.clear()
                value.add(${selected})
                return 0

${operation}
            return first.pop()

        @warning_factory()
        def deferred_warning() -> None:
            pass`;

  const comprehensionOperations = [
    `            values = [selector.pop(0) for _ in [0, 1]]
            for value in values:
                update(value)`,
    `            def apply(values):
                for value in values:
                    update(value)

            apply([selector.pop(0) for _ in [0, 1]])`,
    `            def apply(values):
                for value in values:
                    update(value)

            apply([
                selector.pop(0)
                for flag in [event_type, True]
                if flag
            ])`,
    `            values = {
                index: selector.pop(0) for index in [0, 1]
            }
            for index in [0, 1]:
                update(values[index])`,
    "            {update(selector.pop(0)) for _ in [0, 1]}",
  ];
  for (const [label, initial, selected, expected] of [
    ["select warning aliases", "quiet", "noisy", true],
    ["select quiet aliases", "noisy", "quiet", false],
  ]) {
    for (const [index, operation] of comprehensionOperations.entries()) {
      assert.equal(
        evaluateRule(
          "prompt/event-routing",
          factoryWorkspace(warningFactory(initial, selected, operation)),
        ),
        expected,
        `comprehension ${index}: ${label}`,
      );
    }
  }
  for (const [label, initial, selected, expected] of [
    ["warning generator body is deferred", "noisy", "quiet", true],
    ["quiet generator body is deferred", "quiet", "noisy", false],
  ]) {
    assert.equal(
      evaluateRule(
        "prompt/event-routing",
        factoryWorkspace(
          warningFactory(
            initial,
            selected,
            "            (update(selector.pop(0)) for _ in [0, 1])",
          ),
        ),
      ),
      expected,
      label,
    );
  }

  const subscriptFactory = (
    initial,
    selected,
    delayed,
    container,
    index,
    exception,
    wrongException,
  ) => `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = {${initial}}
            alias = decorators

            def select():
                alias.clear()
                alias.add(${selected})
                return ${container}

            def late():
                alias.clear()
                alias.add(${delayed})
                return 0

            try:
                (select()[${index}], late())
            except ${wrongException}:
                late()
            except ${exception}:
                pass
            return decorators.pop()

        @warning_factory()
        def deferred_warning() -> None:
            pass`;
  const subscriptFailures = [
    ["index", "[]", "0", "IndexError", "KeyError"],
    ["key", "{}", '"missing"', "KeyError", "IndexError"],
    ["index type", "[0]", '"invalid"', "TypeError", "KeyError"],
    ["zero slice step", "[0, 1]", "::0", "ValueError", "TypeError"],
    ["unsupported container", "1", "0", "TypeError", "KeyError"],
  ];
  for (const [label, initial, selected, delayed, expected] of [
    ["warning survives", "quiet", "noisy", "quiet", true],
    ["quiet survives", "noisy", "quiet", "noisy", false],
  ]) {
    for (const [
      failure,
      container,
      index,
      exception,
      wrongException,
    ] of subscriptFailures) {
      assert.equal(
        evaluateRule(
          "prompt/event-routing",
          factoryWorkspace(
            subscriptFactory(
              initial,
              selected,
              delayed,
              container,
              index,
              exception,
              wrongException,
            ),
          ),
        ),
        expected,
        `${failure} failure ${label}`,
      );
    }
  }
  for (const [label, initial, selected, delayed, expected] of [
    ["valid subscript continues to warning", "quiet", "quiet", "noisy", true],
    ["valid subscript continues to quiet", "noisy", "noisy", "quiet", false],
  ]) {
    assert.equal(
      evaluateRule(
        "prompt/event-routing",
        factoryWorkspace(
          subscriptFactory(
            initial,
            selected,
            delayed,
            "[0]",
            "0",
            "IndexError",
            "KeyError",
          ),
        ),
      ),
      expected,
      label,
    );
  }

  for (const [label, decorators, expected] of [
    ["built-in slice selects warning", "[quiet, noisy]", true],
    ["built-in slice selects quiet", "[noisy, quiet]", false],
  ]) {
    const factory = `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = ${decorators}
            return decorators[slice(1, 2)][0]

        @warning_factory()
        def deferred_warning() -> None:
            pass`;
    assert.equal(
      evaluateRule("prompt/event-routing", factoryWorkspace(factory)),
      expected,
      label,
    );
  }

  const zeroStepSliceFactory = (
    initial,
    startSelection,
    stopSelection,
    stepSelection,
    lateSelection,
  ) => `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = {${initial}}
            alias = decorators

            def select(value, definition):
                alias.clear()
                alias.add(definition)
                return value

            try:
                [0, 1][slice(
                    select(0, ${startSelection}),
                    select(2, ${stopSelection}),
                    select(0, ${stepSelection}),
                )]
                alias.clear()
                alias.add(${lateSelection})
            except ValueError:
                pass
            return decorators.pop()

        @warning_factory()
        def deferred_warning() -> None:
            pass`;
  for (const [label, values, expected] of [
    [
      "zero-step slice raises after left-to-right warning selection",
      ["quiet", "quiet", "quiet", "noisy", "quiet"],
      true,
    ],
    [
      "zero-step slice raises after left-to-right quiet selection",
      ["noisy", "noisy", "noisy", "quiet", "noisy"],
      false,
    ],
  ]) {
    assert.equal(
      evaluateRule(
        "prompt/event-routing",
        factoryWorkspace(zeroStepSliceFactory(...values)),
      ),
      expected,
      label,
    );
  }

  for (const constructor of ["slice", "list", "tuple", "set", "dict"]) {
    const shadowedConstructor = `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            def ${constructor}(*values):
                return 0

            decorators = [noisy, quiet]
            return decorators[${constructor}(1, 2)]

        @warning_factory()
        def deferred_warning() -> None:
            pass`;
    assert.equal(
      evaluateRule(
        "prompt/event-routing",
        factoryWorkspace(shadowedConstructor),
      ),
      true,
      `local ${constructor} callable shadows the built-in constructor`,
    );
  }

  const enclosingSliceShadow = `def slice(*values):
            return 0

        def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = [quiet, noisy]
            return decorators[slice(1, 2)][0]

        @warning_factory()
        def deferred_warning() -> None:
            pass`;
  assert.equal(
    evaluateRule(
      "prompt/event-routing",
      factoryWorkspace(enclosingSliceShadow),
    ),
    false,
    "an enclosing local slice callable is not treated as the builtin",
  );

  const raiseFactory = (
    initial,
    selected,
    delayed,
    raiseExpression,
    handledException,
  ) => `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = {${initial}}
            alias = decorators

            def select(value):
                alias.clear()
                alias.add(${selected})
                return value

            def late():
                alias.clear()
                alias.add(${delayed})

            try:
                ${raiseExpression}
            except ValueError:
                ${handledException === "ValueError" ? "pass" : "late()"}
            except TypeError:
                ${handledException === "TypeError" ? "pass" : "late()"}
            return decorators.pop()

        @warning_factory()
        def deferred_warning() -> None:
            pass`;
  for (const [label, initial, selected, delayed, expected] of [
    ["warning selection", "quiet", "noisy", "quiet", true],
    ["quiet selection", "noisy", "quiet", "noisy", false],
  ]) {
    for (const [raiseLabel, raiseExpression, handledException] of [
      ["invalid exception", "raise select(1)", "TypeError"],
      [
        "invalid cause",
        'raise ValueError("outer") from select("invalid")',
        "TypeError",
      ],
      [
        "None cause",
        'raise select(ValueError("outer")) from None',
        "ValueError",
      ],
      ["exception class", "raise select(ValueError)", "ValueError"],
      [
        "exception instance cause",
        'raise select(ValueError("outer")) from RuntimeError("cause")',
        "ValueError",
      ],
      [
        "exception class cause",
        'raise select(ValueError("outer")) from RuntimeError',
        "ValueError",
      ],
    ]) {
      assert.equal(
        evaluateRule(
          "prompt/event-routing",
          factoryWorkspace(
            raiseFactory(
              initial,
              selected,
              delayed,
              raiseExpression,
              handledException,
            ),
          ),
        ),
        expected,
        `${raiseLabel}: ${label}`,
      );
    }
  }

  const orderedCauseFactory = (
    initial,
    exceptionSelection,
    causeSelection,
  ) => `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = {${initial}}
            alias = decorators

            def make_exception():
                alias.clear()
                alias.add(${exceptionSelection})
                return ValueError("outer")

            def make_invalid_cause():
                alias.clear()
                alias.add(${causeSelection})
                return "invalid"

            try:
                raise make_exception() from make_invalid_cause()
            except ValueError:
                alias.clear()
            except TypeError:
                pass
            return decorators.pop()

        @warning_factory()
        def deferred_warning() -> None:
            pass`;
  for (const [label, initial, exceptionSelection, causeSelection, expected] of [
    ["invalid warning cause runs last", "quiet", "quiet", "noisy", true],
    ["invalid quiet cause runs last", "noisy", "noisy", "quiet", false],
  ]) {
    assert.equal(
      evaluateRule(
        "prompt/event-routing",
        factoryWorkspace(
          orderedCauseFactory(initial, exceptionSelection, causeSelection),
        ),
      ),
      expected,
      label,
    );
  }

  const localExceptionFactory = (
    initial,
    selected,
    delayed,
    definitions,
    raiseExpression,
    handledException,
  ) => `def warning_factory():
            def noisy(definition):
                logger.warning(
                    "Unrecognized Event Grid event type: %s", event_type)
                return definition

            def quiet(definition):
                return definition

            decorators = {${initial}}
            alias = decorators

            def select(value):
                alias.clear()
                alias.add(${selected})
                return value

            def late():
                alias.clear()
                alias.add(${delayed})

${definitions}

            try:
                ${raiseExpression}
            except ValueError:
                ${handledException === "ValueError" ? "pass" : "late()"}
            except TypeError:
                ${handledException === "TypeError" ? "pass" : "late()"}
            return decorators.pop()

        @warning_factory()
        def deferred_warning() -> None:
            pass`;
  const validDefinitions = `            class ErrorBase(ValueError):
                pass

            BaseAlias = ErrorBase

            class LocalError(BaseAlias):
                pass

            ErrorAlias = LocalError`;
  const invalidDefinitions = `            class ErrorBase:
                pass

            BaseAlias = ErrorBase

            class LocalError(BaseAlias):
                pass

            ErrorAlias = LocalError`;
  const validQualifiedDefinitions = `            class Namespace:
                class ErrorBase(ValueError):
                    pass

                BaseAlias = ErrorBase

                class LocalError(BaseAlias):
                    pass

                ErrorAlias = LocalError

            NamespaceAlias = Namespace`;
  const invalidQualifiedDefinitions = `            class Namespace:
                class ValueError:
                    pass

                ErrorAlias = ValueError

            NamespaceAlias = Namespace`;
  const builtinAttributeDefinitions = `            class Namespace:
                ErrorAlias = ValueError`;
  for (const [label, initial, selected, delayed, expected] of [
    ["warning selection", "quiet", "noisy", "quiet", true],
    ["quiet selection", "noisy", "quiet", "noisy", false],
  ]) {
    for (const [
      raiseLabel,
      definitions,
      raiseExpression,
      handledException,
    ] of [
      [
        "valid local exception instance inherits through aliases",
        validDefinitions,
        'raise select(ErrorAlias("boom"))',
        "ValueError",
      ],
      [
        "valid local exception class inherits through aliases",
        validDefinitions,
        "raise select(ErrorAlias)",
        "ValueError",
      ],
      [
        "invalid local exception instance becomes TypeError",
        invalidDefinitions,
        "raise select(ErrorAlias())",
        "TypeError",
      ],
      [
        "invalid local exception class becomes TypeError",
        invalidDefinitions,
        "raise select(ErrorAlias)",
        "TypeError",
      ],
      [
        "valid local cause instance is accepted",
        validDefinitions,
        'raise select(ValueError("outer")) from ErrorAlias("cause")',
        "ValueError",
      ],
      [
        "valid local cause class is accepted",
        validDefinitions,
        'raise select(ValueError("outer")) from ErrorAlias',
        "ValueError",
      ],
      [
        "invalid local cause instance becomes TypeError",
        invalidDefinitions,
        'raise select(ValueError("outer")) from ErrorAlias()',
        "TypeError",
      ],
      [
        "invalid local cause class becomes TypeError",
        invalidDefinitions,
        'raise select(ValueError("outer")) from ErrorAlias',
        "TypeError",
      ],
      [
        "valid nested exception instance inherits through class attributes",
        validQualifiedDefinitions,
        'raise select(Namespace.ErrorAlias("boom"))',
        "ValueError",
      ],
      [
        "valid nested exception class inherits through namespace aliases",
        validQualifiedDefinitions,
        "raise select(NamespaceAlias.ErrorAlias)",
        "ValueError",
      ],
      [
        "qualified builtin alias resolves its actual class",
        builtinAttributeDefinitions,
        "raise select(Namespace.ErrorAlias)",
        "ValueError",
      ],
      [
        "qualified class named ValueError is not the builtin exception",
        invalidQualifiedDefinitions,
        'raise select(Namespace.ValueError("boom"))',
        "TypeError",
      ],
      [
        "qualified invalid class follows namespace aliases",
        invalidQualifiedDefinitions,
        "raise select(NamespaceAlias.ErrorAlias)",
        "TypeError",
      ],
      [
        "bare alias of a qualified invalid class remains shadowed",
        `${invalidQualifiedDefinitions}

            ValueError = Namespace.ErrorAlias`,
        "raise select(ValueError)",
        "TypeError",
      ],
      [
        "valid nested cause class is accepted",
        validQualifiedDefinitions,
        'raise select(ValueError("outer")) from NamespaceAlias.ErrorAlias',
        "ValueError",
      ],
      [
        "invalid qualified cause instance becomes TypeError",
        invalidQualifiedDefinitions,
        'raise select(ValueError("outer")) from Namespace.ErrorAlias("cause")',
        "TypeError",
      ],
    ]) {
      assert.equal(
        evaluateRule(
          "prompt/event-routing",
          factoryWorkspace(
            localExceptionFactory(
              initial,
              selected,
              delayed,
              definitions,
              raiseExpression,
              handledException,
            ),
          ),
        ),
        expected,
        `${raiseLabel}: ${label}`,
      );
    }
  }
});

test("standard-library warning aliases and logger constructors are accepted", () => {
  let moduleAlias = replaceDocument(
    "event_receiver.py",
    "import logging",
    "import logging as std_logging",
  );
  moduleAlias = replaceDocument(
    "event_receiver.py",
    "logger = logging.getLogger(__name__)",
    "logger = std_logging.getLogger(__name__)",
    moduleAlias.documents,
  );
  assert.equal(evaluateRule("prompt/event-routing", moduleAlias), true);

  for (const [importLine, loggerLine] of [
    [
      "from logging import getLogger as make_logger",
      "logger = make_logger(__name__)",
    ],
    [
      "from logging import Logger as StandardLogger",
      "logger = StandardLogger(__name__)",
    ],
  ]) {
    let alias = replaceDocument(
      "event_receiver.py",
      "import logging",
      importLine,
    );
    alias = replaceDocument(
      "event_receiver.py",
      "logger = logging.getLogger(__name__)",
      loggerLine,
      alias.documents,
    );
    assert.equal(
      evaluateRule("prompt/event-routing", alias),
      true,
      importLine,
    );
  }

  for (const [importLine, call] of [
    ["import warnings as standard_warnings", "standard_warnings.warn("],
    ["from warnings import warn as emit_warning", "emit_warning("],
  ]) {
    let alias = replaceDocument(
      "event_receiver.py",
      "import logging",
      importLine,
    );
    alias = replaceDocument(
      "event_receiver.py",
      "logger.warning(",
      call,
      alias.documents,
    );
    alias = replaceDocument(
      "event_receiver.py",
      "logger.warning(",
      call,
      alias.documents,
    );
    assert.equal(
      evaluateRule("prompt/event-routing", alias),
      true,
      importLine,
    );
  }

  let standardError = replaceDocument(
    "event_receiver.py",
    "import logging",
    "import logging\nimport sys as standard_sys",
  );
  standardError = replaceDocument(
    "event_receiver.py",
    'logger.warning("Unrecognized Event Grid event type: %s", event_type)',
    'print(f"Unrecognized Event Grid event type: {event_type}", file=standard_sys.stderr)',
    standardError.documents,
  );
  standardError = replaceDocument(
    "event_receiver.py",
    'logger.warning("Unrecognized Event Grid event type: %s", event_type)',
    'print(f"Unrecognized Event Grid event type: {event_type}", file=standard_sys.stderr)',
    standardError.documents,
  );
  assert.equal(evaluateRule("prompt/event-routing", standardError), true);

  const localSys = workspaceWithDocuments([
    ...standardError.documents,
    {
      path: "sys.py",
      source: `class ErrorSink:
    def write(self, value):
        pass

stderr = ErrorSink()
`,
    },
  ]);
  assert.equal(evaluateRule("prompt/event-routing", localSys), false);
});

test("manual JSON parsing cannot supplement SDK deserialization", () => {
  const workspace = replaceDocument(
    "event_receiver.py",
    "for payload in payloads:\n        route_event(EventGridEvent.from_json(payload), blob_service_client)",
    "for payload in payloads:\n        __import__('json').loads(payload)\n        route_event(EventGridEvent.from_json(payload), blob_service_client)",
  );
  assert.equal(evaluateRule("prompt/sdk-event-deserialization", workspace), false);

  const directJson = replaceDocument(
    "event_receiver.py",
    "import logging",
    "import json\nimport logging",
  );
  const parsed = replaceDocument(
    "event_receiver.py",
    "for payload in payloads:\n        route_event(EventGridEvent.from_json(payload), blob_service_client)",
    "for payload in payloads:\n        json.loads(payload)\n        route_event(EventGridEvent.from_json(payload), blob_service_client)",
    directJson.documents,
  );
  assert.equal(evaluateRule("prompt/sdk-event-deserialization", parsed), false);
});

test("unreachable helpers and disconnected operations fail", () => {
  const unreachable = replaceDocument(
    "main.py",
    'if __name__ == "__main__":\n    main()',
    'if __name__ == "__main__":\n    print("application")',
  );
  for (const rule of sourceRules) {
    assert.equal(evaluateRule(rule, unreachable), false, rule);
  }

  const invertedGuard = replaceDocument(
    "main.py",
    'if __name__ == "__main__":\n    main()',
    'if __name__ != "__main__":\n    main()',
  );
  for (const rule of sourceRules) {
    assert.equal(evaluateRule(rule, invertedGuard), false, rule);
  }

  const disconnectedEvents = replaceDocument(
    "event_receiver.py",
    "route_event(EventGridEvent.from_json(payload), blob_service_client)",
    "EventGridEvent.from_json(payload)\n        route_event(payload, blob_service_client)",
  );
  assert.equal(
    evaluateRule("prompt/sdk-event-deserialization", disconnectedEvents),
    false,
  );

  const disconnectedBlob = replaceDocument(
    "blob_event_handler.py",
    "blob_service_client.get_blob_client(container, blob_name)",
    'blob_service_client.get_blob_client("other", "unrelated.txt")',
  );
  assert.equal(
    evaluateRule("prompt/blob-subject-and-summary", disconnectedBlob),
    false,
  );
});

test("equivalent executable main guards remain accepted", () => {
  const reversedGuard = replaceDocument(
    "main.py",
    'if __name__ == "__main__":\n    main()',
    'if "__main__" == __name__:\n    main()',
  );
  for (const rule of sourceRules) {
    assert.equal(evaluateRule(rule, reversedGuard), true, rule);
  }

  const systemExitGuard = replaceDocument(
    "main.py",
    'if __name__ == "__main__":\n    main()',
    'if __name__ == "__main__":\n    raise SystemExit(main())',
  );
  for (const rule of sourceRules) {
    assert.equal(evaluateRule(rule, systemExitGuard), true, rule);
  }
});

test("sync and async demos must share one executable ordered path", () => {
  const exclusive = replaceDocument(
    "main.py",
    "    run_sync_demo(settings)\n    asyncio.run(run_async_demo(settings))",
    `    if settings:
        run_sync_demo(settings)
    else:
        asyncio.run(run_async_demo(settings))`,
  );
  assert.equal(evaluateRule("prompt/async-implementations", exclusive), true);
  assert.equal(evaluateRule("prompt/ordered-demo-workflow", exclusive), false);

  let sequencedHelper = replaceDocument(
    "main.py",
    "\ndef main() -> None:\n",
    `
def run_full_demo(settings) -> None:
    run_sync_demo(settings)
    asyncio.run(run_async_demo(settings))


def main() -> None:
`,
  );
  sequencedHelper = replaceDocument(
    "main.py",
    "    run_sync_demo(settings)\n    asyncio.run(run_async_demo(settings))",
    "    run_full_demo(settings)",
    sequencedHelper.documents,
  );
  assert.equal(
    evaluateRule("prompt/ordered-demo-workflow", sequencedHelper),
    true,
  );
});

test("loop exits keep demo paths distinct and run else only without break", () => {
  const loopedDemo = (definition, invocation) => {
    let candidate = replaceDocument(
      "main.py",
      "\ndef main() -> None:\n",
      `\n${definition}\n\ndef main() -> None:\n`,
    );
    candidate = replaceDocument(
      "main.py",
      "    run_sync_demo(settings)\n    asyncio.run(run_async_demo(settings))",
      `    ${invocation}`,
      candidate.documents,
    );
    return candidate;
  };

  for (const [definition, invocation] of [
    [
      `def run_loop_demo(settings, values) -> None:
    for _ in values:
        if settings:
            run_sync_demo(settings)
            break
    else:
        asyncio.run(run_async_demo(settings))`,
      "run_loop_demo(settings, iter((settings,)))",
    ],
    [
      `def run_loop_demo(settings) -> None:
    for _ in (settings,):
        if settings:
            run_sync_demo(settings)
            return
    else:
        asyncio.run(run_async_demo(settings))`,
      "run_loop_demo(settings)",
    ],
    [
      `def run_loop_demo(settings) -> None:
    while settings:
        if settings:
            run_sync_demo(settings)
            break
        continue
    else:
        asyncio.run(run_async_demo(settings))`,
      "run_loop_demo(settings)",
    ],
  ]) {
    assert.equal(
      evaluateRule(
        "prompt/ordered-demo-workflow",
        loopedDemo(definition, invocation),
      ),
      false,
      invocation,
    );
  }

  for (const definition of [
    `def run_loop_demo(settings) -> None:
    for _ in (settings,):
        run_sync_demo(settings)
    else:
        asyncio.run(run_async_demo(settings))`,
    `def run_loop_demo(settings) -> None:
    for _ in (settings,):
        if settings:
            run_sync_demo(settings)
            continue
        return
    else:
        asyncio.run(run_async_demo(settings))`,
    `def run_loop_demo(settings) -> None:
    keep_running = True
    while keep_running:
        run_sync_demo(settings)
        keep_running = False
    else:
        asyncio.run(run_async_demo(settings))`,
  ]) {
    assert.equal(
      evaluateRule(
        "prompt/ordered-demo-workflow",
        loopedDemo(definition, "run_loop_demo(settings)"),
      ),
      true,
      definition,
    );
  }
});

test("demo samples require complete parsed schemas connected to receivers", () => {
  const missingEventGridField = replaceDocument(
    "main.py",
    '"dataVersion":"1","metadataVersion":"1","topic":"/subscriptions/example"}',
    '"dataVersion":"1","metadataVersion":"1","notTopic":"/subscriptions/example"}',
  );
  assert.equal(
    evaluateRule("prompt/ordered-demo-workflow", missingEventGridField),
    false,
  );

  const missingCloudField = replaceDocument(
    "main.py",
    '"specversion":"1.0","id":"ce-created","source":"/subscriptions/example",',
    '"specversion":"1.0","id":"ce-created","notSource":"/subscriptions/example",',
  );
  assert.equal(
    evaluateRule("prompt/ordered-demo-workflow", missingCloudField),
    false,
  );

  let disconnected = replaceDocument(
    "main.py",
    "\ndef run_sync_demo(settings) -> None:\n",
    `
def replay_sync_decoys(blob_service_client) -> None:
    for payload in EVENT_GRID_PAYLOADS:
        route_event(EventGridEvent.from_json(payload), blob_service_client)
    for payload in CLOUD_EVENT_PAYLOADS:
        route_event(CloudEvent.from_json(payload), blob_service_client)


async def replay_async_decoys(blob_service_client) -> None:
    for payload in EVENT_GRID_PAYLOADS:
        await route_event_async(EventGridEvent.from_json(payload), blob_service_client)
    for payload in CLOUD_EVENT_PAYLOADS:
        await route_event_async(CloudEvent.from_json(payload), blob_service_client)


def run_sync_demo(settings) -> None:
`,
  );
  disconnected = replaceDocument(
    "main.py",
    "from event_receiver import (\n",
    "from azure.core.messaging import CloudEvent\nfrom azure.eventgrid import EventGridEvent\n\nfrom event_receiver import (\n    route_event,\n    route_event_async,\n",
    disconnected.documents,
  );
  disconnected = replaceDocument(
    "main.py",
    "            receive_event_grid_events(EVENT_GRID_PAYLOADS, blob_service_client)\n            receive_cloud_events(CLOUD_EVENT_PAYLOADS, blob_service_client)",
    `            replay_sync_decoys(blob_service_client)
            receive_event_grid_events((), blob_service_client)
            receive_cloud_events((), blob_service_client)`,
    disconnected.documents,
  );
  disconnected = replaceDocument(
    "main.py",
    `            await receive_event_grid_events_async(
                EVENT_GRID_PAYLOADS,
                blob_service_client,
            )
            await receive_cloud_events_async(
                CLOUD_EVENT_PAYLOADS,
                blob_service_client,
            )`,
    `            await replay_async_decoys(blob_service_client)
            await receive_event_grid_events_async((), blob_service_client)
            await receive_cloud_events_async((), blob_service_client)`,
    disconnected.documents,
  );
  assert.equal(
    evaluateRule("prompt/ordered-demo-workflow", disconnected),
    false,
  );

  let optionalCloudFields = replaceDocument(
    "main.py",
    '"time":"2026-08-29T00:02:00Z",',
    "",
  );
  optionalCloudFields = replaceDocument(
    "main.py",
    '"time":"2026-08-29T00:03:00Z",',
    "",
    optionalCloudFields.documents,
  );
  assert.equal(
    evaluateRule("prompt/ordered-demo-workflow", optionalCloudFields),
    true,
  );
});

test("path-incompatible subject parsing is rejected", () => {
  const incompatible = replaceDocument(
    "blob_event_handler.py",
    `def parse_blob_subject(subject: str) -> tuple[str, str]:
    _, separator, container_and_blob = subject.partition("/containers/")
    if not separator:
        raise ValueError(f"Invalid Blob Storage event subject: {subject}")
    container, separator, blob_name = container_and_blob.partition("/blobs/")
    if not separator or not container or not blob_name:
        raise ValueError(f"Invalid Blob Storage event subject: {subject}")
    return unquote(container), unquote(blob_name)
`,
    `def parse_blob_subject(subject: str) -> tuple[str, str]:
    parts = subject.split("/")
    return parts[4], parts[6]
`,
  );
  assert.equal(
    evaluateRule("prompt/blob-subject-and-summary", incompatible),
    false,
  );

  const literalDecoy = replaceDocument(
    "blob_event_handler.py",
    `def parse_blob_subject(subject: str) -> tuple[str, str]:
    _, separator, container_and_blob = subject.partition("/containers/")
    if not separator:
        raise ValueError(f"Invalid Blob Storage event subject: {subject}")
    container, separator, blob_name = container_and_blob.partition("/blobs/")
    if not separator or not container or not blob_name:
        raise ValueError(f"Invalid Blob Storage event subject: {subject}")
    return unquote(container), unquote(blob_name)
`,
    `def parse_blob_subject(subject: str) -> tuple[str, str]:
    "/containers/"
    "/blobs/"
    subject.split("/")
    return "fixed-container", "truncated-name"
`,
  );
  assert.equal(
    evaluateRule("prompt/blob-subject-and-summary", literalDecoy),
    false,
  );

  const wholeSubject = replaceDocument(
    "blob_event_handler.py",
    `def parse_blob_subject(subject: str) -> tuple[str, str]:
    _, separator, container_and_blob = subject.partition("/containers/")
    if not separator:
        raise ValueError(f"Invalid Blob Storage event subject: {subject}")
    container, separator, blob_name = container_and_blob.partition("/blobs/")
    if not separator or not container or not blob_name:
        raise ValueError(f"Invalid Blob Storage event subject: {subject}")
    return unquote(container), unquote(blob_name)
`,
    `def parse_blob_subject(subject: str) -> tuple[str, str]:
    subject.partition("/containers/")
    subject.partition("/blobs/")
    return subject, subject
`,
  );
  assert.equal(
    evaluateRule("prompt/blob-subject-and-summary", wholeSubject),
    false,
  );
  assert.equal(evaluateRule("prompt/async-implementations", wholeSubject), false);
});

test("connected helper aliases and alternate valid SDK forms are accepted", () => {
  let alternate = replaceDocument(
    "blob_event_handler.py",
    "from urllib.parse import unquote",
    "from pathlib import PurePosixPath\nfrom urllib.parse import unquote",
  );
  alternate = replaceDocument(
    "blob_event_handler.py",
    `def parse_blob_subject(subject: str) -> tuple[str, str]:
    _, separator, container_and_blob = subject.partition("/containers/")
    if not separator:
        raise ValueError(f"Invalid Blob Storage event subject: {subject}")
    container, separator, blob_name = container_and_blob.partition("/blobs/")
    if not separator or not container or not blob_name:
        raise ValueError(f"Invalid Blob Storage event subject: {subject}")
    return unquote(container), unquote(blob_name)
`,
    `def parse_blob_subject(subject: str) -> tuple[str, str]:
    parts = PurePosixPath(subject).parts
    container_index = parts.index("containers") + 1
    blob_index = parts.index("blobs") + 1
    return unquote(parts[container_index]), unquote("/".join(parts[blob_index:]))
`,
    alternate.documents,
  );
  alternate = replaceDocument(
    "event_receiver.py",
    "def receive_event_grid_events(\n",
    "def deserialize_grid_payload(payload):\n    return GridEvent.from_json(payload)\n\n\ndef receive_event_grid_events(\n",
    alternate.documents,
  );
  alternate = replaceDocument(
    "event_receiver.py",
    "route_event(GridEvent.from_json(payload), blob_service_client)",
    "route_event(deserialize_grid_payload(payload), blob_service_client)",
    alternate.documents,
  );
  alternate = workspaceWithDocuments(
    alternate.documents.map((document) =>
      document.path === "event_receiver.py"
        ? {
            ...document,
            source: document.source
              .replaceAll("EventGridEvent", "GridEvent")
              .replace(
                "from azure.eventgrid import GridEvent",
                "from azure.eventgrid import EventGridEvent as GridEvent",
              ),
          }
        : { ...document },
    ),
  );
  alternate = replaceDocument(
    "event_publisher.py",
    "client = EventGridPublisherClient(topic_endpoint, credential)",
    "client = EventGridPublisherClient(endpoint=topic_endpoint, credential=credential)",
    alternate.documents,
  );
  alternate = replaceDocument(
    "event_publisher.py",
    "client = AsyncEventGridPublisherClient(topic_endpoint, credential)",
    "client = AsyncEventGridPublisherClient(endpoint=topic_endpoint, credential=credential)",
    alternate.documents,
  );
  for (const rule of sourceRules) {
    assert.equal(evaluateRule(rule, alternate), true, rule);
  }
});

test("insecure credential and connection-string alternatives are rejected", () => {
  let insecure = replaceDocument(
    "main.py",
    "from azure.identity import DefaultAzureCredential",
    "from azure.core.credentials import AzureKeyCredential\nfrom azure.identity import DefaultAzureCredential",
  );
  insecure = replaceDocument(
    "main.py",
    "with DefaultAzureCredential() as credential:",
    'with DefaultAzureCredential() as credential:\n        AzureKeyCredential("secret")',
    insecure.documents,
  );
  assert.equal(
    evaluateRule("prompt/secure-client-configuration", insecure),
    false,
  );
});

test("reachable function-local forbidden credential aliases are rejected", () => {
  for (const constructor of [
    `from azure.core.credentials import AzureKeyCredential as ImportedCredential
    ImportedCredential("secret")`,
    `import azure.core.credentials as credential_types
    credential_types.AzureSasCredential("secret")`,
  ]) {
    const insecure = replaceDocument(
      "main.py",
      "def run_sync_demo(settings) -> None:\n",
      `def run_sync_demo(settings) -> None:
    ${constructor}
`,
    );
    assert.equal(
      evaluateRule("prompt/secure-client-configuration", insecure),
      false,
      constructor,
    );
  }
});

test("reachable exception handlers reject direct and aliased credentials", () => {
  const cases = [
    {
      imports:
        "from azure.core.credentials import AzureKeyCredential\nfrom azure.identity import DefaultAzureCredential",
      handler: 'AzureKeyCredential("secret")',
    },
    {
      imports: "from azure.identity import DefaultAzureCredential",
      handler: `from azure.core.credentials import AzureSasCredential as HandlerCredential
        HandlerCredential("secret")`,
    },
    {
      imports: "from azure.identity import DefaultAzureCredential",
      handler: `import azure.core.credentials as credential_types
        credential_types.AzureKeyCredential("secret")`,
    },
  ];
  for (const { imports, handler } of cases) {
    let insecure = replaceDocument(
      "main.py",
      "from azure.identity import DefaultAzureCredential",
      imports,
    );
    insecure = replaceDocument(
      "main.py",
      "def run_sync_demo(settings) -> None:\n",
      `def run_sync_demo(settings) -> None:
    try:
        print("attempt")
    except RuntimeError:
        ${handler}
`,
      insecure.documents,
    );
    assert.equal(
      evaluateRule("prompt/secure-client-configuration", insecure),
      false,
      handler,
    );
  }
});

test("ordinary try except else and finally paths remain valid", () => {
  const handled = replaceDocument(
    "main.py",
    "def run_sync_demo(settings) -> None:\n",
    `def run_sync_demo(settings) -> None:
    try:
        print("attempt")
    except (RuntimeError, ValueError) as error:
        print(error)
    else:
        print("completed")
    finally:
        print("finished")
`,
  );
  for (const rule of sourceRules) {
    assert.equal(evaluateRule(rule, handled), true, rule);
  }
});

test("reachable function-local DefaultAzureCredential aliases remain accepted", () => {
  let aliased = replaceDocument(
    "main.py",
    "from azure.identity import DefaultAzureCredential\n",
    "",
  );
  aliased = replaceDocument(
    "main.py",
    "from azure.identity.aio import DefaultAzureCredential as AsyncDefaultAzureCredential\n",
    "",
    aliased.documents,
  );
  aliased = replaceDocument(
    "main.py",
    "def run_sync_demo(settings) -> None:\n    with DefaultAzureCredential() as credential:",
    `def run_sync_demo(settings) -> None:
    from azure.identity import DefaultAzureCredential as Credential

    with Credential() as credential:`,
    aliased.documents,
  );
  aliased = replaceDocument(
    "main.py",
    "async def run_async_demo(settings) -> None:\n    async with AsyncDefaultAzureCredential() as credential:",
    `async def run_async_demo(settings) -> None:
    from azure.identity.aio import DefaultAzureCredential as AsyncCredential

    async with AsyncCredential() as credential:`,
    aliased.documents,
  );
  for (const rule of sourceRules) {
    assert.equal(evaluateRule(rule, aliased), true, rule);
  }
});

test("secure clients must be the clients used by blob and publish operations", () => {
  let insecure = replaceDocument(
    "config.py",
    "import os",
    "import os",
  );
  insecure = replaceDocument(
    "config.py",
    `    return BlobServiceClient(
        account_url=settings.storage_account_url,
        credential=credential,
    )`,
    `    BlobServiceClient(
        account_url=settings.storage_account_url,
        credential=credential,
    )
    return BlobServiceClient(
        account_url="https://fixed.blob.core.windows.net",
        credential=credential,
    )`,
    insecure.documents,
  );
  insecure = replaceDocument(
    "config.py",
    `    return AsyncBlobServiceClient(
        account_url=settings.storage_account_url,
        credential=credential,
    )`,
    `    AsyncBlobServiceClient(
        account_url=settings.storage_account_url,
        credential=credential,
    )
    return AsyncBlobServiceClient(
        account_url="https://fixed.blob.core.windows.net",
        credential=credential,
    )`,
    insecure.documents,
  );
  insecure = replaceDocument(
    "event_publisher.py",
    "import logging",
    "import logging\nimport os",
    insecure.documents,
  );
  insecure = replaceDocument(
    "event_publisher.py",
    "    client = EventGridPublisherClient(topic_endpoint, credential)",
    `    EventGridPublisherClient(
        os.environ["AZURE_EVENT_GRID_TOPIC_ENDPOINT"],
        credential,
    )
    client = EventGridPublisherClient(
        "https://fixed.eventgrid.azure.net/api/events",
        credential,
    )`,
    insecure.documents,
  );
  insecure = replaceDocument(
    "event_publisher.py",
    "    client = AsyncEventGridPublisherClient(topic_endpoint, credential)",
    `    AsyncEventGridPublisherClient(
        os.environ["AZURE_EVENT_GRID_TOPIC_ENDPOINT"],
        credential,
    )
    client = AsyncEventGridPublisherClient(
        "https://fixed.eventgrid.azure.net/api/events",
        credential,
    )`,
    insecure.documents,
  );
  assert.equal(
    evaluateRule("prompt/secure-client-configuration", insecure),
    false,
  );

  let directBlob = replaceDocument(
    "main.py",
    "import logging",
    "import logging\nfrom azure.storage.blob import BlobClient",
  );
  directBlob = replaceDocument(
    "main.py",
    "        blob_service_client = create_sync_blob_service_client(settings, credential)",
    `        blob_service_client = create_sync_blob_service_client(settings, credential)
        BlobClient(
            account_url="https://fixed.blob.core.windows.net",
            container_name="fixed-container",
            blob_name="fixed/blob.txt",
            credential="secret",
        ).download_blob().readall()`,
    directBlob.documents,
  );
  assert.equal(
    evaluateRule("prompt/secure-client-configuration", directBlob),
    false,
  );
});

test("exception handling rejects fake logging facades", () => {
  let fakeBlobLogger = replaceDocument(
    "blob_event_handler.py",
    "import logging",
    `class FakeLogger:
    def warning(self, *args):
        pass`,
  );
  fakeBlobLogger = replaceDocument(
    "blob_event_handler.py",
    "logger = logging.getLogger(__name__)",
    "logger = FakeLogger()",
    fakeBlobLogger.documents,
  );
  assert.equal(
    evaluateRule("prompt/race-condition-handling", fakeBlobLogger),
    false,
  );

  let fakePublisherLogger = replaceDocument(
    "event_publisher.py",
    "import logging",
    `class FakeLogger:
    def error(self, *args):
        pass`,
  );
  fakePublisherLogger = replaceDocument(
    "event_publisher.py",
    "logger = logging.getLogger(__name__)",
    "logger = FakeLogger()",
    fakePublisherLogger.documents,
  );
  assert.equal(
    evaluateRule("prompt/custom-event-publishing", fakePublisherLogger),
    false,
  );
  assert.equal(
    evaluateRule("prompt/async-implementations", fakePublisherLogger),
    false,
  );
});

test("exception handlers must protect the actual operation on a compatible path", () => {
  const raceBody = `def handle_blob_created(
    subject: str,
    blob_service_client: BlobServiceClient,
) -> None:
    container, blob_name = parse_blob_subject(subject)
    blob_client = blob_service_client.get_blob_client(container, blob_name)
    if subject:
        properties = blob_client.get_blob_properties()
        downloader = blob_client.download_blob()
        downloader.readall()
        print(
            "Created blob "
            f"name={blob_name} size={properties.size} "
            f"content_type={properties.content_settings.content_type} "
            f"access_tier={properties.blob_tier}"
        )
    else:
        try:
            blob_client.download_blob()
        except ResourceNotFoundError:
            logger.warning("Blob disappeared: %s", subject)
        except HttpResponseError:
            logger.warning("Blob changed: %s", subject)

`;
  const incompatibleRace = workspaceWithDocuments(
    goldenWorkspace.documents.map((document) => ({
      ...document,
      source: document.path === "blob_event_handler.py"
        ? document.source.replace(
            /def handle_blob_created\([\s\S]*?(?=def handle_blob_deleted)/,
            raceBody,
          )
        : document.source,
    })),
  );
  assert.equal(
    evaluateRule("prompt/race-condition-handling", incompatibleRace),
    false,
  );

  let unreachablePublishHandler = replaceDocument(
    "event_publisher.py",
    `    try:
        client.send(list(events))
    except AzureError as error:
        logger.error("Custom Event Grid publishing failed: %s", error)
    finally:
        client.close()`,
    `    client.send(list(events))
    if False:
        try:
            client.send(list(events))
        except AzureError as error:
            logger.error("Custom Event Grid publishing failed: %s", error)
    client.close()`,
  );
  assert.equal(
    evaluateRule(
      "prompt/custom-event-publishing",
      unreachablePublishHandler,
    ),
    false,
  );
});

test("constructed custom events must be the events sent by each publisher", () => {
  const unsent = replaceDocument(
    "event_publisher.py",
    "client.send(list(events))",
    "client.send([])",
  );
  const asyncUnsent = replaceDocument(
    "event_publisher.py",
    "await client.send(list(events))",
    "await client.send([])",
    unsent.documents,
  );
  assert.equal(
    evaluateRule("prompt/custom-event-publishing", asyncUnsent),
    false,
  );
  assert.equal(evaluateRule("prompt/async-implementations", asyncUnsent), false);
});

test("custom events must derive subject and data from supplied inputs", () => {
  const fixedSubject = replaceDocument(
    "event_publisher.py",
    "subject=subject,",
    'subject="/documents/fixed/processed",',
  );
  assert.equal(
    evaluateRule("prompt/custom-event-publishing", fixedSubject),
    false,
  );

  const fixedData = replaceDocument(
    "event_publisher.py",
    "data=data,",
    'data={"document": "fixed.pdf", "status": "processed"},',
  );
  assert.equal(
    evaluateRule("prompt/custom-event-publishing", fixedData),
    false,
  );

  const subjectAsData = replaceDocument(
    "event_publisher.py",
    "data=data,",
    "data=subject,",
  );
  assert.equal(
    evaluateRule("prompt/custom-event-publishing", subjectAsData),
    false,
  );

  let dataAsSubject = replaceDocument(
    "event_publisher.py",
    "subject=subject,",
    "subject=data,",
  );
  dataAsSubject = replaceDocument(
    "main.py",
    '{"document": "2026/august/one.pdf", "status": "processed"}',
    '"/documents/data/processed"',
    dataAsSubject.documents,
  );
  dataAsSubject = replaceDocument(
    "main.py",
    '{"document": "2026/august/two.pdf", "status": "processed"}',
    '"/documents/data/processed"',
    dataAsSubject.documents,
  );
  assert.equal(
    evaluateRule("prompt/custom-event-publishing", dataAsSubject),
    false,
  );
});

test("derived custom-event aliases and wrappers remain accepted", () => {
  const derived = replaceDocument(
    "event_publisher.py",
    `) -> EventGridEvent:
    return EventGridEvent(
        subject=subject,
        event_type="Contoso.Documents.Processed",
        data=data,`,
    `) -> EventGridEvent:
    derived_subject = f"{subject}"
    derived_data = {"notification": data}
    return EventGridEvent(
        subject=derived_subject,
        event_type="Contoso.Documents.Processed",
        data=derived_data,`,
  );
  assert.equal(
    evaluateRule("prompt/custom-event-publishing", derived),
    true,
  );
  assert.equal(evaluateRule("prompt/async-implementations", derived), true);
});

test("renamed publisher inputs retain field-specific provenance", () => {
  let renamed = replaceDocument(
    "event_publisher.py",
    `def create_document_processed_event(
    data: dict[str, Any],
    *,
    subject: str = "/documents/invoices/processed",
) -> EventGridEvent:
    return EventGridEvent(
        subject=subject,
        event_type="Contoso.Documents.Processed",
        data=data,`,
    `def create_document_processed_event(
    payload: dict[str, Any],
    *,
    subject_path: str = "/documents/invoices/processed",
) -> EventGridEvent:
    derived_subject = f"{subject_path}"
    derived_payload = {"notification": payload}
    return EventGridEvent(
        subject=derived_subject,
        event_type="Contoso.Documents.Processed",
        data=derived_payload,`,
  );
  renamed = replaceDocument(
    "main.py",
    'subject="/documents/invoices/processed",',
    'subject_path="/documents/invoices/processed",',
    renamed.documents,
  );
  renamed = replaceDocument(
    "main.py",
    'subject="/documents/invoices/processed",',
    'subject_path="/documents/invoices/processed",',
    renamed.documents,
  );
  assert.equal(
    evaluateRule("prompt/custom-event-publishing", renamed),
    true,
  );
  assert.equal(evaluateRule("prompt/async-implementations", renamed), true);
});

test("publisher helper calls preserve caller-root field and payload provenance", () => {
  let ignoredFactoryInputs = replaceDocument(
    "event_publisher.py",
    "\ndef create_document_processed_event(\n",
    `
def build_document_event(payload: dict[str, Any], subject_path: str) -> EventGridEvent:
    return EventGridEvent(
        subject=subject_path,
        event_type="Contoso.Documents.Processed",
        data=payload,
        data_version="1.0",
    )


def create_document_processed_event(
`,
  );
  ignoredFactoryInputs = replaceDocument(
    "event_publisher.py",
    `    return EventGridEvent(
        subject=subject,
        event_type="Contoso.Documents.Processed",
        data=data,
        data_version="1.0",
    )`,
    `    return build_document_event(
        {"document": "fixed.pdf", "status": "processed"},
        "/documents/fixed/processed",
    )`,
    ignoredFactoryInputs.documents,
  );
  assert.equal(
    evaluateRule("prompt/custom-event-publishing", ignoredFactoryInputs),
    false,
  );

  let ignoredSendInputs = replaceDocument(
    "event_publisher.py",
    "\ndef publish_custom_events(\n",
    `
def send_event_batch(client, batch: Iterable[EventGridEvent]) -> None:
    client.send(list(batch))


def publish_custom_events(
`,
  );
  ignoredSendInputs = replaceDocument(
    "event_publisher.py",
    "        client.send(list(events))",
    `        local_event = create_document_processed_event(
            {"document": "fixed.pdf", "status": "processed"},
            subject="/documents/fixed/processed",
        )
        send_event_batch(client, [local_event])`,
    ignoredSendInputs.documents,
  );
  assert.equal(
    evaluateRule("prompt/custom-event-publishing", ignoredSendInputs),
    false,
  );

  let forwarded = replaceDocument(
    "event_publisher.py",
    "\ndef create_document_processed_event(\n",
    `
def build_document_event(payload: dict[str, Any], subject_path: str) -> EventGridEvent:
    return EventGridEvent(
        subject=subject_path,
        event_type="Contoso.Documents.Processed",
        data=payload,
        data_version="1.0",
    )


def create_document_processed_event(
`,
  );
  forwarded = replaceDocument(
    "event_publisher.py",
    `    return EventGridEvent(
        subject=subject,
        event_type="Contoso.Documents.Processed",
        data=data,
        data_version="1.0",
    )`,
    "    return build_document_event(data, subject)",
    forwarded.documents,
  );
  forwarded = replaceDocument(
    "event_publisher.py",
    "\ndef publish_custom_events(\n",
    `
def send_event_batch(client, batch: Iterable[EventGridEvent]) -> None:
    client.send(list(batch))


def publish_custom_events(
`,
    forwarded.documents,
  );
  forwarded = replaceDocument(
    "event_publisher.py",
    "        client.send(list(events))",
    "        send_event_batch(client, events)",
    forwarded.documents,
  );
  assert.equal(
    evaluateRule("prompt/custom-event-publishing", forwarded),
    true,
  );
  assert.equal(evaluateRule("prompt/async-implementations", forwarded), true);
});
