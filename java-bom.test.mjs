import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scenarioRoot = fileURLToPath(new URL("./scenarios/", import.meta.url));
const allowedOverrides = new Map([
  [
    "ai-agents-java-basic-agent-lifecycle",
    ["azure-ai-agents-persistent:1.0.0-beta.2"],
  ],
  [
    "ai-agents-java-file-search",
    ["azure-ai-agents-persistent:1.0.0-beta.2"],
  ],
  [
    "ai-agents-java-function-tool",
    ["azure-ai-agents-persistent:1.0.0-beta.2"],
  ],
  [
    "ai-projects-java-dataset-lifecycle",
    ["azure-ai-projects:2.4.0", "azure-storage-blob:12.35.1"],
  ],
  ["ai-projects-java-evaluation-run", ["azure-ai-projects:2.4.0"]],
  [
    "document-translation-java-batch-container",
    ["azure-ai-translation-document:2.0.1"],
  ],
  [
    "document-translation-java-single-document",
    ["azure-ai-translation-document:2.0.1"],
  ],
  [
    "text-translation-java-multilingual-translation",
    ["azure-ai-translation-text:2.0.2"],
  ],
  [
    "text-translation-java-transliteration",
    ["azure-ai-translation-text:2.0.2"],
  ],
]);

test("Java goldens use BOM-first Azure dependency management", () => {
  const scenarios = readdirSync(scenarioRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.includes("-java-"))
    .map((entry) => entry.name)
    .sort();

  assert.equal(scenarios.length, 30);
  for (const scenario of scenarios) {
    const pomPath = join(scenarioRoot, scenario, "golden", "pom.xml");
    const source = readFileSync(pomPath, "utf8").replaceAll("\r\n", "\n");
    assert.match(
      source,
      /<dependencyManagement>[\s\S]*?<artifactId>azure-sdk-bom<\/artifactId>[\s\S]*?<version>1\.3\.8<\/version>[\s\S]*?<\/dependencyManagement>/,
      pomPath,
    );

    const directDependencies = source.split("</dependencyManagement>")[1];
    const overrides = [
      ...directDependencies.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g),
    ]
      .map((match) => match[1])
      .filter((block) =>
        /<groupId>com\.azure(?:\.resourcemanager)?<\/groupId>/.test(block),
      )
      .map((block) => {
        const artifact = block.match(/<artifactId>([^<]+)<\/artifactId>/)?.[1];
        const version = block.match(/<version>([^<]+)<\/version>/)?.[1];
        return version ? `${artifact}:${version}` : null;
      })
      .filter(Boolean)
      .sort();

    assert.deepEqual(overrides, (allowedOverrides.get(scenario) ?? []).toSorted());
  }
});
