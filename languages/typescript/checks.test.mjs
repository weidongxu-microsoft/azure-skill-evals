import assert from "node:assert/strict";
import test from "node:test";

import { evaluateTypeScriptCheck } from "./checks.mjs";

const completeWorkspace = {
  sourceFiles: ["app.ts"],
  packageJson: JSON.stringify({
    dependencies: { "@azure/storage-blob": "12.0.0" },
  }),
  hasTsconfig: true,
  source: `
import { BlobServiceClient } from "@azure/storage-blob";

async function main(): Promise<void> {
  const client = new BlobServiceClient("https://example");
  await client.getProperties();
}
`,
};

test.skip("shared TypeScript checks accept a current async SDK application", () => {
  for (const check of [
    "language/package-manifest",
    "language/current-azure-packages",
    "language/async-await",
    "language/typescript-config",
  ]) {
    assert.equal(evaluateTypeScriptCheck(check, completeWorkspace), true, check);
  }
});

test.skip("legacy packages and missing TypeScript configuration fail", () => {
  const workspace = {
    ...completeWorkspace,
    packageJson: JSON.stringify({
      dependencies: { "azure-storage": "2.10.7" },
    }),
    hasTsconfig: false,
  };

  assert.equal(
    evaluateTypeScriptCheck("language/current-azure-packages", workspace),
    false,
  );
  assert.equal(
    evaluateTypeScriptCheck("language/typescript-config", workspace),
    false,
  );
});
