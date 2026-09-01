import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  evaluateJavaCheck,
  loadJavaWorkspace,
} from "./checks.mjs";

const mavenDependency = (artifact, scope = "") => `
<dependency>
  <groupId>com.azure</groupId>
  <artifactId>${artifact}</artifactId>
  <version>1.0.0</version>
  ${scope ? `<scope>${scope}</scope>` : ""}
</dependency>`;

const completeWorkspace = {
  sourceFiles: ["Main.java"],
  buildFiles: ["pom.xml"],
  build: `
<project>
  <dependencies>
    ${mavenDependency("azure-identity")}
    ${mavenDependency("azure-security-keyvault-secrets")}
  </dependencies>
</project>
`,
  source: `
import com.azure.identity.DefaultAzureCredentialBuilder;
import com.azure.security.keyvault.secrets.SecretClient;
import com.azure.security.keyvault.secrets.SecretClientBuilder;

class Main {
    void run() {
        var credential = new DefaultAzureCredentialBuilder().build();
        SecretClient client = new SecretClientBuilder()
            .vaultUrl("https://example")
            .credential(credential)
            .buildClient();
        client.getSecret("name");
    }
}
`,
};

function withManifests(workspace, buildManifests) {
  return {
    ...workspace,
    buildFiles: buildManifests.map(({ name }) => name),
    buildManifests,
    build: buildManifests.map(({ content }) => content).join("\n"),
  };
}

test.skip("shared Java checks accept a current SDK application", () => {
  for (const check of [
    "language/build-manifest",
    "language/current-azure-dependencies",
    "language/current-imports",
    "language/client-builder",
  ]) {
    assert.equal(evaluateJavaCheck(check, completeWorkspace), true, check);
  }
});

test.skip("legacy dependencies and internal imports fail", () => {
  const workspace = {
    ...completeWorkspace,
    build: completeWorkspace.build.replace("com.azure", "com.microsoft.azure"),
    source: completeWorkspace.source.replace(
      "com.azure.security.keyvault.secrets",
      "com.azure.security.keyvault.secrets.implementation",
    ),
  };

  assert.equal(
    evaluateJavaCheck("language/current-azure-dependencies", workspace),
    false,
  );
  assert.equal(
    evaluateJavaCheck("language/current-imports", workspace),
    false,
  );
});

test.skip("constructing a client without its builder fails", () => {
  const workspace = {
    ...completeWorkspace,
    source: completeWorkspace.source
      .replace("new SecretClientBuilder()", "legacyFactory()")
      .replace(".buildClient()", ""),
  };

  assert.equal(evaluateJavaCheck("language/client-builder", workspace), false);
});

test.skip("dependency pins split across manifests do not combine", () => {
  const workspace = withManifests(completeWorkspace, [
    {
      name: "pom.xml",
      content: `<project><dependencies>
        ${mavenDependency("azure-identity")}
      </dependencies></project>`,
    },
    {
      name: "build.gradle.kts",
      content: `plugins { java }
        dependencies {
          implementation(
            "com.azure:azure-security-keyvault-secrets:1.0.0"
          )
        }`,
    },
  ]);

  assert.equal(evaluateJavaCheck("language/build-manifest", workspace), true);
  assert.equal(
    evaluateJavaCheck("language/current-azure-dependencies", workspace),
    false,
  );
});

test.skip("one complete Maven manifest can satisfy dependency checks", () => {
  const workspace = withManifests(completeWorkspace, [
    {
      name: "build.gradle",
      content: `plugins { id "java" }
        dependencies {
          implementation "com.azure:azure-identity:1.0.0"
        }`,
    },
    {
      name: "pom.xml",
      content: completeWorkspace.build,
    },
  ]);

  assert.equal(
    evaluateJavaCheck("language/current-azure-dependencies", workspace),
    true,
  );
});

test.skip("one complete Gradle manifest can satisfy dependency checks", () => {
  const workspace = withManifests(completeWorkspace, [
    {
      name: "pom.xml",
      content: `<project><dependencies>
        ${mavenDependency("azure-identity")}
      </dependencies></project>`,
    },
    {
      name: "build.gradle.kts",
      content: `plugins { java }
        dependencies {
          implementation("com.azure:azure-identity:1.0.0")
          runtimeOnly(
            "com.azure:azure-security-keyvault-secrets:1.0.0"
          )
        }`,
    },
  ]);

  assert.equal(
    evaluateJavaCheck("language/current-azure-dependencies", workspace),
    true,
  );
});

test.skip("inactive, commented, and non-runtime dependencies do not count", () => {
  const inactiveMaven = `<project>
    <dependencies>
      ${mavenDependency("azure-identity", "test")}
    </dependencies>
    <profiles>
      <profile>
        <id>inactive</id>
        <dependencies>
          ${mavenDependency("azure-identity")}
          ${mavenDependency("azure-security-keyvault-secrets")}
        </dependencies>
      </profile>
    </profiles>
    <!-- ${mavenDependency("azure-security-keyvault-secrets")} -->
  </project>`;
  const inactiveGradle = `plugins { java }
    dependencies {
      testImplementation("com.azure:azure-identity:1.0.0")
      if (false) {
        implementation(
          "com.azure:azure-security-keyvault-secrets:1.0.0"
        )
      }
      // implementation("com.azure:azure-identity:1.0.0")
    }`;

  for (const workspace of [
    withManifests(completeWorkspace, [
      { name: "pom.xml", content: inactiveMaven },
    ]),
    withManifests(completeWorkspace, [
      { name: "build.gradle", content: inactiveGradle },
    ]),
  ]) {
    assert.equal(
      evaluateJavaCheck("language/current-azure-dependencies", workspace),
      false,
    );
  }
});

test.skip("buildscript and statically inactive Gradle branches do not count", () => {
  const workspace = withManifests(completeWorkspace, [{
    name: "build.gradle",
    content: `plugins { id "java" }
      buildscript {
        dependencies {
          implementation "com.azure:azure-identity:1.0.0"
        }
      }
      dependencies {
        if (true) {
          implementation "com.azure:azure-identity:1.0.0"
        } else {
          implementation(
            "com.azure:azure-security-keyvault-secrets:1.0.0"
          )
        }
      }`,
  }]);

  assert.equal(
    evaluateJavaCheck("language/current-azure-dependencies", workspace),
    false,
  );
});

test.skip("an active Maven profile may provide the complete dependency set", () => {
  const workspace = withManifests(completeWorkspace, [{
    name: "pom.xml",
    content: `<project>
      <profiles>
        <profile>
          <activation><activeByDefault>true</activeByDefault></activation>
          <dependencies>
            ${mavenDependency("azure-identity")}
            ${mavenDependency("azure-security-keyvault-secrets")}
          </dependencies>
        </profile>
      </profiles>
    </project>`,
  }]);

  assert.equal(
    evaluateJavaCheck("language/current-azure-dependencies", workspace),
    true,
  );
});

test.skip("Maven profile activation predicates are conjunctive", () => {
  const workspace = withManifests(completeWorkspace, [{
    name: "pom.xml",
    content: `<project>
      <profiles>
        <profile>
          <activation>
            <activeByDefault>true</activeByDefault>
            <jdk>[21,)</jdk>
          </activation>
          <dependencies>
            ${mavenDependency("azure-identity")}
            ${mavenDependency("azure-security-keyvault-secrets")}
          </dependencies>
        </profile>
      </profiles>
    </project>`,
  }]);

  assert.equal(
    evaluateJavaCheck("language/current-azure-dependencies", workspace),
    false,
  );
});

test.skip("inactive legacy dependencies do not invalidate a complete manifest", () => {
  const workspace = withManifests(completeWorkspace, [{
    name: "pom.xml",
    content: completeWorkspace.build.replace(
      "</project>",
      `<profiles>
        <profile>
          <dependencies>
            <dependency>
              <groupId>com.microsoft.azure</groupId>
              <artifactId>azure</artifactId>
              <version>1.0.0</version>
            </dependency>
          </dependencies>
        </profile>
      </profiles>
      <!-- com.microsoft.azure:azure:1.0.0 -->
      </project>`,
    ),
  }]);

  assert.equal(
    evaluateJavaCheck("language/current-azure-dependencies", workspace),
    true,
  );
});

test.skip("loader retains each Java build manifest independently", () => {
  const root = fileURLToPath(
    new URL(
      "../../scenarios/identity-java-default-azure-credential/golden",
      import.meta.url,
    ),
  );
  const workspace = loadJavaWorkspace(root);

  assert.equal(workspace.buildManifests.length, 1);
  assert.equal(workspace.buildManifests[0].name, "pom.xml");
  assert.match(workspace.buildManifests[0].content, /azure-identity/);
});
