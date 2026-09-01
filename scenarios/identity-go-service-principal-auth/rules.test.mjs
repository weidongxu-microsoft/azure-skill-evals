import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  evaluateRule,
  loadGoWorkspace,
  ruleNames,
} from "./tools/service-principal-go-rules.mjs";

const goldenPath = fileURLToPath(new URL("./golden", import.meta.url));
const golden = loadGoWorkspace(goldenPath);

function workspace(source, goMod = golden.goMod) {
  return { sourceFiles: source.trim() ? ["main.go"] : [], source, goMod, goSum: "" };
}

test.skip("the golden application passes exactly five prompt rules", () => {
  assert.equal(ruleNames().length, 5);
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, golden), true, rule);
  }
});

test.skip("missing Go source fails every rule", () => {
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, workspace("")), false, rule);
  }
});

test.skip("aliased packages and environment-backed parameters are accepted", () => {
  const source = `
package main
import (
  "os"
  identity "github.com/Azure/azure-sdk-for-go/sdk/azidentity"
  secrets "github.com/Azure/azure-sdk-for-go/sdk/security/keyvault/azsecrets"
)
func run() error {
  tenantID := os.Getenv("AZURE_TENANT_ID")
  clientID := os.Getenv("AZURE_CLIENT_ID")
  secret := os.Getenv("AZURE_CLIENT_SECRET")
  credential, err := identity.NewClientSecretCredential(
    tenantID, clientID, secret, nil,
  )
  if err != nil { return err }
  _, err = secrets.NewClient(vaultURL, credential, nil)
  return err
}`;
  for (const rule of ruleNames().filter(
    (name) => name !== "prompt/client-secret-credential",
  )) {
    assert.equal(evaluateRule(rule, workspace(source)), true, rule);
  }
});

test.skip("an unused credential does not satisfy client association", () => {
  const source = workspace(`package main
func run() {
  credential, _ := azidentity.NewClientSecretCredential(a, b, c, nil)
  client, _ := azsecrets.NewClient(vaultURL, otherCredential, nil)
  _, _ = credential, client
}`);
  assert.equal(
    evaluateRule("prompt/credential-client-constructor", source),
    false,
  );
});
