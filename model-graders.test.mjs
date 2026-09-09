import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const expectedLanguageCriteria = {
  dotnet: 3,
  go: 0,
  java: 11,
  python: 5,
  typescript: 10,
};

const expectedJavaGlobalCriteria = {
  "language/service-native-pagination": [
    "Applicable list/query operations use SDK-native lazy pagination, such as",
    "PagedIterable, PagedFlux, autoPager(), or equivalent, without eagerly",
    "collecting all results. Passes when no paginated operation exists.",
  ].join("\n"),
  "language/lro-pattern-syncpoller-pollerflux": [
    "Long-running operations use the SDK-native completion mechanism. Accept Azure",
    "Core `begin*` methods with `SyncPoller`/`PollerFlux`; blocking management",
    "fluent calls; and service-native status retrieval when no poller exists. Do",
    "not require `begin*` when the SDK provides a blocking operation. Reject manual",
    "sleep-based polling only when an SDK polling abstraction is available. Pass",
    "when no LRO occurs.",
  ].join("\n"),
};

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function javaGlobalCriterionBlock(name, description) {
  return [
    `            - name: ${name}`,
    "              description: |-",
    ...description.split("\n").map((line) => `                ${line}`),
    "              weight: 1",
    "              pass_threshold: 1",
  ].join("\n");
}

function assertExactJavaGlobalCriterion(source, context, name, description) {
  const namePattern = new RegExp(
    `^\\s+- name: ${escapeRegExp(name)}$`,
    "gm",
  );
  assert.equal(
    [...source.matchAll(namePattern)].length,
    1,
    `${context}: expected exactly one ${name} criterion`,
  );

  const blockPattern = new RegExp(
    `^${escapeRegExp(javaGlobalCriterionBlock(name, description))}` +
      "(?=\\n(?:            - name: |      - type: )|$)",
    "gm",
  );
  assert.equal(
    [...source.matchAll(blockPattern)].length,
    1,
    `${context}: expected one exact ${name} criterion block`,
  );
}

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
    assert.equal(
      languageCriteria.length,
      expectedLanguageCriteria[language],
      evalPath,
    );
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
      assert.match(
        source,
        /^\s+- src: \.\.\/\.\.\/scripts\/program-checks\/java\.mjs\n\s+dest: \.vally\/program-checks\/java\.mjs$/m,
        evalPath,
      );
      for (const [name, description] of Object.entries(
        expectedJavaGlobalCriteria,
      )) {
        assertExactJavaGlobalCriterion(source, evalPath, name, description);
      }
      assert.doesNotMatch(
        source,
        /language\/pagination-pagediterable-pagedflux/,
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

test("Java global criteria reject appended description lines", () => {
  const [name, description] = Object.entries(expectedJavaGlobalCriteria)[0];
  const canonicalLines = javaGlobalCriterionBlock(name, description).split("\n");
  const driftedLines = [...canonicalLines];
  driftedLines.splice(-2, 0, "                Appended description drift.");
  const nextCriterion = "            - name: language/next-criterion";

  assert.doesNotThrow(() =>
    assertExactJavaGlobalCriterion(
      `${canonicalLines.join("\n")}\n${nextCriterion}`,
      "canonical fixture",
      name,
      description,
    ),
  );
  assert.throws(
    () =>
      assertExactJavaGlobalCriterion(
        `${driftedLines.join("\n")}\n${nextCriterion}`,
        "drifted fixture",
        name,
        description,
      ),
    /criterion block/,
  );
});
