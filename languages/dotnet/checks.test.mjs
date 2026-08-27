import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { evaluateDotnetCheck, loadDotnetWorkspace } from "./checks.mjs";

const completeWorkspace = {
  sourceFiles: ["Program.cs"],
  projectFiles: ["Example.csproj"],
  project: `
<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="Azure.Storage.Blobs" Version="12.0.0" />
  </ItemGroup>
</Project>
`,
  source: `
using Azure.Storage.Blobs;

static async Task Main()
{
    using BlobServiceClient client = new(new Uri("https://example"));
    await client.GetPropertiesAsync();
}
`,
};

test("shared .NET checks accept a current async SDK application", () => {
  for (const check of [
    "language/project-manifest",
    "language/current-azure-packages",
    "language/async-await",
    "language/client-lifecycle",
  ]) {
    assert.equal(evaluateDotnetCheck(check, completeWorkspace), true, check);
  }
});

test("legacy packages and undisposed clients fail", () => {
  const workspace = {
    ...completeWorkspace,
    project: completeWorkspace.project.replace(
      "Azure.Storage.Blobs",
      "WindowsAzure.Storage",
    ),
    source: completeWorkspace.source.replace("using BlobServiceClient", "var"),
  };

  assert.equal(
    evaluateDotnetCheck("language/current-azure-packages", workspace),
    false,
  );
  assert.equal(
    evaluateDotnetCheck("language/client-lifecycle", workspace),
    false,
  );
});

test("loader accepts a conventional nested src project", () => {
  const root = mkdtempSync(join(tmpdir(), "azure-skill-evals-dotnet-"));
  const projectRoot = join(root, "src", "CosmosCrud");
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(join(projectRoot, "Program.cs"), "Console.WriteLine();\n");
  writeFileSync(
    join(projectRoot, "CosmosCrud.csproj"),
    '<Project Sdk="Microsoft.NET.Sdk"></Project>\n',
  );
  const generatedRoot = join(projectRoot, "obj");
  mkdirSync(generatedRoot);
  writeFileSync(join(generatedRoot, "Generated.cs"), "class Generated {}\n");

  const workspace = loadDotnetWorkspace(root);

  assert.equal(workspace.sourceFiles.length, 1);
  assert.equal(workspace.projectFiles.length, 1);
});
