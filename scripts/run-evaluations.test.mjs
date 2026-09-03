import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildShardMatrix,
  collectTagFilters,
  loadCatalog,
  parseTagFilters,
  runExperimentGroups,
  selectEvaluations,
} from "./run-evaluations.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalog = loadCatalog(root);

test("selects one cross-language suite", () => {
  assert.equal(catalog.suites.has("evals"), false);

  const groups = selectEvaluations(catalog, {
    mode: "suite",
    suite: "cosmos-crud",
  });

  assert.equal(groups.length, 4);
  assert.deepEqual(
    groups.map(({ language, filters }) => [language, filters.length]),
    [
      ["python", 1],
      ["dotnet", 1],
      ["java", 1],
      ["typescript", 1],
    ],
  );
});

test("intersects tag clauses", () => {
  const groups = selectEvaluations(catalog, {
    mode: "tags",
    tags: "service=identity;language=python",
  });

  test("intersects suite and structured tag filters", () => {
    const groups = selectEvaluations(catalog, {
      mode: "all",
      suite: "identity-default-azure-credential",
      language: "typescript",
      service: "identity",
      plane: "data-plane",
      scope: "focused-task",
    });

    assert.deepEqual(groups.map(({ language }) => language), ["typescript"]);
    assert.equal(groups[0].filters.length, 1);
  });

  test("combines structured and free-form tag filters", () => {
    const groups = selectEvaluations(catalog, {
      mode: "all",
      language: "typescript",
      service: "foundry",
      plane: "data-plane",
      scope: "end-to-end-solution",
      tags: "category=solution",
    });

    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].filters, [
      "../../scenarios/foundry-typescript-support-assistant/eval.yaml",
    ]);
  });

  test("treats empty structured filters as unrestricted", () => {
    assert.deepEqual(
      collectTagFilters({
        language: "",
        service: "",
        plane: "",
        scope: undefined,
        tags: "",
      }),
      [],
    );
  });

  test("selects the end-to-end solution suite", () => {
    const groups = selectEvaluations(catalog, {
      mode: "all",
      suite: "end-to-end-solutions",
    });

    assert.deepEqual(groups.map(({ language }) => language), ["typescript"]);
    assert.equal(groups[0].filters.length, 1);
  });

  assert.deepEqual(groups.map(({ language }) => language), ["python"]);
  assert.equal(groups[0].filters.length, 4);
});

test("accepts comma-separated values within a tag", () => {
  const groups = selectEvaluations(catalog, {
    mode: "tags",
    tags: "language=python,typescript;service=cosmos-db",
  });

  assert.deepEqual(groups.map(({ language }) => language), ["python", "typescript"]);
});

test("builds one shard per selected language and variant", () => {
  const groups = selectEvaluations(catalog, {
    mode: "suite",
    suite: "cosmos-db-todo-repository",
  });

  assert.deepEqual(buildShardMatrix(groups, "all"), {
    include: [
      { language: "python", variant: "baseline", evaluations: 1 },
      { language: "python", variant: "azure-skill-mcp", evaluations: 1 },
      {
        language: "python",
        variant: "azure-skill-mcp-microsoft-skill",
        evaluations: 1,
      },
      { language: "java", variant: "baseline", evaluations: 1 },
      { language: "java", variant: "azure-skill-mcp", evaluations: 1 },
      {
        language: "java",
        variant: "azure-skill-mcp-microsoft-skill",
        evaluations: 1,
      },
    ],
  });
});

test("builds only the two supported Go variants", () => {
  const groups = selectEvaluations(catalog, {
    mode: "tags",
    tags: "language=go",
  });

  assert.deepEqual(buildShardMatrix(groups, "all"), {
    include: [
      { language: "go", variant: "baseline", evaluations: 26 },
      { language: "go", variant: "azure-skill-mcp", evaluations: 26 },
    ],
  });
  assert.throws(
    () => buildShardMatrix(groups, "azure-skill-mcp-microsoft-skill"),
    /do not support/,
  );
});

test("omits Go when a mixed selection requests the unsupported third variant", () => {
  const groups = selectEvaluations(catalog, {
    mode: "suite",
    suite: "identity-default-azure-credential",
  });

  assert.deepEqual(
    buildShardMatrix(groups, "azure-skill-mcp-microsoft-skill").include.map(
      ({ language }) => language,
    ),
    ["python", "dotnet", "java", "typescript"],
  );
});

test("rejects malformed tag filters", () => {
  assert.throws(
    () => parseTagFilters("service"),
    /Use key=value1,value2/,
  );
});

test("rejects unknown suites", () => {
  assert.throws(
    () =>
      selectEvaluations(catalog, {
        mode: "suite",
        suite: "missing",
      }),
    /Unknown suite "missing"/,
  );
});

test("rejects suites that are not fully represented in experiments", () => {
  assert.throws(
    () =>
      selectEvaluations(
        {
          entries: catalog.entries,
          suites: new Map([["partial", ["scenarios/not-in-an-experiment/eval.yaml"]]]),
        },
        {
          mode: "suite",
          suite: "partial",
        },
      ),
    /not declared by a language experiment/,
  );
});

test("runs every language group before reporting failures", async () => {
  const invoked = [];
  const groups = [
    { language: "python", experiment: "python.yaml", filters: ["python-eval.yaml"] },
    { language: "java", experiment: "java.yaml", filters: ["java-eval.yaml"] },
    {
      language: "typescript",
      experiment: "typescript.yaml",
      filters: ["typescript-eval.yaml"],
    },
  ];

  await assert.rejects(
    runExperimentGroups(
      groups,
      {
        variant: "baseline",
        outputDir: "reports",
        dryRun: false,
      },
      root,
      async (_command, args) => {
        const experiment = args[args.indexOf("run") + 1];
        invoked.push(experiment);
        if (experiment === "java.yaml") {
          throw new Error("threshold not met");
        }
      },
    ),
    /1 evaluation group\(s\) failed: java/,
  );

  assert.deepEqual(invoked, ["python.yaml", "java.yaml", "typescript.yaml"]);
});
