import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TEMP_EVAL = ".vally-oracle.eval.yaml";
const TEMP_PATCH = ".vally-oracle-golden.patch";
const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url));

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
}

export function listGoldenFiles(repositoryRoot, goldenDirectory) {
  const relativeGolden = path
    .relative(repositoryRoot, goldenDirectory)
    .replaceAll("\\", "/");
  const result = run(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      relativeGolden,
    ],
    { cwd: repositoryRoot },
  );
  if (result.status !== 0) {
    throw new Error(`Could not list golden files: ${result.stderr}`);
  }
  const prefix = `${relativeGolden}/`;
  return result.stdout
    .split(/\r?\n/)
    .filter((file) => file.startsWith(prefix))
    .map((file) => file.slice(prefix.length));
}

export function createGoldenPatch(goldenDirectory, files) {
  if (files.length === 0) {
    throw new Error(`Golden directory has no source files: ${goldenDirectory}`);
  }
  const repository = mkdtempSync(path.join(tmpdir(), "vally-golden-patch-"));
  try {
    const init = run("git", ["init", "--quiet"], { cwd: repository });
    if (init.status !== 0) {
      throw new Error(`git init failed: ${init.stderr}`);
    }

    for (const file of files) {
      const destination = path.join(repository, file);
      mkdirSync(path.dirname(destination), { recursive: true });
      cpSync(path.join(goldenDirectory, file), destination, {
        recursive: false,
      });
    }
    const add = run("git", ["add", "--all"], { cwd: repository });
    if (add.status !== 0) {
      throw new Error(`git add failed: ${add.stderr}`);
    }

    const diff = run(
      "git",
      ["diff", "--cached", "--binary", "--no-ext-diff", "--no-color"],
      { cwd: repository },
    );
    if (diff.status !== 0) {
      throw new Error(`git diff failed: ${diff.stderr}`);
    }
    if (!diff.stdout.trim()) {
      throw new Error(`Golden directory is empty: ${goldenDirectory}`);
    }
    return diff.stdout;
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
}

export function addGoldenPatch(evalSource, patchPath = TEMP_PATCH) {
  const stimulus = /^(\s{2}- name: [^\r\n]+\r?\n)/m;
  if (!stimulus.test(evalSource)) {
    throw new Error("Eval does not contain a stimulus name");
  }
  const withPatch = evalSource.replace(
    stimulus,
    `$1    golden_patch:\n      path: ${patchPath}\n`,
  );
  const repoEvidence = /^(\s+- repo\r?\n)/m;
  if (!repoEvidence.test(withPatch)) {
    throw new Error("Panel evidence does not include repo");
  }
  return withPatch.replace(repoEvidence, "$1            - golden_patch\n");
}

function walkDetails(result) {
  const pending = [result];
  const details = [];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== "object") continue;
    details.push(current);
    if (Array.isArray(current.details)) pending.push(...current.details);
  }
  return details;
}

export function summarizeOracleOutcome(outcome) {
  if (outcome?.status !== "success" || !outcome.gradeResult) {
    return {
      error: outcome?.error ?? "Oracle did not return a grade result",
      prompt: [],
      language: [],
      program: [],
    };
  }

  const details = walkDetails(outcome.gradeResult);
  const criteria = details.filter(
    (detail) =>
      detail.name?.startsWith("panel/criterion/") &&
      typeof detail.metadata?.criterion === "string",
  );

  return {
    error: null,
    prompt: criteria.filter((detail) =>
      detail.metadata.criterion.startsWith("prompt/"),
    ),
    language: criteria.filter((detail) =>
      detail.metadata.criterion.startsWith("language/"),
    ),
    program: details.filter(
      (detail) => detail.graderType === "run-command",
    ),
  };
}

function parseJsonLines(output) {
  if (typeof output !== "string") {
    throw new Error("Oracle command did not produce standard output");
  }
  return output
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function parseArguments(argv) {
  const options = {
    all: false,
    scenarios: [],
    service: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--all") {
      options.all = true;
    } else if (argument === "--scenario") {
      options.scenarios.push(argv[++index]);
    } else if (argument === "--service") {
      options.service = argv[++index];
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (
    Number(options.all) +
      Number(options.service !== null) +
      Number(options.scenarios.length > 0) !==
    1
  ) {
    throw new Error(
      "Select exactly one of --all, --service <name>, or --scenario <name>",
    );
  }
  if (
    options.scenarios.some(
      (scenario) => !scenario || scenario.startsWith("-"),
    ) ||
    (options.service !== null &&
      (!options.service || options.service.startsWith("-")))
  ) {
    throw new Error("Selector values must be non-empty");
  }
  return options;
}

function scenarioDirectories(root, options) {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      path: path.join(root, entry.name),
    }))
    .filter(({ name, path: scenarioPath }) => {
      if (options.all) return true;
      if (options.scenarios.length > 0) {
        return options.scenarios.includes(name);
      }
      const source = readFileSync(
        path.join(scenarioPath, "eval.yaml"),
        "utf8",
      );
      return new RegExp(
        `^\\s+service:\\s*${options.service.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`,
        "m",
      ).test(source);
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function runOracle(evalPath) {
  const command = process.execPath;
  const args = [
    path.join(
      REPOSITORY_ROOT,
      "node_modules",
      "@microsoft",
      "vally-cli",
      "dist",
      "index.js",
    ),
    "oracle",
    "--eval-spec",
    evalPath,
    "--output",
    "jsonl",
  ];
  const result = run(command, args);
  if (result.error) {
    throw new Error(`Could not start Vally oracle: ${result.error.message}`);
  }
  let outcomes;
  try {
    outcomes = parseJsonLines(result.stdout);
  } catch (error) {
    throw new Error(
      `Could not parse oracle output: ${error.message}\n${result.stdout}\n${result.stderr}`,
    );
  }
  if (outcomes.length !== 1) {
    throw new Error(
      `Expected one oracle result, received ${outcomes.length}\n${result.stderr}`,
    );
  }
  return { outcome: outcomes[0], stderr: result.stderr };
}

function resultCount(results) {
  return `${results.filter((result) => result.passed).length}/${results.length}`;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const root = path.join(REPOSITORY_ROOT, "scenarios");
  const scenarios = scenarioDirectories(root, options);
  if (scenarios.length === 0) {
    throw new Error("No scenarios matched the requested selector");
  }

  let failed = false;
  for (const scenario of scenarios) {
    const evalPath = path.join(scenario.path, "eval.yaml");
    const goldenDirectory = path.join(scenario.path, "golden");
    if (!statSync(goldenDirectory).isDirectory()) {
      throw new Error(`Golden directory is missing: ${goldenDirectory}`);
    }

    const temporaryEval = path.join(scenario.path, TEMP_EVAL);
    const temporaryPatch = path.join(scenario.path, TEMP_PATCH);
    try {
      writeFileSync(
        temporaryPatch,
        createGoldenPatch(
          goldenDirectory,
          listGoldenFiles(REPOSITORY_ROOT, goldenDirectory),
        ),
      );
      writeFileSync(
        temporaryEval,
        addGoldenPatch(readFileSync(evalPath, "utf8")),
      );

      const positive = summarizeOracleOutcome(
        runOracle(temporaryEval).outcome,
      );
      const promptFailures = positive.prompt.filter((result) => !result.passed);
      const programFailures = positive.program.filter(
        (result) => !result.passed,
      );
      const positiveFailed =
        positive.error ||
        positive.prompt.length === 0 ||
        promptFailures.length > 0 ||
        programFailures.length > 0;
      failed ||= Boolean(positiveFailed);

      console.log(
        [
          positiveFailed ? "FAIL" : "PASS",
          scenario.name,
          `prompt=${resultCount(positive.prompt)}`,
          `language=${resultCount(positive.language)}`,
          `program=${resultCount(positive.program)}`,
        ].join(" "),
      );
      if (positive.error) console.error(`  ${positive.error}`);
      for (const failure of [...promptFailures, ...programFailures]) {
        console.error(
          `  ${failure.metadata?.criterion ?? failure.name}: ${failure.evidence}`,
        );
      }
    } finally {
      rmSync(temporaryEval, { force: true });
      rmSync(temporaryPatch, { force: true });
    }
  }

  return failed ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
