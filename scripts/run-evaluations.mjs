import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const languageExperiments = [
  ["python", "experiments/python/experiment.yaml"],
  ["dotnet", "experiments/dotnet/experiment.yaml"],
  ["java", "experiments/java/experiment.yaml"],
  ["typescript", "experiments/typescript/experiment.yaml"],
];

function unquote(value) {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function normalizeRepoPath(value) {
  return path.posix.normalize(value.replaceAll("\\", "/"));
}

export function parseTagFilters(value) {
  if (!value?.trim()) {
    throw new Error("Tag selection requires at least one key=value filter.");
  }

  return value
    .split(";")
    .map((clause) => clause.trim())
    .filter(Boolean)
    .map((clause) => {
      const separator = clause.indexOf("=");
      if (separator <= 0 || separator === clause.length - 1) {
        throw new Error(
          `Invalid tag filter "${clause}". Use key=value1,value2 and separate filters with semicolons.`,
        );
      }

      const key = clause.slice(0, separator).trim();
      const values = clause
        .slice(separator + 1)
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      if (!key || values.length === 0) {
        throw new Error(`Invalid tag filter "${clause}".`);
      }
      return { key, values };
    });
}

export function parseSuites(contents) {
  const suites = new Map();
  let inSuites = false;
  let currentSuite;
  let readingEvals = false;

  for (const line of contents.split(/\r?\n/)) {
    if (/^suites:\s*$/.test(line)) {
      inSuites = true;
      continue;
    }
    if (inSuites && /^\S/.test(line)) {
      break;
    }
    if (!inSuites) {
      continue;
    }

    const suiteMatch = line.match(/^  ([A-Za-z0-9][A-Za-z0-9-]*):\s*$/);
    if (suiteMatch) {
      currentSuite = suiteMatch[1];
      suites.set(currentSuite, []);
      readingEvals = false;
      continue;
    }

    if (currentSuite && /^    evals:\s*$/.test(line)) {
      readingEvals = true;
      continue;
    }

    const evalMatch = readingEvals && line.match(/^      -\s+(.+?)\s*$/);
    if (evalMatch) {
      suites.get(currentSuite).push(normalizeRepoPath(unquote(evalMatch[1])));
      continue;
    }

    if (readingEvals && /^    \S/.test(line)) {
      readingEvals = false;
    }
  }

  return suites;
}

export function parseExperimentEvals(contents) {
  const evals = [];
  let readingEvals = false;

  for (const line of contents.split(/\r?\n/)) {
    if (/^evals:\s*$/.test(line)) {
      readingEvals = true;
      continue;
    }

    const evalMatch = readingEvals && line.match(/^  -\s+(.+?)\s*$/);
    if (evalMatch) {
      evals.push(unquote(evalMatch[1]));
      continue;
    }

    if (readingEvals && /^\S/.test(line)) {
      break;
    }
  }

  return evals;
}

export function parseStimulusTags(contents) {
  const tagSets = [];
  let currentTags;

  for (const line of contents.split(/\r?\n/)) {
    if (/^    tags:\s*$/.test(line)) {
      currentTags = {};
      tagSets.push(currentTags);
      continue;
    }

    const tagMatch = currentTags && line.match(/^      ([A-Za-z0-9_-]+):\s*(.+?)\s*$/);
    if (tagMatch) {
      currentTags[tagMatch[1]] = unquote(tagMatch[2]);
      continue;
    }

    if (currentTags && /^    \S/.test(line)) {
      currentTags = undefined;
    }
  }

  return tagSets;
}

function matchesTags(tagSet, filters) {
  return filters.every(
    ({ key, values }) => key in tagSet && values.includes(String(tagSet[key])),
  );
}

export function loadCatalog(root) {
  const suites = parseSuites(readFileSync(path.join(root, ".vally.yaml"), "utf8"));
  const entries = [];

  for (const [language, experiment] of languageExperiments) {
    const experimentPath = path.join(root, experiment);
    const declaredEvals = parseExperimentEvals(readFileSync(experimentPath, "utf8"));

    for (const filter of declaredEvals) {
      const absoluteEval = path.resolve(path.dirname(experimentPath), filter);
      entries.push({
        language,
        experiment,
        filter,
        repoPath: normalizeRepoPath(path.relative(root, absoluteEval)),
        tagSets: parseStimulusTags(readFileSync(absoluteEval, "utf8")),
      });
    }
  }

  return { entries, suites };
}

export function selectEvaluations(catalog, options) {
  let selected;

  switch (options.mode) {
    case "all":
      selected = catalog.entries;
      break;
    case "suite": {
      const suitePaths = catalog.suites.get(options.suite);
      if (!suitePaths) {
        throw new Error(
          `Unknown suite "${options.suite}". Available suites: ${[...catalog.suites.keys()].join(", ")}`,
        );
      }
      const experimentPaths = new Set(catalog.entries.map((entry) => entry.repoPath));
      const missingPaths = suitePaths.filter((suitePath) => !experimentPaths.has(suitePath));
      if (missingPaths.length > 0) {
        throw new Error(
          `Suite "${options.suite}" contains evaluations not declared by a language experiment: ${missingPaths.join(", ")}`,
        );
      }
      const suiteSet = new Set(suitePaths);
      selected = catalog.entries.filter((entry) => suiteSet.has(entry.repoPath));
      break;
    }
    case "tags": {
      const filters = parseTagFilters(options.tags);
      selected = catalog.entries.filter((entry) =>
        entry.tagSets.some((tagSet) => matchesTags(tagSet, filters)),
      );
      break;
    }
    default:
      throw new Error(`Unknown selection mode "${options.mode}".`);
  }

  if (selected.length === 0) {
    throw new Error("The requested selection matched no experiment evaluations.");
  }

  const groups = [];
  for (const [language, experiment] of languageExperiments) {
    const filters = selected
      .filter((entry) => entry.language === language)
      .map((entry) => entry.filter);
    if (filters.length > 0) {
      groups.push({ language, experiment, filters });
    }
  }
  return groups;
}

function parseArguments(argv) {
  const options = {
    mode: "all",
    variant: "all",
    outputDir: "reports",
    dryRun: false,
    selectOnly: false,
    listSuites: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") {
      options.dryRun = true;
    } else if (argument === "--select-only") {
      options.selectOnly = true;
    } else if (argument === "--list-suites") {
      options.listSuites = true;
    } else if (
      ["--mode", "--suite", "--tags", "--variant", "--output-dir"].includes(argument)
    ) {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`${argument} requires a value.`);
      }
      options[
        {
          "--mode": "mode",
          "--suite": "suite",
          "--tags": "tags",
          "--variant": "variant",
          "--output-dir": "outputDir",
        }[argument]
      ] = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument "${argument}".`);
    }
  }

  const variants = new Set([
    "all",
    "baseline",
    "azure-skill-mcp",
    "+ Microsoft Skills",
  ]);
  if (!variants.has(options.variant)) {
    throw new Error(`Unknown variant "${options.variant}".`);
  }
  if (!/^[A-Za-z0-9._/\\-]+$/.test(options.outputDir)) {
    throw new Error(`Unsafe output directory "${options.outputDir}".`);
  }
  if (normalizeRepoPath(options.outputDir).split("/").includes("..")) {
    throw new Error(`Output directory must stay within the repository.`);
  }
  if (options.mode === "suite" && !options.suite) {
    throw new Error("Suite selection requires --suite <name>.");
  }

  return options;
}

function runCommand(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child =
      process.platform === "win32"
        ? spawn(
            process.env.ComSpec,
            [
              "/d",
              "/s",
              "/c",
              [command, ...args].join(" "),
            ],
            { cwd, stdio: "inherit" },
          )
        : spawn(command, args, { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} terminated by signal ${signal}.`));
      } else if (code !== 0) {
        reject(new Error(`${command} exited with code ${code}.`));
      } else {
        resolve();
      }
    });
  });
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const catalog = loadCatalog(root);

  if (options.listSuites) {
    console.log([...catalog.suites.keys()].join("\n"));
    return;
  }

  const groups = selectEvaluations(catalog, options);
  console.log(
    JSON.stringify(
      {
        mode: options.mode,
        suite: options.suite,
        tags: options.tags,
        variant: options.variant,
        evaluations: groups.reduce((total, group) => total + group.filters.length, 0),
        groups,
      },
      null,
      2,
    ),
  );

  if (options.selectOnly) {
    return;
  }

  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  for (const group of groups) {
    const args = [
      "exec",
      "vally",
      "experiment",
      "run",
      group.experiment,
      "--output-dir",
      options.outputDir,
    ];
    if (options.variant !== "all") {
      args.push("--variant", options.variant);
    }
    for (const filter of group.filters) {
      args.push("--eval-filter", filter);
    }
    if (options.dryRun) {
      args.push("--dry-run");
    }

    await runCommand(pnpm, args, root);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  });
}
