import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const checker = path.resolve("scripts/program-checks/python.py");

function workspace() {
  return mkdtempSync(path.join(tmpdir(), "python-program-check-"));
}

function runChecker(root) {
  return spawnSync("python", [checker], {
    cwd: root,
    encoding: "utf8",
  });
}

test("ignores invalid Python templates inside injected skills", () => {
  const root = workspace();
  writeFileSync(path.join(root, "app.py"), "value: int = 1\n");
  const skill = path.join(root, "template-skill");
  mkdirSync(path.join(skill, "assets"), { recursive: true });
  writeFileSync(path.join(skill, "SKILL.md"), "# Template skill\n");
  writeFileSync(
    path.join(skill, "assets", "template.py"),
    "class {{ResourceName}}:\n    pass\n",
  );

  const result = runChecker(root);

  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("ignores invalid Python files in non-application directories", () => {
  const root = workspace();
  writeFileSync(path.join(root, "app.py"), "value: int = 1\n");
  for (const directory of ["build", "dist", ".pytest_cache"]) {
    mkdirSync(path.join(root, directory), { recursive: true });
    writeFileSync(
      path.join(root, directory, "generated.py"),
      "class {{ResourceName}}:\n    pass\n",
    );
  }

  const result = runChecker(root);

  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("fails for invalid generated application source", () => {
  const root = workspace();
  writeFileSync(path.join(root, "app.py"), "def broken(:\n    pass\n");

  const result = runChecker(root);

  assert.equal(result.status, 1);
  assert.match(result.stdout, /SyntaxError/);
});
