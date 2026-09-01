import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { summarizeReports } from "./summarize-reports.mjs";

function criterion(name, passed) {
  return { name, passed };
}

function program(name, passed, status) {
  return {
    name,
    graderType: "run-command",
    passed,
    ...(status && {
      details: [{ name: "exit-code", status, passed: false }],
    }),
  };
}

function programFor(language, passed = true) {
  return program(
    {
      dotnet: "program/dotnet-project-builds",
      go: "program/go-project-tests",
      java: "program/java-project-compiles",
      python: "program/python-source-compiles",
      typescript: "program/typescript-dependencies-install",
    }[language],
    passed,
  );
}

function result(
  evalName,
  variant,
  criteria,
  { programs = [programFor("python")], status = "success" } = {},
) {
  return {
    evalName,
    variant,
    status,
    gradeResult: {
      passed:
        criteria.every((item) => item.passed) &&
        programs.every((item) => item.passed),
      details: [{ metadata: { criteria } }, ...programs],
    },
  };
}

function writeShard(root, language, variant, expectedEvaluations, results) {
  const shard = path.join(root, `${language}-${variant}`);
  mkdirSync(path.join(shard, "reports"), { recursive: true });
  writeFileSync(
    path.join(shard, "evaluation-shard.json"),
    JSON.stringify({ language, variant, expectedEvaluations }),
  );
  writeFileSync(
    path.join(shard, "reports", "shard-manifest.json"),
    JSON.stringify({ experiment: { name: "native-vally-manifest" } }),
  );
  writeFileSync(
    path.join(shard, "reports", "results.jsonl"),
    `${results.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
}

test("aggregates complete language and variant shards", () => {
  const root = mkdtempSync(path.join(tmpdir(), "vally-summary-"));
  writeShard(root, "python", "baseline", 1, [
    result("python-eval", "baseline", [
      criterion("prompt/feature", true),
      criterion("language/imports", false),
    ], {
      programs: [program("program/python-source-compiles", false)],
    }),
  ]);
  writeShard(root, "dotnet", "baseline", 1, [
    result("dotnet-eval", "baseline", [
      criterion("prompt/feature", true),
      criterion("language/packages", true),
    ], {
      programs: [programFor("dotnet")],
    }),
  ]);

  const summary = summarizeReports({
    inputDir: root,
    expectedMatrix: {
      include: [
        { language: "python", variant: "baseline", evaluations: 1 },
        { language: "dotnet", variant: "baseline", evaluations: 1 },
      ],
    },
  });

  assert.deepEqual(summary.problems, []);
  assert.match(
    summary.markdown,
    /baseline \| 2 \| 2\/2 \(100\.0%\) \| 1\/2 \(50\.0%\) \| 1\/2 \(50\.0%\)/,
  );
  assert.match(
    summary.markdown,
    /python \| baseline \| 1\/1 \| 1\/1 \(100\.0%\) \| 0\/1 \(0\.0%\) \| 0\/1 \(0\.0%\)/,
  );
  assert.match(
    summary.markdown,
    /dotnet \| baseline \| 1\/1 \| 1\/1 \(100\.0%\) \| 1\/1 \(100\.0%\) \| 1\/1 \(100\.0%\)/,
  );
});

test("aggregates categories independently of the outer grade status", () => {
  const root = mkdtempSync(path.join(tmpdir(), "vally-summary-"));
  const row = result("python-eval", "baseline", [
    criterion("prompt/feature", true),
    criterion("language/imports", true),
  ]);
  row.gradeResult.passed = false;
  writeShard(root, "python", "baseline", 1, [row]);

  const summary = summarizeReports({
    inputDir: root,
    expectedMatrix: {
      include: [{ language: "python", variant: "baseline", evaluations: 1 }],
    },
  });

  assert.deepEqual(summary.problems, []);
  assert.match(
    summary.markdown,
    /python \| baseline \| 1\/1 \| 1\/1 \(100\.0%\) \| 1\/1 \(100\.0%\) \| 1\/1 \(100\.0%\)/,
  );
});

test("reports missing, incomplete, duplicate, and unsuccessful results", () => {
  const root = mkdtempSync(path.join(tmpdir(), "vally-summary-"));
  const duplicate = result(
    "python-eval",
    "baseline",
    [criterion("prompt/feature", true)],
    { status: "error" },
  );
  writeShard(root, "python", "baseline", 3, [duplicate, duplicate]);

  const summary = summarizeReports({
    inputDir: root,
    expectedMatrix: {
      include: [
        { language: "python", variant: "baseline", evaluations: 3 },
        { language: "java", variant: "baseline", evaluations: 1 },
      ],
    },
  });

  assert.ok(
    summary.problems.some((problem) => problem === "Missing shard artifact: java/baseline"),
  );
  assert.ok(
    summary.problems.some((problem) =>
      problem.startsWith("Incomplete shard python/baseline"),
    ),
  );
  assert.ok(
    summary.problems.some((problem) => problem === "Duplicate result: baseline/python-eval"),
  );
  assert.ok(
    summary.problems.some((problem) =>
      problem.startsWith("Unsuccessful trial in python/baseline"),
    ),
  );
});

test("reports missing and errored program checks", () => {
  const root = mkdtempSync(path.join(tmpdir(), "vally-summary-"));
  writeShard(root, "python", "baseline", 2, [
    result("missing-program", "baseline", [], { programs: [] }),
    result("errored-program", "baseline", [], {
      programs: [
        program("program/python-source-compiles", false, "error"),
      ],
    }),
  ]);

  const summary = summarizeReports({
    inputDir: root,
    expectedMatrix: {
      include: [{ language: "python", variant: "baseline", evaluations: 2 }],
    },
  });

  assert.ok(
    summary.problems.includes(
      "No program check results found: baseline/missing-program",
    ),
  );
  assert.ok(
    summary.problems.includes(
      "Program check error: baseline/errored-program/program/python-source-compiles",
    ),
  );
});

test("reports an incomplete TypeScript program-check set", () => {
  const root = mkdtempSync(path.join(tmpdir(), "vally-summary-"));
  writeShard(root, "typescript", "baseline", 1, [
    result("typescript-eval", "baseline", [], {
      programs: [programFor("typescript")],
    }),
  ]);

  const summary = summarizeReports({
    inputDir: root,
    expectedMatrix: {
      include: [
        { language: "typescript", variant: "baseline", evaluations: 1 },
      ],
    },
  });

  assert.ok(
    summary.problems.includes(
      "Missing program check: baseline/typescript-eval/program/typescript-type-checks",
    ),
  );
  assert.match(
    summary.markdown,
    /typescript \| baseline \| 1\/1 \| 0\/0 \(n\/a\) \| 0\/0 \(n\/a\) \| 1\/2 \(50\.0%\)/,
  );
});

test("excludes duplicate and unexpected checks from program totals", () => {
  const root = mkdtempSync(path.join(tmpdir(), "vally-summary-"));
  writeShard(root, "typescript", "baseline", 1, [
    result("typescript-eval", "baseline", [], {
      programs: [
        program("program/typescript-dependencies-install", true),
        program("program/typescript-dependencies-install", true),
        program("program/typescript-type-checks", true),
        program("program/unexpected", true),
      ],
    }),
  ]);

  const summary = summarizeReports({
    inputDir: root,
    expectedMatrix: {
      include: [
        { language: "typescript", variant: "baseline", evaluations: 1 },
      ],
    },
  });

  assert.ok(
    summary.problems.includes(
      "Duplicate program check: baseline/typescript-eval/program/typescript-dependencies-install",
    ),
  );
  assert.ok(
    summary.problems.includes(
      "Unexpected program check: baseline/typescript-eval/program/unexpected",
    ),
  );
  assert.match(
    summary.markdown,
    /typescript \| baseline \| 1\/1 \| 0\/0 \(n\/a\) \| 0\/0 \(n\/a\) \| 1\/2 \(50\.0%\)/,
  );
});
