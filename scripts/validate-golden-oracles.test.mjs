import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  adaptProgramCommandsForHost,
  addGoldenPatch,
  createGoldenPatch,
  listGoldenFiles,
  oracleSummaryFailed,
  summarizeOracleOutcome,
} from "./validate-golden-oracles.mjs";

test("creates a patch that materializes golden files at workspace root", () => {
  const root = mkdtempSync(path.join(tmpdir(), "golden-oracle-test-"));
  const golden = path.join(root, "golden");
  const workspace = path.join(root, "workspace");
  mkdirSync(path.join(golden, "src"), { recursive: true });
  mkdirSync(workspace);
  writeFileSync(path.join(golden, "src", "app.py"), "value = 1\n");
  writeFileSync(path.join(golden, "requirements.txt"), "azure-identity\n");

  try {
    const patch = createGoldenPatch(golden, [
      "requirements.txt",
      path.join("src", "app.py"),
    ]);
    const result = spawnSync("git", ["apply", "--whitespace=nowarn", "-"], {
      cwd: workspace,
      input: patch,
      encoding: "utf8",
    });

    test("lists tracked golden files without ignored build output", () => {
      const root = mkdtempSync(path.join(tmpdir(), "golden-oracle-files-"));
      const golden = path.join(root, "scenarios", "example", "golden");
      mkdirSync(path.join(golden, "src"), { recursive: true });
      mkdirSync(path.join(golden, "node_modules"), { recursive: true });
      writeFileSync(path.join(root, ".gitignore"), "node_modules/\n");
      writeFileSync(path.join(golden, "src", "app.ts"), "export {};\n");
      writeFileSync(path.join(golden, "node_modules", "ignored.js"), "bad(\n");

      try {
        assert.equal(
          spawnSync("git", ["init", "--quiet"], { cwd: root }).status,
          0,
        );
        assert.deepEqual(listGoldenFiles(root, golden), [
          "src/app.ts",
        ]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      readFileSync(path.join(workspace, "src", "app.py"), "utf8").replaceAll(
        "\r\n",
        "\n",
      ),
      "value = 1\n",
    );
    assert.equal(
      readFileSync(
        path.join(workspace, "requirements.txt"),
        "utf8",
      ).replaceAll("\r\n", "\n"),
      "azure-identity\n",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("adds a golden patch to the first stimulus", () => {
  const source =
    "stimuli:\n  - name: example\n    prompt: hello\n    graders:\n      - type: panel\n        config:\n          evidence:\n            - trajectory\n            - repo\n";
  assert.equal(
    addGoldenPatch(source),
    "stimuli:\n  - name: example\n    golden_patch:\n      path: .vally-oracle-golden.patch\n    prompt: hello\n    graders:\n      - type: panel\n        config:\n          evidence:\n            - trajectory\n            - repo\n            - golden_patch\n",
  );
});

test("uses Windows command shims only in temporary oracle specs", () => {
  const source =
    "config:\n  command: npm\n  args:\n    - install\nother:\n  command: npx\n  args:\n    - tsc\nthird:\n  command: node\n";
  assert.equal(
    adaptProgramCommandsForHost(source, "win32"),
    "config:\n  command: cmd.exe\n  args:\n    - /d\n    - /s\n    - /c\n    - npm\n    - install\nother:\n  command: cmd.exe\n  args:\n    - /d\n    - /s\n    - /c\n    - npx\n    - tsc\nthird:\n  command: node\n",
  );
  assert.equal(adaptProgramCommandsForHost(source, "linux"), source);
});

test("summarizes prompt, language, and program outcomes independently", () => {
  const outcome = {
    status: "success",
    gradeResult: {
      details: [
        {
          name: "prompt/full-case-review",
          details: [
            {
              name: "panel/criterion/prompt/feature",
              passed: true,
              metadata: { criterion: "prompt/feature" },
            },
            {
              name: "panel/criterion/language/usage",
              passed: false,
              metadata: { criterion: "language/usage" },
            },
          ],
        },
        {
          name: "program/python-source-compiles",
          passed: true,
          graderType: "run-command",
        },
      ],
    },
  };

  const summary = summarizeOracleOutcome(outcome);

  assert.equal(summary.error, null);
  assert.deepEqual(summary.prompt.map((result) => result.passed), [true]);
  assert.deepEqual(summary.language.map((result) => result.passed), [false]);
  assert.deepEqual(summary.program.map((result) => result.passed), [true]);
  assert.equal(oracleSummaryFailed(summary), true);
});

test("fails an oracle summary with a language failure", () => {
  assert.equal(
    oracleSummaryFailed({
      error: null,
      prompt: [{ passed: true }],
      language: [{ passed: false }],
      program: [{ passed: true }],
    }),
    true,
  );
});
