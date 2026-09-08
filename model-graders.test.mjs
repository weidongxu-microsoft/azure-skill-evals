import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const expectedLanguageCriteria = {
  dotnet: 3,
  go: 0,
  java: null,
  python: 5,
  typescript: 10,
};

const forbiddenCriterionBoilerplate = [
  "Implement the scoped behavior:",
  "Use current public SDK APIs or equivalent value flow unless the prompt requires an exact symbol.",
  "Required inputs, returned values, state transitions, or failures are observable in code.",
];

const forbiddenGenericLanguagePhrases = [
  "Close, stop, or dispose Azure clients/processors that own a lifecycle.",
  "Delete prompt-created cloud resources in dependency-safe order.",
  "Run cleanup after a resource is created even when later work fails.",
  "Wait for prompt-required asynchronous service states with the selected SDK's supported poller or status-retrieval pattern.",
  "True SDK LROs use a public poller or equivalent terminal-result API.",
  "Require successful terminal state and handle failed, canceled, or timed-out states.",
];

const expectedJavaLanguageCriteriaByScenario = {
  "ai-agents-java-basic-agent-lifecycle": [
    "language/current-public-azure-sdk-dependencies",
    "language/azure-sdk-bom-first-version-management",
    "language/current-public-azure-sdk-imports",
    "language/supported-runtime-authentication",
    "language/current-public-client-construction",
    "language/current-public-azure-sdk-apis",
    "language/complete-pageable-traversal",
    "language/supported-terminal-state-polling",
    "language/owned-resource-lifecycle-cleanup",
  ],
  "ai-agents-java-file-search": [
    "language/current-public-azure-sdk-dependencies",
    "language/azure-sdk-bom-first-version-management",
    "language/current-public-azure-sdk-imports",
    "language/supported-runtime-authentication",
    "language/current-public-client-construction",
    "language/current-public-azure-sdk-apis",
    "language/complete-pageable-traversal",
    "language/supported-terminal-state-polling",
    "language/owned-resource-lifecycle-cleanup",
  ],
  "ai-agents-java-function-tool": [
    "language/current-public-azure-sdk-dependencies",
    "language/azure-sdk-bom-first-version-management",
    "language/current-public-azure-sdk-imports",
    "language/supported-runtime-authentication",
    "language/current-public-client-construction",
    "language/current-public-azure-sdk-apis",
    "language/complete-pageable-traversal",
    "language/supported-terminal-state-polling",
    "language/owned-resource-lifecycle-cleanup",
  ],
  "ai-projects-java-dataset-lifecycle": [
    "language/current-public-azure-sdk-dependencies",
    "language/azure-sdk-bom-first-version-management",
    "language/current-public-azure-sdk-imports",
    "language/supported-runtime-authentication",
    "language/current-public-client-construction",
    "language/current-public-azure-sdk-apis",
    "language/owned-resource-lifecycle-cleanup",
  ],
  "ai-projects-java-evaluation-run": [
    "language/current-public-azure-sdk-dependencies",
    "language/azure-sdk-bom-first-version-management",
    "language/current-public-azure-sdk-imports",
    "language/supported-runtime-authentication",
    "language/current-public-client-construction",
    "language/current-public-azure-sdk-apis",
    "language/complete-pageable-traversal",
    "language/supported-terminal-state-polling",
    "language/owned-resource-lifecycle-cleanup",
  ],
  "ai-projects-java-project-resource-inventory": [
    "language/current-public-azure-sdk-dependencies",
    "language/azure-sdk-bom-first-version-management",
    "language/current-public-azure-sdk-imports",
    "language/supported-runtime-authentication",
    "language/current-public-client-construction",
    "language/current-public-azure-sdk-apis",
    "language/complete-pageable-traversal",
  ],
  "app-configuration-java-config-values": [
    "language/current-public-azure-sdk-dependencies",
    "language/azure-sdk-bom-first-version-management",
    "language/current-public-azure-sdk-imports",
    "language/supported-runtime-authentication",
    "language/current-public-client-construction",
    "language/current-public-azure-sdk-apis",
    "language/complete-pageable-traversal",
    "language/service-specific-error-diagnostics",
    "language/owned-resource-lifecycle-cleanup",
  ],
  "app-configuration-java-feature-flags": [
    "language/current-public-azure-sdk-dependencies",
    "language/azure-sdk-bom-first-version-management",
    "language/current-public-azure-sdk-imports",
    "language/supported-runtime-authentication",
    "language/current-public-client-construction",
    "language/current-public-azure-sdk-apis",
    "language/complete-pageable-traversal",
    "language/supported-terminal-state-polling",
    "language/reactive-async-service-flow",
  ],
  "cosmos-db-java-crud": [
    "language/current-public-azure-sdk-dependencies",
    "language/azure-sdk-bom-first-version-management",
    "language/current-public-azure-sdk-imports",
    "language/supported-runtime-authentication",
    "language/current-public-client-construction",
    "language/current-public-azure-sdk-apis",
    "language/service-specific-error-diagnostics",
    "language/owned-resource-lifecycle-cleanup",
  ],
  "cosmos-db-java-todo-repository": [
    "language/current-public-azure-sdk-dependencies",
    "language/azure-sdk-bom-first-version-management",
    "language/current-public-azure-sdk-imports",
    "language/supported-runtime-authentication",
    "language/current-public-client-construction",
    "language/current-public-azure-sdk-apis",
    "language/complete-pageable-traversal",
    "language/reactive-async-service-flow",
    "language/service-specific-error-diagnostics",
  ],
  "document-translation-java-batch-container": [
    "language/current-public-azure-sdk-dependencies",
    "language/azure-sdk-bom-first-version-management",
    "language/current-public-azure-sdk-imports",
    "language/supported-runtime-authentication",
    "language/current-public-client-construction",
    "language/current-public-azure-sdk-apis",
    "language/complete-pageable-traversal",
    "language/supported-terminal-state-polling",
  ],
  "document-translation-java-single-document": [
    "language/current-public-azure-sdk-dependencies",
    "language/azure-sdk-bom-first-version-management",
    "language/current-public-azure-sdk-imports",
    "language/supported-runtime-authentication",
    "language/current-public-client-construction",
    "language/current-public-azure-sdk-apis",
  ],
  "event-hubs-java-send-receive-events": [
    "language/current-public-azure-sdk-dependencies",
    "language/azure-sdk-bom-first-version-management",
    "language/current-public-azure-sdk-imports",
    "language/supported-runtime-authentication",
    "language/current-public-client-construction",
    "language/current-public-azure-sdk-apis",
    "language/service-specific-error-diagnostics",
    "language/owned-resource-lifecycle-cleanup",
  ],
  "foundry-java-support-assistant": [
    "language/current-public-azure-sdk-dependencies",
    "language/azure-sdk-bom-first-version-management",
    "language/current-public-azure-sdk-imports",
    "language/supported-runtime-authentication",
    "language/current-public-client-construction",
    "language/current-public-azure-sdk-apis",
    "language/complete-pageable-traversal",
    "language/supported-terminal-state-polling",
    "language/service-specific-error-diagnostics",
    "language/owned-resource-lifecycle-cleanup",
  ],
  "identity-java-credential-chain": [
    "language/current-public-azure-sdk-dependencies",
    "language/azure-sdk-bom-first-version-management",
    "language/current-public-azure-sdk-imports",
    "language/supported-runtime-authentication",
    "language/current-public-azure-sdk-apis",
    "language/reactive-async-service-flow",
    "language/service-specific-error-diagnostics",
  ],
  "identity-java-default-azure-credential": [
    "language/current-public-azure-sdk-dependencies",
    "language/azure-sdk-bom-first-version-management",
    "language/current-public-azure-sdk-imports",
    "language/supported-runtime-authentication",
    "language/current-public-client-construction",
    "language/current-public-azure-sdk-apis",
    "language/service-specific-error-diagnostics",
  ],
  "identity-java-managed-identity-auth": [
    "language/current-public-azure-sdk-dependencies",
    "language/azure-sdk-bom-first-version-management",
    "language/current-public-azure-sdk-imports",
    "language/supported-runtime-authentication",
    "language/current-public-client-construction",
    "language/current-public-azure-sdk-apis",
    "language/service-specific-error-diagnostics",
  ],
  "identity-java-service-principal-auth": [
    "language/current-public-azure-sdk-dependencies",
    "language/azure-sdk-bom-first-version-management",
    "language/current-public-azure-sdk-imports",
    "language/supported-runtime-authentication",
    "language/current-public-client-construction",
    "language/current-public-azure-sdk-apis",
    "language/service-specific-error-diagnostics",
  ],
  "key-vault-java-crud-secrets": [
    "language/current-public-azure-sdk-dependencies",
    "language/azure-sdk-bom-first-version-management",
    "language/current-public-azure-sdk-imports",
    "language/supported-runtime-authentication",
    "language/current-public-client-construction",
    "language/current-public-azure-sdk-apis",
    "language/supported-terminal-state-polling",
    "language/service-specific-error-diagnostics",
    "language/owned-resource-lifecycle-cleanup",
  ],
  "key-vault-java-secret-config": [
    "language/current-public-azure-sdk-dependencies",
    "language/azure-sdk-bom-first-version-management",
    "language/current-public-azure-sdk-imports",
    "language/supported-runtime-authentication",
    "language/current-public-client-construction",
    "language/current-public-azure-sdk-apis",
    "language/supported-terminal-state-polling",
    "language/reactive-async-service-flow",
    "language/service-specific-error-diagnostics",
    "language/owned-resource-lifecycle-cleanup",
  ],
  "resource-manager-java-resource-group-crud": [
    "language/current-public-azure-sdk-dependencies",
    "language/azure-sdk-bom-first-version-management",
    "language/current-public-azure-sdk-imports",
    "language/supported-runtime-authentication",
    "language/current-public-client-construction",
    "language/current-public-azure-sdk-apis",
    "language/complete-pageable-traversal",
    "language/service-specific-error-diagnostics",
    "language/owned-resource-lifecycle-cleanup",
  ],
  "service-bus-java-order-processor": [
    "language/current-public-azure-sdk-dependencies",
    "language/azure-sdk-bom-first-version-management",
    "language/current-public-azure-sdk-imports",
    "language/supported-runtime-authentication",
    "language/current-public-client-construction",
    "language/current-public-azure-sdk-apis",
    "language/reactive-async-service-flow",
    "language/service-specific-error-diagnostics",
    "language/owned-resource-lifecycle-cleanup",
  ],
  "service-bus-java-send-receive-messages": [
    "language/current-public-azure-sdk-dependencies",
    "language/azure-sdk-bom-first-version-management",
    "language/current-public-azure-sdk-imports",
    "language/supported-runtime-authentication",
    "language/current-public-client-construction",
    "language/current-public-azure-sdk-apis",
    "language/service-specific-error-diagnostics",
    "language/owned-resource-lifecycle-cleanup",
  ],
  "storage-java-account-mgmt": [
    "language/current-public-azure-sdk-dependencies",
    "language/azure-sdk-bom-first-version-management",
    "language/current-public-azure-sdk-imports",
    "language/supported-runtime-authentication",
    "language/current-public-client-construction",
    "language/current-public-azure-sdk-apis",
    "language/complete-pageable-traversal",
    "language/service-specific-error-diagnostics",
    "language/owned-resource-lifecycle-cleanup",
  ],
  "storage-java-blob-event-notifier": [
    "language/current-public-azure-sdk-dependencies",
    "language/azure-sdk-bom-first-version-management",
    "language/current-public-azure-sdk-imports",
    "language/supported-runtime-authentication",
    "language/current-public-client-construction",
    "language/current-public-azure-sdk-apis",
    "language/reactive-async-service-flow",
    "language/service-specific-error-diagnostics",
  ],
  "storage-java-blob-storage-manager": [
    "language/current-public-azure-sdk-dependencies",
    "language/azure-sdk-bom-first-version-management",
    "language/current-public-azure-sdk-imports",
    "language/supported-runtime-authentication",
    "language/current-public-client-construction",
    "language/current-public-azure-sdk-apis",
    "language/complete-pageable-traversal",
    "language/reactive-async-service-flow",
    "language/service-specific-error-diagnostics",
    "language/owned-resource-lifecycle-cleanup",
  ],
  "storage-java-crud-blobs": [
    "language/current-public-azure-sdk-dependencies",
    "language/azure-sdk-bom-first-version-management",
    "language/current-public-azure-sdk-imports",
    "language/supported-runtime-authentication",
    "language/current-public-client-construction",
    "language/current-public-azure-sdk-apis",
    "language/complete-pageable-traversal",
    "language/service-specific-error-diagnostics",
    "language/owned-resource-lifecycle-cleanup",
  ],
  "storage-java-encrypted-uploader": [
    "language/current-public-azure-sdk-dependencies",
    "language/azure-sdk-bom-first-version-management",
    "language/current-public-azure-sdk-imports",
    "language/supported-runtime-authentication",
    "language/current-public-client-construction",
    "language/current-public-azure-sdk-apis",
    "language/reactive-async-service-flow",
    "language/service-specific-error-diagnostics",
  ],
  "text-translation-java-multilingual-translation": [
    "language/current-public-azure-sdk-dependencies",
    "language/azure-sdk-bom-first-version-management",
    "language/current-public-azure-sdk-imports",
    "language/supported-runtime-authentication",
    "language/current-public-client-construction",
    "language/current-public-azure-sdk-apis",
  ],
  "text-translation-java-transliteration": [
    "language/current-public-azure-sdk-dependencies",
    "language/azure-sdk-bom-first-version-management",
    "language/current-public-azure-sdk-imports",
    "language/supported-runtime-authentication",
    "language/current-public-client-construction",
    "language/current-public-azure-sdk-apis",
  ],
};

const expectedProgramGraders = {
  dotnet: [
    `      - type: run-command
        name: program/dotnet-project-builds
        config:
          command: dotnet
          args:
            - build
            - --nologo
          timeout: 3m`,
  ],
  go: [
    `      - type: run-command
        name: program/go-project-tests
        config:
          command: go
          args:
            - test
            - -mod=readonly
            - ./...
          timeout: 3m`,
  ],
  java: [
    `      - type: run-command
        name: program/java-project-compiles
        config:
          command: node
          args:
            - .vally/program-checks/java.mjs
          timeout: 3m`,
  ],
  python: [
    `      - type: run-command
        name: program/python-source-compiles
        config:
          command: python
          args:
            - .vally/program-checks/python.py
          timeout: 30s`,
  ],
  typescript: [
    `      - type: run-command
        name: program/typescript-dependencies-install
        config:
          command: npm
          args:
            - install
            - --ignore-scripts
            - --no-audit
            - --no-fund
          timeout: 3m`,
    `      - type: run-command
        name: program/typescript-type-checks
        config:
          command: npx
          args:
            - --no-install
            - tsc
            - --noEmit
          timeout: 2m`,
  ],
};

const scenarioRoot = fileURLToPath(new URL("./scenarios/", import.meta.url));
const evalPaths = readdirSync(scenarioRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(scenarioRoot, entry.name, "eval.yaml"));

test("every eval uses one complete model review and program checks", () => {
  for (const evalPath of evalPaths) {
    const source = readFileSync(evalPath, "utf8").replaceAll("\r\n", "\n");
    const language = source.match(/^\s+language:\s*(\S+)$/m)?.[1];
    const criterionNames = [
      ...source.matchAll(/^\s+- name: ((?:prompt|language)\/.+)$/gm),
    ].map((match) => match[1]);
    const languageCriteria = criterionNames.filter((name) =>
      name.startsWith("language/"),
    );

    assert.equal(
      (source.match(/^\s+- type: panel$/gm) ?? []).length,
      1,
      evalPath,
    );
    assert.equal(
      (source.match(/^\s+- type: run-command$/gm) ?? []).length,
      expectedProgramGraders[language].length,
      evalPath,
    );
    assert.equal(
      (source.match(/^\s+- type: program$/gm) ?? []).length,
      0,
      evalPath,
    );
    assert.match(source, /^scoring:\n  weights: \{\}\n/m, evalPath);
    assert.doesNotMatch(source, /^  threshold:/m, evalPath);
    for (const programGrader of expectedProgramGraders[language]) {
      assert.ok(source.includes(programGrader), evalPath);
    }
    assert.doesNotMatch(source, /^\s+required:/m, evalPath);
    assert.match(source, /^\s+threshold: 0$/m, evalPath);
    assert.match(source, /^\s+overall_threshold: 0$/m, evalPath);
    if (expectedLanguageCriteria[language] !== null) {
      assert.equal(
        languageCriteria.length,
        expectedLanguageCriteria[language],
        evalPath,
      );
    }
    assert.equal(
      new Set(criterionNames).size,
      criterionNames.length,
      `duplicate criterion names in ${evalPath}`,
    );
    const criterionStarts = [
      ...source.matchAll(/^(\s+)- name: ((?:prompt|language)\/.+)$/gm),
    ];
    for (const [index, criterion] of criterionStarts.entries()) {
      const start = criterion.index;
      const end = criterionStarts[index + 1]?.index ?? source.length;
      const block = source.slice(start, end);
      assert.match(block, /^\s+weight: 1$/m, `${evalPath}: ${criterion[2]}`);
      assert.match(
        block,
        /^\s+pass_threshold: 1$/m,
        `${evalPath}: ${criterion[2]}`,
      );
      for (const phrase of forbiddenCriterionBoilerplate) {
        assert.ok(
          !block.includes(phrase),
          `${evalPath}: ${criterion[2]} contains boilerplate phrase ${phrase}`,
        );
      }
      if (criterion[2].startsWith("language/")) {
        for (const phrase of forbiddenGenericLanguagePhrases) {
          assert.ok(
            !block.includes(phrase),
            `${evalPath}: ${criterion[2]} contains generic language phrase ${phrase}`,
          );
        }
      }
    }
    assert.doesNotMatch(
      source,
      /language\/code-compiles-mvn-compile-gradle-compilejava/,
      evalPath,
    );
    assert.match(source, /^\s+models:\r?\n\s+- gpt-5\.6-sol$/m, evalPath);
    const scopeMatches = source.match(
      /^\s+scope: (focused-task|end-to-end-solution)$/gm,
    );
    assert.equal(scopeMatches?.length, 1, evalPath);
    assert.match(source, /^\s+evidence:\r?\n\s+- diff$/m, evalPath);
    assert.match(
      source,
      /^agent_environment:\n\s+files:\n\s+- src: \.\.\/\.\.\/eval-workspace\.gitignore\n\s+dest: \.gitignore/m,
      evalPath,
    );
    assert.match(
      source,
      /value must start with "prompt\/" or "language\/"\. Never copy a rubric\r?\n\s+list number into the criterion value\./,
      evalPath,
    );
    assert.match(
      source,
      /^\s+- src: \.\.\/\.\.\/eval-workspace-AGENTS\.md\n\s+dest: AGENTS\.md/m,
      evalPath,
    );
    if (language === "java") {
      const scenario = basename(dirname(evalPath));
      const expectedJavaCriteria = expectedJavaLanguageCriteriaByScenario[scenario];
      assert.ok(expectedJavaCriteria, `missing Java criteria expectation for ${scenario}`);
      assert.deepEqual(
        languageCriteria.toSorted(),
        expectedJavaCriteria.toSorted(),
        evalPath,
      );
      assert.match(
        source,
        /Omit explicit versions for compatible BOM-covered GA Azure artifacts\./,
        evalPath,
      );
      assert.match(
        source,
        /Authentication values come from runtime configuration or the execution environment\./,
        evalPath,
      );
      assert.doesNotMatch(
        source,
        /broad prompt inclusion is redundancy proof/i,
        evalPath,
      );
      assert.match(
        source,
        /Standard Java, Reactor, Jackson, OpenAI, and other required non-Azure imports are valid\./,
        evalPath,
      );
      assert.match(
        source,
        /Public preview SDK APIs are valid when the prompt pins or requires a preview package\./,
        evalPath,
      );
      assert.match(
        source,
        /^\s+- src: \.\.\/\.\.\/scripts\/program-checks\/java\.mjs\n\s+dest: \.vally\/program-checks\/java\.mjs$/m,
        evalPath,
      );
    } else {
      assert.doesNotMatch(source, /scripts\/program-checks\/java\.mjs/, evalPath);
    }
    if (language === "python") {
      assert.match(
        source,
        /^\s+- src: \.\.\/\.\.\/scripts\/program-checks\/python\.py\n\s+dest: \.vally\/program-checks\/python\.py$/m,
        evalPath,
      );
    } else {
      assert.doesNotMatch(source, /scripts\/program-checks\/python\.py/, evalPath);
    }
    assert.doesNotMatch(source, /^    environment:/m, evalPath);
  }
});

test("Java preservation lineage records restored standalone criteria", () => {
  const disposition = readFileSync(
    fileURLToPath(
      new URL("./docs/java-criteria-disposition.md", import.meta.url),
    ),
    "utf8",
  );
  const lineage = readFileSync(
    fileURLToPath(new URL("./docs/java-criterion-lineage.md", import.meta.url)),
    "utf8",
  );

  assert.doesNotMatch(disposition, /\|\s*[CH]\s*\|/);
  assert.match(lineage, /Original occurrences tracked: 566 total = 330 language \+ 236 prompt\./);
  assert.match(lineage, /Restored language rows: all 162 formerly `C` rows and all 8 formerly `H` rows/);
  assert.match(lineage, /Remaining language removals: 84 high-bar `R` rows only\./);
  assert.match(lineage, /Lost standalone prompt points still requiring restore\/split: 0\./);

  const languageStart = lineage.indexOf("## Language occurrence-level lineage");
  const promptStart = lineage.indexOf("## Prompt occurrence-level lineage");
  assert.ok(languageStart > 0);
  assert.ok(promptStart > languageStart);

  const languageRows = (
    lineage
      .slice(languageStart, promptStart)
      .match(/^\| \d+ \|/gm) ?? []
  ).length;
  const promptRows = (lineage.slice(promptStart).match(/^\| \d+ \|/gm) ?? [])
    .length;
  assert.equal(languageRows, 330);
  assert.equal(promptRows, 236);
});
