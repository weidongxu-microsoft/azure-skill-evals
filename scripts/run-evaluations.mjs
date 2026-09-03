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
  ["go", "experiments/go/experiment.yaml"],
];

const variants = [
  "baseline",
  "azure-skill-mcp",
  "azure-skill-mcp-microsoft-skill",
];

const supportedVariants = new Map([
  ["go", new Set(["baseline", "azure-skill-mcp"])],
]);

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

function hasFilterValue(value) {
  return Boolean(value?.trim());
}

export function parseFilterValues(value) {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
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

export function collectTagFilters(options) {
  const filters = [];
  for (const key of ["language", "service", "plane", "scope"]) {
    if (hasFilterValue(options[key])) {
      filters.push({ key, values: parseFilterValues(options[key]) });
    }
  }
  if (hasFilterValue(options.tags)) {
    filters.push(...parseTagFilters(options.tags));
  }
  return filters;
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
  if (!new Set(["all", "suite", "tags"]).has(options.mode)) {
    throw new Error(`Unknown selection mode "${options.mode}".`);
  }
  if (options.mode === "suite" && !hasFilterValue(options.suite)) {
    throw new Error("Suite selection requires --suite <name>.");
  }

  let selected = catalog.entries;
  if (hasFilterValue(options.suite)) {
    const suiteName = options.suite.trim();
    const suitePaths = catalog.suites.get(suiteName);
    if (!suitePaths) {
      throw new Error(
        `Unknown suite "${suiteName}". Available suites: ${[...catalog.suites.keys()].join(", ")}`,
      );
    }
    const experimentPaths = new Set(catalog.entries.map((entry) => entry.repoPath));
    const missingPaths = suitePaths.filter((suitePath) => !experimentPaths.has(suitePath));
    if (missingPaths.length > 0) {
      throw new Error(
        `Suite "${suiteName}" contains evaluations not declared by a language experiment: ${missingPaths.join(", ")}`,
      );
    }
    const suiteSet = new Set(suitePaths);
    selected = catalog.entries.filter((entry) => suiteSet.has(entry.repoPath));
  }

  const filters = collectTagFilters(options);
  if (options.mode === "tags" && filters.length === 0) {
    throw new Error("Tag selection requires at least one key=value filter.");
  }
  if (filters.length > 0) {
    selected = selected.filter((entry) =>
      entry.tagSets.some((tagSet) => matchesTags(tagSet, filters)),
    );
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

export function buildShardMatrix(groups, variant) {
  const include = groups.flatMap((group) => {
    const allowed = supportedVariants.get(group.language) ?? new Set(variants);
    const selectedVariants =
      variant === "all" ? variants.filter((item) => allowed.has(item)) : [variant];
    return selectedVariants
      .filter((item) => allowed.has(item))
      .map((selectedVariant) => ({
        language: group.language,
        variant: selectedVariant,
        evaluations: group.filters.length,
      }));
  });
  if (include.length === 0) {
    throw new Error("The selected evaluations do not support the requested variant.");
  }
  return { include };
}

export function parseArguments(argv) {
  const options = {
    mode: "all",
    variant: "all",
    outputDir: "reports",
    dryRun: false,
    selectOnly: false,
    listSuites: false,
    matrix: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") {
      options.dryRun = true;
    } else if (argument === "--select-only") {
      options.selectOnly = true;
    } else if (argument === "--list-suites") {
      options.listSuites = true;
    } else if (argument === "--matrix") {
      options.matrix = true;
    } else if (
      [
        "--mode",
        "--suite",
        "--tags",
        "--variant",
        "--language",
        "--service",
        "--plane",
        "--scope",
        "--output-dir",
      ].includes(argument)
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
          "--language": "language",
          "--service": "service",
          "--plane": "plane",
          "--scope": "scope",
          "--output-dir": "outputDir",
        }[argument]
      ] = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument "${argument}".`);
    }
  }

  if (!new Set(["all", ...variants]).has(options.variant)) {
    throw new Error(`Unknown variant "${options.variant}".`);
  }
  const knownLanguages = new Set(
    languageExperiments.map(([language]) => language),
  );
  const unknownLanguages = parseFilterValues(options.language).filter(
    (language) => !knownLanguages.has(language),
  );
  if (unknownLanguages.length > 0) {
    throw new Error(`Unknown language "${unknownLanguages[0]}".`);
  }
  if (!/^[A-Za-z0-9._/\\-]+$/.test(options.outputDir)) {
    throw new Error(`Unsafe output directory "${options.outputDir}".`);
  }
  if (normalizeRepoPath(options.outputDir).split("/").includes("..")) {
    throw new Error(`Output directory must stay within the repository.`);
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

export async function runExperimentGroups(groups, options, root, runner = runCommand) {
  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const failures = [];

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

    try {
      await runner(pnpm, args, root);
    } catch (error) {
      failures.push({ language: group.language, error });
      console.error(`Evaluation group "${group.language}" failed: ${error.message}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `${failures.length} evaluation group(s) failed: ${failures.map(({ language }) => language).join(", ")}.`,
    );
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const catalog = loadCatalog(root);

  if (options.listSuites) {
    console.log([...catalog.suites.keys()].join("\n"));
    return;
  }

  let groups = selectEvaluations(catalog, options);
  if (hasFilterValue(options.language)) {
    const requestedLanguages = new Set(parseFilterValues(options.language));
    groups = groups.filter((group) => requestedLanguages.has(group.language));
    if (groups.length === 0) {
      throw new Error(
        `The requested selection contains no ${[...requestedLanguages].join(", ")} evaluations.`,
      );
    }
  }
  if (options.variant !== "all") {
    groups = groups.filter(
      (group) =>
        !supportedVariants.has(group.language) ||
        supportedVariants.get(group.language).has(options.variant),
    );
    if (groups.length === 0) {
      throw new Error(
        "The selected evaluations do not support the requested variant.",
      );
    }
  }

  if (options.matrix) {
    console.log(JSON.stringify(buildShardMatrix(groups, options.variant)));
    return;
  }

  console.log(
    JSON.stringify(
      {
        mode: options.mode,
        suite: options.suite,
        language: options.language,
        service: options.service,
        plane: options.plane,
        scope: options.scope,
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

  await runExperimentGroups(groups, options, root);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  });
}
