import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

function findFiles(root, name) {
  const matches = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      matches.push(...findFiles(entryPath, name));
    } else if (entry.isFile() && entry.name === name) {
      matches.push(entryPath);
    }
  }
  return matches;
}

function shardKey({ language, variant }) {
  return `${language}/${variant}`;
}

function extractCriteria(gradeResult) {
  const pending = [gradeResult];
  while (pending.length > 0) {
    const detail = pending.shift();
    if (Array.isArray(detail?.metadata?.criteria)) {
      return detail.metadata.criteria;
    }
    if (Array.isArray(detail?.details)) {
      pending.push(...detail.details);
    }
  }
  return [];
}

function percentage(passed, total) {
  return total === 0 ? "n/a" : `${((passed / total) * 100).toFixed(1)}%`;
}

function addCriteria(target, criteria) {
  for (const criterion of criteria) {
    const group = criterion.name?.startsWith("prompt/")
      ? "prompt"
      : criterion.name?.startsWith("language/")
        ? "languageCriteria"
        : "other";
    target[group].total += 1;
    if (criterion.passed) {
      target[group].passed += 1;
    }
  }
}

function renderScore(score) {
  const passed =
    score.prompt.passed + score.languageCriteria.passed + score.other.passed;
  const total = score.prompt.total + score.languageCriteria.total + score.other.total;
  return `${passed}/${total} (${percentage(passed, total)})`;
}

export function summarizeReports({ inputDir, expectedMatrix }) {
  const expected = new Map(
    expectedMatrix.include.map((shard) => [shardKey(shard), shard]),
  );
  const manifests = new Map();
  const problems = [];

  for (const manifestPath of findFiles(inputDir, "evaluation-shard.json")) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const key = shardKey(manifest);
    if (manifests.has(key)) {
      problems.push(`Duplicate shard manifest: ${key}`);
    } else {
      manifests.set(key, { ...manifest, manifestPath });
    }
  }

  for (const key of expected.keys()) {
    if (!manifests.has(key)) {
      problems.push(`Missing shard artifact: ${key}`);
    }
  }
  for (const key of manifests.keys()) {
    if (!expected.has(key)) {
      problems.push(`Unexpected shard artifact: ${key}`);
    }
  }

  const resultKeys = new Set();
  const rows = [];
  for (const [key, manifest] of manifests) {
    const resultFiles = findFiles(path.dirname(manifest.manifestPath), "results.jsonl");
    const shardRows = [];
    for (const resultFile of resultFiles) {
      const lines = readFileSync(resultFile, "utf8")
        .split(/\r?\n/)
        .filter((line) => line.trim());
      for (const [index, line] of lines.entries()) {
        try {
          shardRows.push(JSON.parse(line));
        } catch (error) {
          problems.push(
            `Malformed result in ${key} (${path.basename(resultFile)}:${index + 1}): ${error.message}`,
          );
        }
      }
    }

    const expectedCount = expected.get(key)?.evaluations;
    if (
      expectedCount !== undefined &&
      manifest.expectedEvaluations !== expectedCount
    ) {
      problems.push(
        `Manifest count mismatch in ${key}: expected ${expectedCount}, manifest reports ${manifest.expectedEvaluations}`,
      );
    }
    if (expectedCount !== undefined && shardRows.length !== expectedCount) {
      problems.push(
        `Incomplete shard ${key}: expected ${expectedCount} result(s), found ${shardRows.length}`,
      );
    }

    for (const row of shardRows) {
      const resultKey = `${row.variant}/${row.evalName}`;
      if (resultKeys.has(resultKey)) {
        problems.push(`Duplicate result: ${resultKey}`);
        continue;
      }
      resultKeys.add(resultKey);
      rows.push({ ...row, language: manifest.language });
      if (row.variant !== manifest.variant) {
        problems.push(
          `Variant mismatch in ${key}: result ${row.evalName} reports ${row.variant}`,
        );
      }
      if (row.status !== "success") {
        problems.push(
          `Unsuccessful trial in ${key}: ${row.evalName} has status ${row.status}`,
        );
      }
    }
  }

  const summaries = new Map();
  const variantSummaries = new Map();
  for (const row of rows) {
    const key = shardKey(row);
    if (!summaries.has(key)) {
      summaries.set(key, {
        language: row.language,
        variant: row.variant,
        trials: 0,
        passedTrials: 0,
        prompt: { passed: 0, total: 0 },
        languageCriteria: { passed: 0, total: 0 },
        other: { passed: 0, total: 0 },
      });
    }
    if (!variantSummaries.has(row.variant)) {
      variantSummaries.set(row.variant, {
        trials: 0,
        passedTrials: 0,
        prompt: { passed: 0, total: 0 },
        languageCriteria: { passed: 0, total: 0 },
        other: { passed: 0, total: 0 },
      });
    }
    const summary = summaries.get(key);
    const variantSummary = variantSummaries.get(row.variant);
    summary.trials += 1;
    variantSummary.trials += 1;
    const criteria = extractCriteria(row.gradeResult);
    if (criteria.length === 0) {
      problems.push(`No criterion results found: ${row.variant}/${row.evalName}`);
    } else {
      const perfect = criteria.every((criterion) => criterion.passed);
      summary.passedTrials += perfect ? 1 : 0;
      variantSummary.passedTrials += perfect ? 1 : 0;
      addCriteria(summary, criteria);
      addCriteria(variantSummary, criteria);
    }
  }

  const lines = [
    "# Vally evaluation summary",
    "",
    `Completed ${rows.length} trial(s) across ${manifests.size}/${expected.size} shard(s).`,
    "",
    "## Variant totals",
    "",
    "| Variant | Trials | Perfect | Prompt | Language | Overall |",
    "|---|---:|---:|---:|---:|---:|",
  ];
  for (const variant of [
    ...new Set(expectedMatrix.include.map((shard) => shard.variant)),
  ]) {
    const summary = variantSummaries.get(variant);
    if (!summary) {
      lines.push(`| ${variant} | 0 | 0 | n/a | n/a | n/a |`);
      continue;
    }
    lines.push(
      `| ${variant} | ${summary.trials} | ${summary.passedTrials} | ${summary.prompt.passed}/${summary.prompt.total} (${percentage(summary.prompt.passed, summary.prompt.total)}) | ${summary.languageCriteria.passed}/${summary.languageCriteria.total} (${percentage(summary.languageCriteria.passed, summary.languageCriteria.total)}) | ${renderScore(summary)} |`,
    );
  }

  lines.push(
    "",
    "## Shards",
    "",
    "| Language | Variant | Trials | Perfect | Prompt | Language | Overall |",
    "|---|---|---:|---:|---:|---:|---:|",
  );
  for (const shard of expectedMatrix.include) {
    const key = shardKey(shard);
    const summary = summaries.get(key);
    if (!summary) {
      lines.push(
        `| ${shard.language} | ${shard.variant} | 0/${shard.evaluations} | 0 | n/a | n/a | n/a |`,
      );
      continue;
    }
    lines.push(
      `| ${summary.language} | ${summary.variant} | ${summary.trials}/${shard.evaluations} | ${summary.passedTrials} | ${summary.prompt.passed}/${summary.prompt.total} (${percentage(summary.prompt.passed, summary.prompt.total)}) | ${summary.languageCriteria.passed}/${summary.languageCriteria.total} (${percentage(summary.languageCriteria.passed, summary.languageCriteria.total)}) | ${renderScore(summary)} |`,
    );
  }

  lines.push("", "## Integrity");
  if (problems.length === 0) {
    lines.push("", "All expected shards and trial results were collected without integrity errors.");
  } else {
    lines.push("", ...problems.map((problem) => `- ${problem}`));
  }
  lines.push("");

  return {
    markdown: lines.join("\n"),
    problems,
    rows,
  };
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!value || !["--input-dir", "--expected-matrix", "--output"].includes(name)) {
      throw new Error(
        "Usage: summarize-reports.mjs --input-dir <dir> --expected-matrix <json> --output <file>",
      );
    }
    options[
      {
        "--input-dir": "inputDir",
        "--expected-matrix": "expectedMatrix",
        "--output": "output",
      }[name]
    ] = value;
  }
  if (!options.inputDir || !options.expectedMatrix || !options.output) {
    throw new Error(
      "Usage: summarize-reports.mjs --input-dir <dir> --expected-matrix <json> --output <file>",
    );
  }
  return options;
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const result = summarizeReports({
    inputDir: path.resolve(options.inputDir),
    expectedMatrix: JSON.parse(options.expectedMatrix),
  });
  writeFileSync(options.output, result.markdown);
  console.log(result.markdown);
  if (result.problems.length > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
