import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { summarizeReports } from "./summarize-reports.mjs";

function criterion(name, passed) {
  return { name, passed };
}

function result(evalName, variant, criteria, status = "success") {
  return {
    evalName,
    variant,
    status,
    gradeResult: {
      passed: criteria.every((item) => item.passed),
      details: [{ metadata: { criteria } }],
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
    ]),
  ]);
  writeShard(root, "dotnet", "baseline", 1, [
    result("dotnet-eval", "baseline", [
      criterion("prompt/feature", true),
      criterion("language/packages", true),
    ]),
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
  assert.match(summary.markdown, /baseline \| 2 \| 1 \| 2\/2 \(100\.0%\)/);
  assert.match(summary.markdown, /python \| baseline \| 1\/1 \| 0 \| 1\/1/);
  assert.match(summary.markdown, /dotnet \| baseline \| 1\/1 \| 1 \| 1\/1/);
});

test("counts perfect criteria independently of the outer grade status", () => {
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
  assert.match(summary.markdown, /python \| baseline \| 1\/1 \| 1 \|/);
});

test("reports missing, incomplete, duplicate, and unsuccessful results", () => {
  const root = mkdtempSync(path.join(tmpdir(), "vally-summary-"));
  const duplicate = result(
    "python-eval",
    "baseline",
    [criterion("prompt/feature", true)],
    "error",
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
