import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const expectedLanguageCriteria = {
  dotnet: 3,
  java: 12,
  python: 5,
  typescript: 10,
};

const scenarioRoot = fileURLToPath(new URL("./scenarios/", import.meta.url));
const evalPaths = readdirSync(scenarioRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(scenarioRoot, entry.name, "eval.yaml"));

test("every eval uses one complete model review", () => {
  assert.equal(evalPaths.length, 72);

  for (const evalPath of evalPaths) {
    const source = readFileSync(evalPath, "utf8");
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
      (source.match(/^\s+- type: (?:run-command|program)$/gm) ?? []).length,
      0,
      evalPath,
    );
    assert.equal(
      (source.match(/^\s+required: true$/gm) ?? []).length,
      criterionNames.length,
      evalPath,
    );
    assert.equal(
      languageCriteria.length,
      expectedLanguageCriteria[language],
      evalPath,
    );
    assert.match(source, /^\s+models:\r?\n\s+- gpt-5\.6-sol$/m, evalPath);
    assert.match(source, /^\s+evidence:\r?\n\s+- diff$/m, evalPath);
    assert.doesNotMatch(source, /^    environment:/m, evalPath);
  }
});
