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

test("workspace diff includes modern .NET solution files", () => {
  const source = readFileSync(
    fileURLToPath(new URL("./eval-workspace.gitignore", import.meta.url)),
    "utf8",
  );

  assert.match(source, /^!\*\.slnx$/m);
});

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
    if (evalPath.includes("foundry-") && evalPath.includes("-support-assistant")) {
      assert.match(source, /^\s+output_delivery: workspace$/m, evalPath);
      assert.match(
        source,
        /^\s+workspace_evidence_max_chars: 128000$/m,
        evalPath,
      );
    }
    if (evalPath.includes("foundry-dotnet-support-assistant")) {
      assert.match(source, /^\s+- "\*\*\/\*\.slnx"$/m, evalPath);
    }
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
