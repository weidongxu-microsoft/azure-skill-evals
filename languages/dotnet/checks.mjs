import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

function collectProjectFiles(root, predicate) {
  const files = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && predicate(entry.name))
    .map((entry) => join(root, entry.name));
  const sourceRoot = join(root, "src");
  if (!existsSync(sourceRoot)) {
    return files;
  }

  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "bin" && entry.name !== "obj") {
          visit(path);
        }
      } else if (predicate(entry.name)) {
        files.push(path);
      }
    }
  };
  visit(sourceRoot);
  return files;
}

export function loadDotnetWorkspace(root) {
  const sourceFiles = collectProjectFiles(root, (name) => name.endsWith(".cs"));
  const projectFiles = collectProjectFiles(root, (name) =>
    name.endsWith(".csproj"),
  );

  return {
    sourceFiles,
    projectFiles,
    source: sourceFiles.map((path) => readFileSync(path, "utf8")).join("\n"),
    project: projectFiles
      .map((path) => readFileSync(path, "utf8"))
      .join("\n"),
  };
}

const checks = {
  "language/project-manifest": ({ projectFiles, project }) =>
    projectFiles.length > 0 && /<Project\s+Sdk="Microsoft\.NET\.Sdk"/.test(project),
  "language/current-azure-packages": ({ project }) =>
    /<PackageReference\s+Include="(?:Azure\.|Microsoft\.Azure\.Cosmos")/.test(
      project,
    ) &&
    !/(?:WindowsAzure\.Storage|Microsoft\.WindowsAzure|Microsoft\.Azure\.DocumentDB)/.test(
      project,
    ),
  "language/async-await": ({ source }) => /\bawait\b/.test(source),
  "language/client-lifecycle": ({ source }) =>
    !/\bCosmosClient\b/.test(source) ||
    /\b(?:await\s+)?using\s+(?:var|\w+(?:<[^>]+>)?)\s+\w+\s*=/.test(source) ||
    /\.(?:Dispose|DisposeAsync)\s*\(/.test(source),
};

export function evaluateDotnetCheck(name, workspace) {
  const check = checks[name];
  if (!check) {
    throw new Error(`Unknown .NET check: ${name}`);
  }
  return check(workspace);
}

export function dotnetCheckNames() {
  return Object.keys(checks);
}
