import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url));
let evalServices;

const expectedProgramChecks = {
  dotnet: ["program/dotnet-project-builds"],
  go: ["program/go-project-tests"],
  java: ["program/java-project-compiles"],
  python: ["program/python-source-compiles"],
  typescript: [
    "program/typescript-dependencies-install",
    "program/typescript-type-checks",
  ],
};

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

function serviceKey({ service, variant }) {
  return `${service}/${variant}`;
}

function loadEvalServices() {
  if (evalServices) {
    return evalServices;
  }
  evalServices = new Map();
  const scenariosPath = path.join(REPOSITORY_ROOT, "scenarios");
  for (const entry of readdirSync(scenariosPath, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const evalPath = path.join(scenariosPath, entry.name, "eval.yaml");
    let source;
    try {
      source = readFileSync(evalPath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    const evalName = source.match(/^name:\s*(\S+)\s*$/m)?.[1];
    const service = source.match(/^\s+service:\s*(\S+)\s*$/m)?.[1];
    if (evalName && service) {
      evalServices.set(evalName, service);
    }
  }
  return evalServices;
}

function serviceForRow(row) {
  if (typeof row.service === "string" && row.service) {
    return row.service;
  }
  const service = loadEvalServices().get(row.evalName);
  if (!service) {
    throw new Error(`Service tag not found for ${row.evalName}`);
  }
  return service;
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

function extractProgramChecks(gradeResult) {
  const checks = [];
  const pending = [gradeResult];
  while (pending.length > 0) {
    const detail = pending.shift();
    if (detail?.graderType === "run-command") {
      checks.push(detail);
    }
    if (Array.isArray(detail?.details)) {
      pending.push(...detail.details);
    }
  }
  return checks;
}

function hasGraderError(result) {
  if (result?.status === "error") {
    return true;
  }
  return Array.isArray(result?.details)
    ? result.details.some((detail) => hasGraderError(detail))
    : false;
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
  const serviceSummaries = new Map();
  for (const row of rows) {
    const key = shardKey(row);
    let service;
    try {
      service = serviceForRow(row);
    } catch (error) {
      problems.push(error.message);
      service = "unknown";
    }
    const groupedServiceKey = serviceKey({ service, variant: row.variant });
    if (!summaries.has(key)) {
      summaries.set(key, {
        language: row.language,
        variant: row.variant,
        trials: 0,
        prompt: { passed: 0, total: 0 },
        languageCriteria: { passed: 0, total: 0 },
        other: { passed: 0, total: 0 },
        program: { passed: 0, total: 0 },
      });
    }
    if (!variantSummaries.has(row.variant)) {
      variantSummaries.set(row.variant, {
        trials: 0,
        prompt: { passed: 0, total: 0 },
        languageCriteria: { passed: 0, total: 0 },
        other: { passed: 0, total: 0 },
        program: { passed: 0, total: 0 },
      });
    }
    if (!serviceSummaries.has(groupedServiceKey)) {
      serviceSummaries.set(groupedServiceKey, {
        service,
        variant: row.variant,
        trials: 0,
        prompt: { passed: 0, total: 0 },
        languageCriteria: { passed: 0, total: 0 },
        other: { passed: 0, total: 0 },
        program: { passed: 0, total: 0 },
      });
    }
    const summary = summaries.get(key);
    const variantSummary = variantSummaries.get(row.variant);
    const serviceSummary = serviceSummaries.get(groupedServiceKey);
    summary.trials += 1;
    variantSummary.trials += 1;
    serviceSummary.trials += 1;
    const criteria = extractCriteria(row.gradeResult);
    if (criteria.length === 0) {
      problems.push(`No criterion results found: ${row.variant}/${row.evalName}`);
    } else {
      addCriteria(summary, criteria);
      addCriteria(variantSummary, criteria);
      addCriteria(serviceSummary, criteria);
    }
    const programChecks = extractProgramChecks(row.gradeResult);
    if (programChecks.length === 0) {
      problems.push(`No program check results found: ${row.variant}/${row.evalName}`);
    }
    const expectedNames = expectedProgramChecks[row.language] ?? [];
    const actualNames = programChecks.map((check) => check.name);
    for (const expectedName of expectedNames) {
      const matchingChecks = programChecks.filter(
        (check) => check.name === expectedName,
      );
      summary.program.total += 1;
      variantSummary.program.total += 1;
      serviceSummary.program.total += 1;
      if (matchingChecks.length === 1 && matchingChecks[0].passed) {
        summary.program.passed += 1;
        variantSummary.program.passed += 1;
        serviceSummary.program.passed += 1;
      }
      if (matchingChecks.length === 0) {
        problems.push(
          `Missing program check: ${row.variant}/${row.evalName}/${expectedName}`,
        );
      } else if (matchingChecks.length > 1) {
        problems.push(
          `Duplicate program check: ${row.variant}/${row.evalName}/${expectedName}`,
        );
      }
    }
    for (const actualName of new Set(actualNames)) {
      if (!expectedNames.includes(actualName)) {
        problems.push(
          `Unexpected program check: ${row.variant}/${row.evalName}/${actualName}`,
        );
      }
    }
    for (const check of programChecks.filter((item) => hasGraderError(item))) {
      problems.push(
        `Program check error: ${row.variant}/${row.evalName}/${check.name}`,
      );
    }
  }

  const lines = [
    "# Vally evaluation summary",
    "",
    `Completed ${rows.length} trial(s) across ${manifests.size}/${expected.size} shard(s).`,
    "",
    "## Variant totals",
    "",
    "| Variant | Trials | Prompt | Language | Program |",
    "|---|---:|---:|---:|---:|",
  ];
  for (const variant of [
    ...new Set(expectedMatrix.include.map((shard) => shard.variant)),
  ]) {
    const summary = variantSummaries.get(variant);
    if (!summary) {
      lines.push(`| ${variant} | 0 | n/a | n/a | n/a |`);
      continue;
    }
    lines.push(
      `| ${variant} | ${summary.trials} | ${summary.prompt.passed}/${summary.prompt.total} (${percentage(summary.prompt.passed, summary.prompt.total)}) | ${summary.languageCriteria.passed}/${summary.languageCriteria.total} (${percentage(summary.languageCriteria.passed, summary.languageCriteria.total)}) | ${summary.program.passed}/${summary.program.total} (${percentage(summary.program.passed, summary.program.total)}) |`,
    );
  }

  lines.push(
    "",
    "## Service totals",
    "",
    "| Service | Variant | Trials | Prompt | Language | Program |",
    "|---|---|---:|---:|---:|---:|",
  );
  for (const summary of [...serviceSummaries.values()].sort(
    (left, right) =>
      left.service.localeCompare(right.service) ||
      left.variant.localeCompare(right.variant),
  )) {
    lines.push(
      `| ${summary.service} | ${summary.variant} | ${summary.trials} | ${summary.prompt.passed}/${summary.prompt.total} (${percentage(summary.prompt.passed, summary.prompt.total)}) | ${summary.languageCriteria.passed}/${summary.languageCriteria.total} (${percentage(summary.languageCriteria.passed, summary.languageCriteria.total)}) | ${summary.program.passed}/${summary.program.total} (${percentage(summary.program.passed, summary.program.total)}) |`,
    );
  }

  lines.push(
    "",
    "## Shards",
    "",
    "| Language | Variant | Trials | Prompt | Language | Program |",
    "|---|---|---:|---:|---:|---:|",
  );
  for (const shard of expectedMatrix.include) {
    const key = shardKey(shard);
    const summary = summaries.get(key);
    if (!summary) {
      lines.push(
        `| ${shard.language} | ${shard.variant} | 0/${shard.evaluations} | n/a | n/a | n/a |`,
      );
      continue;
    }
    lines.push(
      `| ${summary.language} | ${summary.variant} | ${summary.trials}/${shard.evaluations} | ${summary.prompt.passed}/${summary.prompt.total} (${percentage(summary.prompt.passed, summary.prompt.total)}) | ${summary.languageCriteria.passed}/${summary.languageCriteria.total} (${percentage(summary.languageCriteria.passed, summary.languageCriteria.total)}) | ${summary.program.passed}/${summary.program.total} (${percentage(summary.program.passed, summary.program.total)}) |`,
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
