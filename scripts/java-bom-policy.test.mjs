import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const scenariosRoot = join(repositoryRoot, "scenarios");
const bomArtifact = "com.azure:azure-sdk-bom";
const bomProperty = "azure-sdk-bom.version";

// Relevant entries from com.azure:azure-sdk-bom:1.3.8.
const bomManagedVersions = new Map([
  ["com.azure:azure-ai-agents", "2.2.0"],
  ["com.azure:azure-ai-projects", "2.2.0"],
  ["com.azure:azure-ai-translation-document", "1.0.9"],
  ["com.azure:azure-ai-translation-text", "2.0.1"],
  ["com.azure:azure-cosmos", "4.81.0"],
  ["com.azure:azure-data-appconfiguration", "1.10.0"],
  ["com.azure:azure-identity", "1.18.4"],
  ["com.azure:azure-messaging-eventgrid", "4.31.7"],
  ["com.azure:azure-messaging-eventhubs", "5.21.5"],
  [
    "com.azure:azure-messaging-eventhubs-checkpointstore-blob",
    "1.21.7",
  ],
  ["com.azure:azure-messaging-servicebus", "7.17.19"],
  ["com.azure:azure-security-keyvault-keys", "4.11.1"],
  ["com.azure:azure-security-keyvault-secrets", "4.11.1"],
  ["com.azure:azure-storage-blob", "12.35.0"],
  ["com.azure.resourcemanager:azure-resourcemanager", "2.63.0"],
  [
    "com.azure.resourcemanager:azure-resourcemanager-storage",
    "2.57.1",
  ],
]);

const unmanagedDirectAllowlist = [
  {
    scenario: "ai-agents-java-basic-agent-lifecycle",
    artifact: "com.azure:azure-ai-agents-persistent",
    version: "1.0.0-beta.2",
    reason: "The artifact is absent from azure-sdk-bom 1.3.8.",
  },
  {
    scenario: "ai-agents-java-file-search",
    artifact: "com.azure:azure-ai-agents-persistent",
    version: "1.0.0-beta.2",
    reason: "The artifact is absent from azure-sdk-bom 1.3.8.",
  },
  {
    scenario: "ai-agents-java-function-tool",
    artifact: "com.azure:azure-ai-agents-persistent",
    version: "1.0.0-beta.2",
    reason: "The artifact is absent from azure-sdk-bom 1.3.8.",
  },
];

const managedOverrideAllowlist = [
  {
    scenario: "ai-projects-java-dataset-lifecycle",
    artifact: "com.azure:azure-ai-projects",
    version: "2.4.0",
    reason: "The task stimulus pins azure-ai-projects 2.4.0.",
  },
  {
    scenario: "ai-projects-java-dataset-lifecycle",
    artifact: "com.azure:azure-storage-blob",
    version: "12.35.1",
    reason: "The task stimulus pins azure-storage-blob 12.35.1.",
  },
  {
    scenario: "ai-projects-java-evaluation-run",
    artifact: "com.azure:azure-ai-projects",
    version: "2.4.0",
    reason: "The task stimulus pins azure-ai-projects 2.4.0.",
  },
  {
    scenario: "document-translation-java-batch-container",
    artifact: "com.azure:azure-ai-translation-document",
    version: "2.0.1",
    reason: "The task stimulus pins azure-ai-translation-document 2.0.1.",
  },
  {
    scenario: "document-translation-java-single-document",
    artifact: "com.azure:azure-ai-translation-document",
    version: "2.0.1",
    reason: "The task stimulus pins azure-ai-translation-document 2.0.1.",
  },
  {
    scenario: "text-translation-java-multilingual-translation",
    artifact: "com.azure:azure-ai-translation-text",
    version: "2.0.2",
    reason:
      "The task stimulus and criterion pin azure-ai-translation-text 2.0.2.",
  },
  {
    scenario: "text-translation-java-transliteration",
    artifact: "com.azure:azure-ai-translation-text",
    version: "2.0.2",
    reason:
      "The task stimulus and criterion pin azure-ai-translation-text 2.0.2.",
  },
];

function parseXml(source, filePath) {
  const document = { name: "#document", children: [] };
  const stack = [document];
  const tokens =
    /<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<![^>]*>|<\/?([A-Za-z_][\w.:-]*)(?:\s[^<>]*?)?\/?>/g;

  for (const match of source.matchAll(tokens)) {
    const token = match[0];
    if (token.startsWith("<?") || token.startsWith("<!")) {
      continue;
    }

    const name = match[1].split(":").at(-1);
    if (token.startsWith("</")) {
      const node = stack.pop();
      assert.equal(node.name, name, `${filePath}: malformed XML`);
      node.contentEnd = match.index;
      continue;
    }

    const node = {
      name,
      children: [],
      contentStart: match.index + token.length,
      contentEnd: undefined,
    };
    stack.at(-1).children.push(node);
    if (token.endsWith("/>")) {
      node.contentEnd = node.contentStart;
    } else {
      stack.push(node);
    }
  }

  assert.equal(stack.length, 1, `${filePath}: unclosed XML element`);
  return document;
}

function children(node, name) {
  return node.children.filter((child) => child.name === name);
}

function onlyChild(node, name, context) {
  const matches = children(node, name);
  assert.equal(matches.length, 1, `${context}: expected one <${name}>`);
  return matches[0];
}

function optionalText(source, node, name) {
  const matches = children(node, name);
  assert.ok(matches.length <= 1, `expected at most one <${name}>`);
  return matches.length === 0
    ? undefined
    : source.slice(matches[0].contentStart, matches[0].contentEnd).trim();
}

function dependencyDetails(source, dependency) {
  const groupId = optionalText(source, dependency, "groupId");
  const artifactId = optionalText(source, dependency, "artifactId");
  assert.ok(groupId && artifactId, "dependency must have groupId and artifactId");
  return {
    artifact: `${groupId}:${artifactId}`,
    groupId,
    version: optionalText(source, dependency, "version"),
    type: optionalText(source, dependency, "type"),
    scope: optionalText(source, dependency, "scope"),
  };
}

function allowlistKey(entry) {
  return `${entry.scenario}|${entry.artifact}|${entry.version}`;
}

function scenarioArtifactKey(entry) {
  return `${entry.scenario}|${entry.artifact}`;
}

function isAzureGroup(groupId) {
  return groupId === "com.azure" || groupId.startsWith("com.azure.");
}

test("Java goldens follow the pinned Azure SDK BOM policy", () => {
  const lock = JSON.parse(
    readFileSync(join(repositoryRoot, "dependencies.lock.json"), "utf8"),
  );
  const bomVersion = lock.packages[bomArtifact];
  assert.equal(bomVersion, "1.3.8");

  const javaScenarios = readdirSync(scenariosRoot, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name.includes("-java-") &&
        existsSync(join(scenariosRoot, entry.name, "golden", "pom.xml")),
    )
    .map((entry) => entry.name)
    .sort();
  assert.equal(javaScenarios.length, 30);

  const unmanagedByKey = new Map(
    unmanagedDirectAllowlist.map((entry) => [allowlistKey(entry), entry]),
  );
  const overridesByKey = new Map(
    managedOverrideAllowlist.map((entry) => [allowlistKey(entry), entry]),
  );
  assert.equal(unmanagedDirectAllowlist.length, 3);
  assert.equal(managedOverrideAllowlist.length, 7);
  assert.equal(unmanagedByKey.size, unmanagedDirectAllowlist.length);
  assert.equal(overridesByKey.size, managedOverrideAllowlist.length);
  assert.equal(
    new Set(unmanagedDirectAllowlist.map(scenarioArtifactKey)).size,
    unmanagedDirectAllowlist.length,
  );
  assert.equal(
    new Set(managedOverrideAllowlist.map(scenarioArtifactKey)).size,
    managedOverrideAllowlist.length,
  );
  for (const entry of [
    ...unmanagedDirectAllowlist,
    ...managedOverrideAllowlist,
  ]) {
    assert.ok(entry.reason.length > 0, `${allowlistKey(entry)} needs a reason`);
  }

  const seenUnmanaged = new Set();
  const seenOverrides = new Set();
  const seenManagedArtifacts = new Set();
  let unmanagedDirectCount = 0;
  let managedOverrideCount = 0;

  for (const scenario of javaScenarios) {
    const pomPath = join(scenariosRoot, scenario, "golden", "pom.xml");
    const source = readFileSync(pomPath, "utf8");
    const document = parseXml(source, pomPath);
    const project = onlyChild(document, "project", scenario);
    const properties = onlyChild(project, "properties", scenario);
    const bomProperties = children(properties, bomProperty);
    assert.equal(
      bomProperties.length,
      1,
      `${scenario}: expected one <${bomProperty}>`,
    );
    assert.equal(
      source
        .slice(bomProperties[0].contentStart, bomProperties[0].contentEnd)
        .trim(),
      bomVersion,
      `${scenario}: BOM property must match dependencies.lock.json`,
    );

    const dependencyManagement = onlyChild(
      project,
      "dependencyManagement",
      scenario,
    );
    const managedDependencies = children(
      onlyChild(dependencyManagement, "dependencies", scenario),
      "dependency",
    ).map((dependency) => dependencyDetails(source, dependency));
    const bomImports = managedDependencies.filter(
      ({ artifact }) => artifact === bomArtifact,
    );
    assert.equal(bomImports.length, 1, `${scenario}: expected one BOM import`);
    assert.deepEqual(
      bomImports[0],
      {
        artifact: bomArtifact,
        groupId: "com.azure",
        version: `\${${bomProperty}}`,
        type: "pom",
        scope: "import",
      },
      `${scenario}: invalid BOM import`,
    );

    for (const dependency of managedDependencies) {
      if (dependency.artifact === bomArtifact) {
        continue;
      }
      if (!isAzureGroup(dependency.groupId)) {
        continue;
      }

      assert.ok(
        bomManagedVersions.has(dependency.artifact),
        `${scenario}: ${dependency.artifact} is not managed by BOM 1.3.8`,
      );
      assert.ok(
        dependency.version,
        `${scenario}: ${dependency.artifact} override needs a version`,
      );
      assert.notEqual(
        dependency.version,
        bomManagedVersions.get(dependency.artifact),
        `${scenario}: ${dependency.artifact} redundantly repeats the BOM version`,
      );
      const key = allowlistKey({
        scenario,
        artifact: dependency.artifact,
        version: dependency.version,
      });
      assert.ok(
        overridesByKey.has(key),
        `${scenario}: unapproved managed override ${dependency.artifact}:${dependency.version}`,
      );
      managedOverrideCount += 1;
      seenOverrides.add(key);
    }

    const directDependencies = children(
      onlyChild(project, "dependencies", scenario),
      "dependency",
    ).map((dependency) => dependencyDetails(source, dependency));
    for (const dependency of directDependencies) {
      if (!isAzureGroup(dependency.groupId)) {
        continue;
      }

      if (bomManagedVersions.has(dependency.artifact)) {
        seenManagedArtifacts.add(dependency.artifact);
        assert.equal(
          dependency.version,
          undefined,
          `${scenario}: BOM-managed direct dependency ${dependency.artifact} must omit <version>`,
        );
        continue;
      }

      assert.ok(
        dependency.version,
        `${scenario}: unmanaged Azure dependency ${dependency.artifact} needs an explicit version`,
      );
      const key = allowlistKey({
        scenario,
        artifact: dependency.artifact,
        version: dependency.version,
      });
      assert.ok(
        unmanagedByKey.has(key),
        `${scenario}: unapproved direct Azure version ${dependency.artifact}:${dependency.version}`,
      );
      unmanagedDirectCount += 1;
      seenUnmanaged.add(key);
    }
  }

  assert.equal(unmanagedDirectCount, 3);
  assert.equal(managedOverrideCount, 7);
  assert.deepEqual(
    [...seenManagedArtifacts].sort(),
    [...bomManagedVersions.keys()].sort(),
    "BOM-managed artifact snapshot contains a stale entry",
  );
  assert.deepEqual(
    [...seenUnmanaged].sort(),
    [...unmanagedByKey.keys()].sort(),
    "unmanaged direct dependency allowlist contains a stale entry",
  );
  assert.deepEqual(
    [...seenOverrides].sort(),
    [...overridesByKey.keys()].sort(),
    "managed override allowlist contains a stale entry",
  );
});
