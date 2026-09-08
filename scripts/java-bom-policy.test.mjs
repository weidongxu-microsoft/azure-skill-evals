import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { SaxesParser } from "saxes";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const scenariosRoot = join(repositoryRoot, "scenarios");
const bomArtifact = "com.azure:azure-sdk-bom";
const bomProperty = "azure-sdk-bom.version";
const mavenPomNamespace = "http://maven.apache.org/POM/4.0.0";
const dependencyScalarElements = [
  "groupId",
  "artifactId",
  "version",
  "type",
  "scope",
  "classifier",
  "optional",
];

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

const expectedDirectAzureDependencies = new Map([
  [
    "ai-agents-java-basic-agent-lifecycle",
    [
      "com.azure:azure-ai-agents-persistent",
      "com.azure:azure-identity",
    ],
  ],
  [
    "ai-agents-java-file-search",
    [
      "com.azure:azure-ai-agents-persistent",
      "com.azure:azure-identity",
    ],
  ],
  [
    "ai-agents-java-function-tool",
    [
      "com.azure:azure-ai-agents-persistent",
      "com.azure:azure-identity",
    ],
  ],
  [
    "ai-projects-java-dataset-lifecycle",
    [
      "com.azure:azure-ai-projects",
      "com.azure:azure-identity",
      "com.azure:azure-storage-blob",
    ],
  ],
  [
    "ai-projects-java-evaluation-run",
    ["com.azure:azure-ai-projects", "com.azure:azure-identity"],
  ],
  [
    "ai-projects-java-project-resource-inventory",
    ["com.azure:azure-ai-projects", "com.azure:azure-identity"],
  ],
  [
    "app-configuration-java-config-values",
    ["com.azure:azure-data-appconfiguration"],
  ],
  [
    "app-configuration-java-feature-flags",
    ["com.azure:azure-data-appconfiguration", "com.azure:azure-identity"],
  ],
  ["cosmos-db-java-crud", ["com.azure:azure-cosmos"]],
  [
    "cosmos-db-java-todo-repository",
    ["com.azure:azure-cosmos", "com.azure:azure-identity"],
  ],
  [
    "document-translation-java-batch-container",
    ["com.azure:azure-ai-translation-document", "com.azure:azure-identity"],
  ],
  [
    "document-translation-java-single-document",
    ["com.azure:azure-ai-translation-document", "com.azure:azure-identity"],
  ],
  [
    "event-hubs-java-send-receive-events",
    [
      "com.azure:azure-messaging-eventhubs",
      "com.azure:azure-messaging-eventhubs-checkpointstore-blob",
    ],
  ],
  [
    "foundry-java-support-assistant",
    [
      "com.azure:azure-ai-agents",
      "com.azure:azure-identity",
      "com.azure:azure-storage-blob",
    ],
  ],
  ["identity-java-credential-chain", ["com.azure:azure-identity"]],
  [
    "identity-java-default-azure-credential",
    ["com.azure:azure-identity", "com.azure:azure-security-keyvault-secrets"],
  ],
  [
    "identity-java-managed-identity-auth",
    ["com.azure:azure-identity", "com.azure:azure-security-keyvault-secrets"],
  ],
  [
    "identity-java-service-principal-auth",
    ["com.azure:azure-identity", "com.azure:azure-security-keyvault-secrets"],
  ],
  [
    "key-vault-java-crud-secrets",
    ["com.azure:azure-identity", "com.azure:azure-security-keyvault-secrets"],
  ],
  [
    "key-vault-java-secret-config",
    ["com.azure:azure-identity", "com.azure:azure-security-keyvault-secrets"],
  ],
  [
    "resource-manager-java-resource-group-crud",
    ["com.azure.resourcemanager:azure-resourcemanager", "com.azure:azure-identity"],
  ],
  [
    "service-bus-java-order-processor",
    ["com.azure:azure-identity", "com.azure:azure-messaging-servicebus"],
  ],
  [
    "service-bus-java-send-receive-messages",
    ["com.azure:azure-messaging-servicebus"],
  ],
  [
    "storage-java-account-mgmt",
    [
      "com.azure.resourcemanager:azure-resourcemanager-storage",
      "com.azure:azure-identity",
    ],
  ],
  [
    "storage-java-blob-event-notifier",
    [
      "com.azure:azure-identity",
      "com.azure:azure-messaging-eventgrid",
      "com.azure:azure-storage-blob",
    ],
  ],
  [
    "storage-java-blob-storage-manager",
    ["com.azure:azure-identity", "com.azure:azure-storage-blob"],
  ],
  [
    "storage-java-crud-blobs",
    ["com.azure:azure-identity", "com.azure:azure-storage-blob"],
  ],
  [
    "storage-java-encrypted-uploader",
    [
      "com.azure:azure-identity",
      "com.azure:azure-security-keyvault-keys",
      "com.azure:azure-storage-blob",
    ],
  ],
  [
    "text-translation-java-multilingual-translation",
    ["com.azure:azure-ai-translation-text", "com.azure:azure-identity"],
  ],
  [
    "text-translation-java-transliteration",
    ["com.azure:azure-ai-translation-text", "com.azure:azure-identity"],
  ],
]);

function parseXml(source, filePath) {
  const document = { name: "#document", children: [] };
  const stack = [document];
  let doctype;
  let namespaceError;
  let parseError;
  const parser = new SaxesParser({ xmlns: true });
  parser.on("opentag", (tag) => {
    if (tag.uri !== mavenPomNamespace) {
      namespaceError ??= `<${tag.name}> uses namespace ${JSON.stringify(tag.uri)}`;
    }
    const node = {
      name: tag.local,
      namespace: tag.uri,
      children: [],
      text: "",
    };
    stack.at(-1).children.push(node);
    stack.push(node);
  });
  parser.on("closetag", () => {
    stack.pop();
  });
  parser.on("text", (text) => {
    stack.at(-1).text += text;
  });
  parser.on("cdata", (text) => {
    stack.at(-1).text += text;
  });
  parser.on("doctype", (value) => {
    doctype = value;
  });
  parser.on("error", (error) => {
    parseError ??= error;
  });

  try {
    parser.write(source).close();
  } catch (error) {
    parseError ??= error;
  }
  assert.equal(
    doctype,
    undefined,
    `${filePath}: DTDs and external entities are not allowed`,
  );
  assert.equal(
    parseError,
    undefined,
    `${filePath}: malformed XML: ${parseError?.message}`,
  );
  assert.equal(
    namespaceError,
    undefined,
    `${filePath}: every POM element must use the Maven POM namespace: ${namespaceError}`,
  );
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

function optionalText(node, name) {
  const matches = children(node, name);
  assert.ok(matches.length <= 1, `expected at most one <${name}>`);
  if (matches.length === 0) return undefined;
  assert.equal(
    matches[0].children.length,
    0,
    `<${name}> must contain text only`,
  );
  return matches[0].text.trim();
}

function validateCoordinate(value, element, artifact) {
  assert.doesNotMatch(
    value,
    /\$\{/,
    `${artifact}: property expressions are not allowed in <${element}>`,
  );
  assert.match(
    value,
    /^[A-Za-z0-9_.-]+$/,
    `${artifact}: invalid Maven <${element}> coordinate`,
  );
}

function dependencyDetails(dependency) {
  const scalarValues = Object.fromEntries(
    dependencyScalarElements.map((name) => [name, optionalText(dependency, name)]),
  );
  const { groupId, artifactId } = scalarValues;
  assert.ok(groupId && artifactId, "dependency must have groupId and artifactId");
  validateCoordinate(groupId, "groupId", `${groupId}:${artifactId}`);
  validateCoordinate(artifactId, "artifactId", `${groupId}:${artifactId}`);
  return {
    artifact: `${groupId}:${artifactId}`,
    elements: dependency.children.map((child) => child.name),
    groupId,
    version: scalarValues.version,
    type: scalarValues.type,
    scope: scalarValues.scope,
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

function loadPolicyInput() {
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
    .sort()
    .map((scenario) => {
      const pomPath = join(scenariosRoot, scenario, "golden", "pom.xml");
      return {
        pomPath,
        scenario,
        source: readFileSync(pomPath, "utf8").replaceAll("\r\n", "\n"),
      };
    });

  return { bomVersion, javaScenarios };
}

export function validateJavaBomPolicy({ bomVersion, javaScenarios }) {
  assert.equal(javaScenarios.length, 30);
  assert.deepEqual(
    [...expectedDirectAzureDependencies.keys()].sort(),
    javaScenarios.map(({ scenario }) => scenario),
    "direct Azure dependency inventory contains a stale scenario",
  );

  const unmanagedByKey = new Map(
    unmanagedDirectAllowlist.map((entry) => [allowlistKey(entry), entry]),
  );
  const overridesByKey = new Map(
    managedOverrideAllowlist.map((entry) => [allowlistKey(entry), entry]),
  );
  const overridesByScenarioArtifact = new Map(
    managedOverrideAllowlist.map((entry) => [
      scenarioArtifactKey(entry),
      entry,
    ]),
  );
  assert.equal(unmanagedDirectAllowlist.length, 3);
  assert.equal(managedOverrideAllowlist.length, 7);
  assert.equal(unmanagedByKey.size, unmanagedDirectAllowlist.length);
  assert.equal(overridesByKey.size, managedOverrideAllowlist.length);
  assert.equal(
    overridesByScenarioArtifact.size,
    managedOverrideAllowlist.length,
  );
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
  const seenOverrideDirects = new Set();
  const seenManagedArtifacts = new Set();
  let ordinaryBomManagedDirectCount = 0;
  let overriddenBomManagedDirectCount = 0;
  let unmanagedDirectCount = 0;
  let managedOverrideCount = 0;

  for (const { pomPath, scenario, source } of javaScenarios) {
    const document = parseXml(source, pomPath);
    const project = onlyChild(document, "project", scenario);
    assert.equal(
      children(project, "parent").length,
      0,
      `${scenario}: Maven parent POMs are not allowed`,
    );
    assert.equal(
      children(project, "profiles").length,
      0,
      `${scenario}: Maven profiles are not allowed in Java goldens`,
    );
    const properties = onlyChild(project, "properties", scenario);
    const bomProperties = children(properties, bomProperty);
    assert.equal(
      bomProperties.length,
      1,
      `${scenario}: expected one <${bomProperty}>`,
    );
    assert.equal(
      optionalText(properties, bomProperty),
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
    ).map(dependencyDetails);
    const bomImports = managedDependencies.filter(
      ({ artifact }) => artifact === bomArtifact,
    );
    assert.equal(bomImports.length, 1, `${scenario}: expected one BOM import`);
    assert.deepEqual(
      bomImports[0],
      {
        artifact: bomArtifact,
        elements: ["groupId", "artifactId", "version", "type", "scope"],
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

      assert.deepEqual(
        dependency.elements,
        ["groupId", "artifactId", "version"],
        `${scenario}: ${dependency.artifact} override must contain only groupId, artifactId, and version`,
      );
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
    ).map(dependencyDetails);
    const directArtifacts = new Set();
    for (const dependency of directDependencies) {
      assert.ok(
        !directArtifacts.has(dependency.artifact),
        `${scenario}: duplicate direct dependency ${dependency.artifact}`,
      );
      directArtifacts.add(dependency.artifact);
    }
    const directAzureArtifacts = directDependencies
      .filter(({ groupId }) => isAzureGroup(groupId))
      .map(({ artifact }) => artifact)
      .sort();
    assert.deepEqual(
      directAzureArtifacts,
      [...expectedDirectAzureDependencies.get(scenario)].sort(),
      `${scenario}: direct Azure dependency inventory changed`,
    );
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
        const key = scenarioArtifactKey({
          scenario,
          artifact: dependency.artifact,
        });
        if (overridesByScenarioArtifact.has(key)) {
          overriddenBomManagedDirectCount += 1;
          seenOverrideDirects.add(key);
        } else {
          ordinaryBomManagedDirectCount += 1;
        }
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

  assert.equal(
    ordinaryBomManagedDirectCount,
    50,
    "expected exactly 50 ordinary BOM-managed direct dependencies",
  );
  assert.equal(
    overriddenBomManagedDirectCount,
    7,
    "expected exactly 7 overridden BOM-managed direct dependencies",
  );
  assert.equal(
    unmanagedDirectCount,
    3,
    "expected exactly 3 unmanaged direct Azure dependencies",
  );
  assert.equal(
    managedOverrideCount,
    7,
    "expected exactly 7 managed override declarations",
  );
  assert.equal(
    ordinaryBomManagedDirectCount +
      overriddenBomManagedDirectCount +
      unmanagedDirectCount,
    60,
    "expected exactly 60 direct Azure dependencies",
  );
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
  assert.deepEqual(
    [...seenOverrideDirects].sort(),
    [...overridesByScenarioArtifact.keys()].sort(),
    "every managed override must correspond to exactly one direct dependency",
  );
}

function withScenarioSource(input, scenario, source) {
  return {
    ...input,
    javaScenarios: input.javaScenarios.map((entry) =>
      entry.scenario === scenario ? { ...entry, source } : entry,
    ),
  };
}

function coordinate(artifact) {
  const separator = artifact.indexOf(":");
  return {
    groupId: artifact.slice(0, separator),
    artifactId: artifact.slice(separator + 1),
  };
}

function dependencyXml(dependency, indentation) {
  const { artifact, groupId, artifactId } = dependency;
  const defaults = artifact ? coordinate(artifact) : {};
  const elements = [
    dependency.groupIdXml ??
      `<groupId>${groupId ?? defaults.groupId}</groupId>`,
    dependency.artifactIdXml ??
      `<artifactId>${artifactId ?? defaults.artifactId}</artifactId>`,
  ];
  if (dependency.versionXml) {
    elements.push(dependency.versionXml);
  } else if (dependency.version) {
    elements.push(`<version>${dependency.version}</version>`);
  }
  elements.push(...(dependency.modifiers ?? []));
  const childIndentation = `${indentation}  `;
  return [
    `${indentation}<dependency>`,
    ...elements.map((element) => `${childIndentation}${element}`),
    `${indentation}</dependency>`,
  ].join("\n");
}

function syntheticPom(scenario, options = {}) {
  const defaultDirect = expectedDirectAzureDependencies
    .get(scenario)
    .map((artifact) => {
      const unmanaged = unmanagedDirectAllowlist.find(
        (entry) => entry.scenario === scenario && entry.artifact === artifact,
      );
      return { artifact, version: unmanaged?.version };
    });
  const directDependencies = options.directDependencies ?? defaultDirect;
  const defaultOverrides = managedOverrideAllowlist
    .filter((entry) => entry.scenario === scenario)
    .map(({ artifact, version }) => ({ artifact, version }));
  const managedOverrides = options.managedOverrides ?? defaultOverrides;
  const bomImports = [
    {
      groupId: "com.azure",
      artifactId: "azure-sdk-bom",
      version: "${azure-sdk-bom.version}",
      modifiers: options.bomModifiers ?? [
        "<type>pom</type>",
        "<scope>import</scope>",
      ],
    },
    ...(options.extraBomImports ?? []),
  ];

  const rootName = options.rootName ?? "project";
  const namespaceDeclarations =
    options.namespaceDeclarations ??
    `xmlns="${options.rootNamespace ?? mavenPomNamespace}"`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<${rootName} ${namespaceDeclarations}>
  <modelVersion>4.0.0</modelVersion>
${options.parent ?? ""}  <groupId>com.example</groupId>
  <artifactId>synthetic-${scenario}</artifactId>
  <version>1.0.0</version>
  <properties>
    <azure-sdk-bom.version>${options.bomPropertyValue ?? "1.3.8"}</azure-sdk-bom.version>
  </properties>
  <dependencyManagement>
    <dependencies>
${[...bomImports, ...managedOverrides]
  .map((dependency) => dependencyXml(dependency, "      "))
  .join("\n")}
    </dependencies>
  </dependencyManagement>
  <dependencies>
${directDependencies
  .map((dependency) => dependencyXml(dependency, "    "))
  .join("\n")}
  </dependencies>
${options.profiles ?? ""}${options.extraProjectElements ?? ""}</${rootName}>`;
}

test("Java goldens follow the pinned Azure SDK BOM policy", () => {
  validateJavaBomPolicy(loadPolicyInput());
});

test("policy rejects missing and duplicate direct dependencies", () => {
  const input = loadPolicyInput();
  const scenario = "app-configuration-java-config-values";

  const missing = withScenarioSource(
    input,
    scenario,
    syntheticPom(scenario, { directDependencies: [] }),
  );
  assert.throws(
    () => validateJavaBomPolicy(missing),
    /direct Azure dependency inventory changed/,
  );

  const duplicate = withScenarioSource(
    input,
    scenario,
    syntheticPom(scenario, {
      directDependencies: [
        { artifact: "com.azure:azure-data-appconfiguration" },
        { artifact: "com.azure:azure-data-appconfiguration" },
      ],
    }),
  );
  assert.throws(
    () => validateJavaBomPolicy(duplicate),
    /duplicate direct dependency com\.azure:azure-data-appconfiguration/,
  );
});

test("policy requires each managed override to have one direct dependency", () => {
  const input = loadPolicyInput();
  const scenario = "ai-projects-java-evaluation-run";
  const missing = withScenarioSource(
    input,
    scenario,
    syntheticPom(scenario, {
      directDependencies: [{ artifact: "com.azure:azure-identity" }],
    }),
  );

  assert.throws(
    () => validateJavaBomPolicy(missing),
    /direct Azure dependency inventory changed/,
  );
});

test("policy rejects active and inactive Maven profiles", () => {
  const input = loadPolicyInput();
  const activeProfile = `  <profiles>
    <profile>
      <id>active-hidden-azure-version</id>
      <activation>
        <activeByDefault>true</activeByDefault>
      </activation>
      <dependencies>
        <dependency>
          <groupId>com.azure</groupId>
          <artifactId>azure-identity</artifactId>
          <version>0.0.1</version>
        </dependency>
      </dependencies>
    </profile>
  </profiles>
`;
  const inactiveProfile = `  <profiles>
    <profile>
      <id>inactive-hidden-bom</id>
      <dependencyManagement>
        <dependencies>
          <dependency>
            <groupId>com.azure</groupId>
            <artifactId>azure-sdk-bom</artifactId>
            <version>0.0.1</version>
            <type>pom</type>
            <scope>import</scope>
          </dependency>
        </dependencies>
      </dependencyManagement>
    </profile>
  </profiles>
`;
  for (const profile of [activeProfile, inactiveProfile]) {
    const mutated = withScenarioSource(
      input,
      "app-configuration-java-config-values",
      syntheticPom("app-configuration-java-config-values", {
        profiles: profile,
      }),
    );
    assert.throws(
      () => validateJavaBomPolicy(mutated),
      /Maven profiles are not allowed in Java goldens/,
    );
  }
});

test("policy rejects semantic modifiers on managed overrides", () => {
  const input = loadPolicyInput();
  const modifiers = [
    "<type>pom</type>",
    "<classifier>tests</classifier>",
    "<scope>runtime</scope>",
    "<optional>true</optional>",
    "<exclusions/>",
  ];

  for (const modifier of modifiers) {
    const scenario = "ai-projects-java-dataset-lifecycle";
    const mutated = withScenarioSource(
      input,
      scenario,
      syntheticPom(scenario, {
        managedOverrides: [
          {
            artifact: "com.azure:azure-ai-projects",
            version: "2.4.0",
            modifiers: [modifier],
          },
          {
            artifact: "com.azure:azure-storage-blob",
            version: "12.35.1",
          },
        ],
      }),
    );
    assert.throws(
      () => validateJavaBomPolicy(mutated),
      /override must contain only groupId, artifactId, and version/,
    );
  }
});

test("policy rejects count-preserving dependency substitutions", () => {
  const input = loadPolicyInput();
  const scenario = "app-configuration-java-config-values";
  const mutated = withScenarioSource(
    input,
    scenario,
    syntheticPom(scenario, {
      directDependencies: [{ artifact: "com.azure:azure-identity" }],
    }),
  );

  assert.throws(
    () => validateJavaBomPolicy(mutated),
    /direct Azure dependency inventory changed/,
  );
});

test("policy rejects property-expanded dependency coordinates", () => {
  const input = loadPolicyInput();
  const scenario = "app-configuration-java-config-values";
  const mutated = withScenarioSource(
    input,
    scenario,
    syntheticPom(scenario, {
      directDependencies: [
        { artifact: "com.azure:azure-data-appconfiguration" },
        {
          groupId: "${azure.group}",
          artifactId: "azure-data-appconfiguration",
          version: "0.0.1",
        },
      ],
    }),
  );

  assert.throws(
    () => validateJavaBomPolicy(mutated),
    /property expressions are not allowed in <groupId>/,
  );
});

test("policy decodes XML entities before detecting duplicate BOM imports", () => {
  const input = loadPolicyInput();
  const scenario = "app-configuration-java-config-values";
  const mutated = withScenarioSource(
    input,
    scenario,
    syntheticPom(scenario, {
      extraBomImports: [
        {
          groupId: "com&#46;azure",
          artifactId: "azure-sdk-bom",
          version: "${azure-sdk-bom.version}",
          modifiers: ["<type>pom</type>", "<scope>import</scope>"],
        },
      ],
    }),
  );

  assert.throws(
    () => validateJavaBomPolicy(mutated),
    /expected one BOM import/,
  );
});

test("policy accepts equivalent XML text forms", () => {
  const input = loadPolicyInput();
  const scenario = "app-configuration-java-config-values";
  const mutated = withScenarioSource(
    input,
    scenario,
    syntheticPom(scenario, {
      directDependencies: [
        {
          groupId: "<![CDATA[\n com.azure \n]]>",
          artifactId: " azure-data-appconfigurati&#111;n ",
        },
      ],
    }),
  );

  validateJavaBomPolicy(mutated);
});

test("policy keeps entity-like CDATA text literal", () => {
  const input = loadPolicyInput();
  const scenario = "app-configuration-java-config-values";
  const mutated = withScenarioSource(
    input,
    scenario,
    syntheticPom(scenario, {
      directDependencies: [
        {
          groupId: "com.azure",
          artifactId: "<![CDATA[azure-data-appconfigurati&#111;n]]>",
        },
      ],
    }),
  );

  assert.throws(
    () => validateJavaBomPolicy(mutated),
    /invalid Maven <artifactId> coordinate/,
  );
});

test("policy rejects project-level Maven parents", () => {
  const input = loadPolicyInput();
  const parent = `  <parent>
    <groupId>com.example</groupId>
    <artifactId>shared-parent</artifactId>
    <version>1.0.0</version>
  </parent>
`;
  const scenario = "app-configuration-java-config-values";
  const mutated = withScenarioSource(
    input,
    scenario,
    syntheticPom(scenario, { parent }),
  );

  assert.throws(
    () => validateJavaBomPolicy(mutated),
    /Maven parent POMs are not allowed/,
  );
});

test("policy fails closed on malformed and unsafe XML", () => {
  const input = loadPolicyInput();
  const scenario = "app-configuration-java-config-values";
  const invalidDocuments = [
    ["unknown entity", "<project>&unknown;</project>", /malformed XML/],
    ["multiple roots", "<project/><project/>", /malformed XML/],
    ["invalid comment", "<project><!-- bad--comment --></project>", /malformed XML/],
    ["invalid attribute", "<project bad=unquoted/>", /malformed XML/],
    [
      "mismatched qualified names",
      '<m:project xmlns:m="urn:test"></project>',
      /malformed XML/,
    ],
    ["uppercase character reference", "<project>&#X41;</project>", /malformed XML/],
    [
      "internal DTD",
      "<!DOCTYPE project [<!ENTITY x \"value\">]><project>&x;</project>",
      /DTDs and external entities are not allowed/,
    ],
    [
      "external entity",
      '<!DOCTYPE project [<!ENTITY x SYSTEM "file:///etc/passwd">]><project>&x;</project>',
      /DTDs and external entities are not allowed/,
    ],
  ];

  for (const [name, source, expected] of invalidDocuments) {
    assert.throws(
      () =>
        validateJavaBomPolicy(
          withScenarioSource(input, scenario, source),
        ),
      expected,
      name,
    );
  }
});

test("policy requires the Maven namespace for every POM element", () => {
  const input = loadPolicyInput();
  const scenario = "app-configuration-java-config-values";
  const wrongRoots = [
    syntheticPom(scenario, { rootNamespace: "urn:not-maven" }),
    syntheticPom(scenario, {
      rootName: "spoof:project",
      namespaceDeclarations:
        'xmlns="http://maven.apache.org/POM/4.0.0" xmlns:spoof="urn:not-maven"',
    }),
  ];
  const policyElements = [
    "project",
    "properties",
    "dependencyManagement",
    "dependencies",
    "dependency",
    "groupId",
    "artifactId",
    "version",
    "type",
    "scope",
    "classifier",
    "optional",
    "exclusions",
    "profiles",
    "parent",
  ];
  const mixedChildren = policyElements.map((name) =>
    syntheticPom(scenario, {
      extraProjectElements: `  <spoof:${name} xmlns:spoof="urn:not-maven"/>
`,
    }),
  );

  for (const source of [...wrongRoots, ...mixedChildren]) {
    assert.throws(
      () =>
        validateJavaBomPolicy(withScenarioSource(input, scenario, source)),
      /every POM element must use the Maven POM namespace/,
    );
  }
});

test("policy permits the standard Maven xsi schema attributes", () => {
  const input = loadPolicyInput();
  const scenario = "app-configuration-java-config-values";
  const source = syntheticPom(scenario, {
    namespaceDeclarations:
      `xmlns="${mavenPomNamespace}" ` +
      'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
      `xsi:schemaLocation="${mavenPomNamespace} https://maven.apache.org/xsd/maven-4.0.0.xsd"`,
  });

  validateJavaBomPolicy(withScenarioSource(input, scenario, source));
});

test("policy rejects nested markup in consumed scalar elements", () => {
  const input = loadPolicyInput();
  const simpleScenario = "app-configuration-java-config-values";
  const overrideScenario = "ai-projects-java-dataset-lifecycle";
  const nested = "<nested/>";
  const fixtures = [
    [
      "groupId",
      syntheticPom(simpleScenario, {
        directDependencies: [
          {
            groupIdXml: `<groupId>com.azure${nested}</groupId>`,
            artifactId: "azure-data-appconfiguration",
          },
        ],
      }),
      simpleScenario,
    ],
    [
      "artifactId",
      syntheticPom(simpleScenario, {
        directDependencies: [
          {
            groupId: "com.azure",
            artifactIdXml: `<artifactId>azure-data-appconfiguration${nested}</artifactId>`,
          },
        ],
      }),
      simpleScenario,
    ],
    [
      "version",
      syntheticPom(overrideScenario, {
        managedOverrides: [
          {
            artifact: "com.azure:azure-ai-projects",
            versionXml: `<version>2.4.0${nested}</version>`,
          },
          {
            artifact: "com.azure:azure-storage-blob",
            version: "12.35.1",
          },
        ],
      }),
      overrideScenario,
    ],
    ...["type", "scope", "classifier", "optional"].map((name) => [
      name,
      syntheticPom(overrideScenario, {
        managedOverrides: [
          {
            artifact: "com.azure:azure-ai-projects",
            version: "2.4.0",
            modifiers: [`<${name}>value${nested}</${name}>`],
          },
          {
            artifact: "com.azure:azure-storage-blob",
            version: "12.35.1",
          },
        ],
      }),
      overrideScenario,
    ]),
    [
      bomProperty,
      syntheticPom(simpleScenario, {
        bomPropertyValue: `1.3.8${nested}`,
      }),
      simpleScenario,
    ],
  ];

  for (const [element, source, scenario] of fixtures) {
    assert.throws(
      () =>
        validateJavaBomPolicy(withScenarioSource(input, scenario, source)),
      new RegExp(`<${element.replace(".", "\\.")}> must contain text only`),
      element,
    );
  }
});
