import {
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function filesUnder(root, basename) {
  const found = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(entryPath, basename));
    else if (entry.name === basename) found.push(entryPath);
  }
  return found;
}

function percentage(passed, total) {
  return total === 0 ? "n/a" : `${((passed / total) * 100).toFixed(1)}%`;
}

function aggregate(rows, field) {
  return rows.reduce(
    (total, row) => ({
      passed: total.passed + row[field].passed,
      total: total.total + row[field].total,
    }),
    { passed: 0, total: 0 },
  );
}

function validateCategory(value, label) {
  const errors = [];
  if (!value || typeof value !== "object") {
    return [`${label} must be an object`];
  }
  for (const field of ["passed", "total"]) {
    if (!Number.isInteger(value[field]) || value[field] < 0) {
      errors.push(`${label}.${field} must be a non-negative integer`);
    }
  }
  if (
    Number.isInteger(value.passed) &&
    Number.isInteger(value.total) &&
    value.passed > value.total
  ) {
    errors.push(`${label}.passed cannot exceed ${label}.total`);
  }
  if (!Array.isArray(value.failures)) {
    errors.push(`${label}.failures must be an array`);
  } else {
    for (const [index, failure] of value.failures.entries()) {
      if (
        !failure ||
        typeof failure !== "object" ||
        typeof failure.name !== "string" ||
        !failure.name.trim() ||
        typeof failure.evidence !== "string"
      ) {
        errors.push(`${label}.failures[${index}] is invalid`);
      }
    }
  }
  return errors;
}

function validateRow(row, index) {
  const errors = [];
  if (!row || typeof row !== "object") {
    return [`Result ${index + 1} must be an object`];
  }
  if (typeof row.scenario !== "string" || !row.scenario.trim()) {
    errors.push(`Result ${index + 1} has an invalid scenario`);
  }
  if (typeof row.language !== "string" || !row.language.trim()) {
    errors.push(`Result ${index + 1} has an invalid language`);
  }
  if (!["passed", "failed", "error"].includes(row.status)) {
    errors.push(`Result ${index + 1} has an invalid status`);
  }
  if (row.status === "error") {
    if (typeof row.error !== "string" || !row.error.trim()) {
      errors.push(`Result ${index + 1} error status requires an error message`);
    }
  } else if (row.error !== null) {
    errors.push(`Result ${index + 1} non-error status must have error: null`);
  }
  errors.push(...validateCategory(row.prompt, `Result ${index + 1}.prompt`));
  errors.push(
    ...validateCategory(
      row.languageChecks,
      `Result ${index + 1}.languageChecks`,
    ),
  );
  errors.push(...validateCategory(row.program, `Result ${index + 1}.program`));
  if (
    row.status === "passed" &&
    (row.prompt?.total === 0 ||
      row.prompt?.passed !== row.prompt?.total ||
      row.program?.total === 0 ||
      row.program?.passed !== row.program?.total)
  ) {
    errors.push(`Result ${index + 1} passed status conflicts with check totals`);
  }
  return errors;
}

export function summarize(rows, expected) {
  const integrity = rows.flatMap(validateRow);
  const validRows = rows.filter((row, index) => validateRow(row, index).length === 0);
  const names = new Set();
  for (const row of validRows) {
    if (names.has(row.scenario)) {
      integrity.push(`Duplicate scenario result: ${row.scenario}`);
    }
    names.add(row.scenario);
  }
  if (rows.length !== expected) {
    integrity.push(`Expected ${expected} scenario results, received ${rows.length}`);
  }

  const groups = new Map();
  for (const row of validRows) {
    const group = groups.get(row.language) ?? [];
    group.push(row);
    groups.set(row.language, group);
  }

  const lines = [
    "# Golden oracle summary",
    "",
    `Collected ${rows.length}/${expected} scenario result(s).`,
    "",
    "| Language | Scenarios | Prompt | Language | Program | Errors |",
    "|---|---:|---:|---:|---:|---:|",
  ];
  for (const [language, group] of [...groups].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const prompt = aggregate(group, "prompt");
    const languageChecks = aggregate(group, "languageChecks");
    const program = aggregate(group, "program");
    lines.push(
      `| ${language} | ${group.length} | ${prompt.passed}/${prompt.total} (${percentage(prompt.passed, prompt.total)}) | ${languageChecks.passed}/${languageChecks.total} (${percentage(languageChecks.passed, languageChecks.total)}) | ${program.passed}/${program.total} (${percentage(program.passed, program.total)}) | ${group.filter((row) => row.status === "error").length} |`,
    );
  }

  const failures = validRows.flatMap((row) => [
    ...(row.error
      ? [{ category: "infrastructure", evidence: row.error, name: "-", row }]
      : []),
    ...row.prompt.failures.map((failure) => ({
      category: "prompt",
      ...failure,
      row,
    })),
    ...row.languageChecks.failures.map((failure) => ({
      category: "language",
      ...failure,
      row,
    })),
    ...row.program.failures.map((failure) => ({
      category: "program",
      ...failure,
      row,
    })),
  ]);
  lines.push("", "## Check and infrastructure failures", "");
  if (failures.length === 0) {
    lines.push("None.");
  } else {
    lines.push("| Scenario | Category | Check | Evidence |");
    lines.push("|---|---|---|---|");
    for (const failure of failures) {
      const evidence = String(failure.evidence ?? "")
        .replaceAll("|", "\\|")
        .replaceAll(/\r?\n/g, " ");
      lines.push(
        `| ${failure.row.scenario} | ${failure.category} | ${failure.name} | ${evidence} |`,
      );
    }
  }

  lines.push("", "## Integrity", "");
  lines.push(
    integrity.length === 0
      ? "All expected oracle results were collected."
      : integrity.map((error) => `- ${error}`).join("\n"),
  );
  return { integrity, markdown: `${lines.join("\n")}\n` };
}

export function main(argv = process.argv.slice(2)) {
  const [root, expectedRaw, output = "golden-oracle-summary.md"] = argv;
  if (!root || !expectedRaw || !statSync(root).isDirectory()) {
    throw new Error(
      "Usage: node scripts/summarize-golden-oracles.mjs <artifact-root> <expected> [output]",
    );
  }
  const expected = Number(expectedRaw);
  if (!Number.isInteger(expected) || expected < 1) {
    throw new Error(`Invalid expected result count: ${expectedRaw}`);
  }

  const rows = [];
  for (const file of filesUnder(root, "oracle-results.jsonl")) {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      rows.push(JSON.parse(line));
    }
  }
  const summary = summarize(rows, expected);
  writeFileSync(output, summary.markdown);
  process.stdout.write(summary.markdown);
  return summary.integrity.length === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
