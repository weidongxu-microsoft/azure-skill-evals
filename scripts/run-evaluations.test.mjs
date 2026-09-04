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

  assert.deepEqual(
    groups.map(({ language, filters }) => [language, filters[0]]),
    [
      ["python", "../../scenarios/cosmos-db-python-crud/eval.yaml"],
      ["dotnet", "../../scenarios/cosmos-db-dotnet-crud/eval.yaml"],
      ["java", "../../scenarios/cosmos-db-java-crud/eval.yaml"],
      ["typescript", "../../scenarios/cosmos-db-typescript-crud/eval.yaml"],
    ],
  );
});

test("intersects tag clauses", () => {
  const groups = selectEvaluations(catalog, {
    mode: "tags",
    tags: "service=identity;language=python",
  });

  assert.deepEqual(groups.map(({ language }) => language), ["python"]);
  assert.ok(
    groups[0].filters.every((filter) =>
      filter.startsWith("../../scenarios/identity-python-"),
    ),
  );
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

  assert.deepEqual(groups, [
    {
      language: "typescript",
      experiment: "experiments/typescript/experiment.yaml",
      filters: [
        "../../scenarios/identity-typescript-default-azure-credential/eval.yaml",
      ],
    },
  ]);
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

  assert.deepEqual(
    groups.map(({ language, filters }) => ({ language, filters })),
    [
      {
        language: "python",
        filters: ["../../scenarios/foundry-python-support-assistant/eval.yaml"],
      },
      {
        language: "dotnet",
        filters: ["../../scenarios/foundry-dotnet-support-assistant/eval.yaml"],
      },
      {
        language: "java",
        filters: ["../../scenarios/foundry-java-support-assistant/eval.yaml"],
      },
      {
        language: "typescript",
        filters: ["../../scenarios/foundry-typescript-support-assistant/eval.yaml"],
      },
    ],
  );
});

test("accepts comma-separated values within a tag", () => {
  const groups = selectEvaluations(catalog, {
    mode: "tags",
    tags: "language=python,typescript;service=cosmos-db",
  });

  assert.deepEqual(groups.map(({ language }) => language), ["python", "typescript"]);
});

test("accepts comma-separated values in structured tag filters", () => {
  const groups = selectEvaluations(catalog, {
    mode: "all",
    language: "go,java",
    service: "identity,storage",
    scope: "focused-task",
  });

  assert.deepEqual(groups.map(({ language }) => language), ["java", "go"]);
  assert.ok(
    groups.flatMap(({ filters }) => filters).every(
      (filter) =>
        filter.includes("/identity-") || filter.includes("/storage-"),
    ),
  );
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
  const goEvaluations = groups[0].filters.length;

  assert.deepEqual(buildShardMatrix(groups, "all"), {
    include: [
      { language: "go", variant: "baseline", evaluations: goEvaluations },
      {
        language: "go",
        variant: "azure-skill-mcp",
        evaluations: goEvaluations,
      },
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
