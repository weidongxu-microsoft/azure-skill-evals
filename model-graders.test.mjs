import assert from "node:assert/strict";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
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

const canonicalJavaBomDescription = [
  "- Imports a pinned `com.azure:azure-sdk-bom` in Maven `dependencyManagement`.",
  "- Direct Azure SDK dependencies omit `<version>` when the BOM provides a compatible version.",
  "- An artifact absent from the BOM may declare its version on the direct dependency.",
  "- A BOM-managed artifact may override its version in `dependencyManagement` only when the task requires an API/version unavailable from the BOM.",
].join("\n");

const canonicalJavaBomCriterionSource = `            - name: language/azure-sdk-bom-for-version-management
              description: |-
                - Imports a pinned \`com.azure:azure-sdk-bom\` in Maven \`dependencyManagement\`.
                - Direct Azure SDK dependencies omit \`<version>\` when the BOM provides a compatible version.
                - An artifact absent from the BOM may declare its version on the direct dependency.
                - A BOM-managed artifact may override its version in \`dependencyManagement\` only when the task requires an API/version unavailable from the BOM.
              weight: 1
              pass_threshold: 1`;

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

const vallyCliRoot = realpathSync(
  fileURLToPath(new URL("./node_modules/@microsoft/vally-cli/", import.meta.url)),
);
const requireFromCli = createRequire(join(vallyCliRoot, "package.json"));
const requireFromVally = createRequire(requireFromCli.resolve("@microsoft/vally"));
const { parse: parseYaml } = requireFromVally("yaml");

function validateEvalSource(rawSource, evalPath) {
    const source = rawSource.replaceAll("\r\n", "\n");
    const evaluation = parseYaml(source);
    const graders = evaluation.stimuli.flatMap((stimulus) => stimulus.graders);
    const panelGraders = graders.filter(({ type }) => type === "panel");
    assert.equal(panelGraders.length, 1, evalPath);
    const panelCriteria = panelGraders[0].config.criteria;
    const language = evaluation.stimuli[0].tags.language;
    const criterionNames = panelCriteria.map(({ name }) => name);
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
      const bomCriteria = panelCriteria.filter(
        ({ name }) =>
          name === "language/azure-sdk-bom-for-version-management",
      );
      assert.equal(
        bomCriteria.length,
        1,
        `${evalPath}: expected one canonical BOM criterion in panel criteria`,
      );
      assert.deepEqual(
        bomCriteria[0],
        {
          name: "language/azure-sdk-bom-for-version-management",
          description: canonicalJavaBomDescription,
          weight: 1,
          pass_threshold: 1,
        },
        `${evalPath}: invalid canonical BOM criterion`,
      );
    } else {
      assert.doesNotMatch(source, /scripts\/program-checks\/java\.mjs/, evalPath);
    }
    assert.equal(
      languageCriteria.length,
      expectedLanguageCriteria[language],
      evalPath,
    );
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

test("every eval uses one complete model review and program checks", () => {
  for (const evalPath of evalPaths) {
    validateEvalSource(readFileSync(evalPath, "utf8"), evalPath);
  }
});

test("Java BOM criterion must be in the panel criteria array", () => {
  const evalPath = join(
    scenarioRoot,
    "app-configuration-java-config-values",
    "eval.yaml",
  );
  const source = readFileSync(evalPath, "utf8").replaceAll("\r\n", "\n");
  const withoutCriterion = source.replace(canonicalJavaBomCriterionSource, "");
  assert.notEqual(withoutCriterion, source, "invalid test mutation");
  const relocated = withoutCriterion.replace(
    "    tags:\n",
    `${canonicalJavaBomCriterionSource}\n    tags:\n`,
  );

  assert.throws(
    () => validateEvalSource(relocated, evalPath),
    /expected one canonical BOM criterion in panel criteria/,
  );
});
