import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  evaluateRule,
  loadGoWorkspace,
  ruleNames,
} from "./tools/identity-go-rules.mjs";

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

test.skip("aliases and an ordered credential-chain explanation are accepted", () => {
  const source = `
package main
import (
  "errors"
  core "github.com/Azure/azure-sdk-for-go/sdk/azcore"
  identity "github.com/Azure/azure-sdk-for-go/sdk/azidentity"
  secrets "github.com/Azure/azure-sdk-for-go/sdk/security/keyvault/azsecrets"
)
// DefaultAzureCredential tries EnvironmentCredential, then
// WorkloadIdentityCredential, ManagedIdentityCredential, and AzureCLICredential.
func run() error {
  credential, err := identity.NewDefaultAzureCredential(nil)
  if err != nil { return err }
  client, err := secrets.NewClient(vaultURL, credential, nil)
  if err != nil {
    var responseError *core.ResponseError
    if errors.As(err, &responseError) { return responseError }
  }
  _, err = client.GetSecret(ctx, name, "", nil)
  return err
}`;
  for (const rule of ruleNames().filter(
    (name) => name !== "prompt/azidentity-module",
  )) {
    assert.equal(evaluateRule(rule, workspace(source)), true, rule);
  }
});

test.skip("unordered names and disconnected credentials are rejected", () => {
  const source = workspace(`package main
// ManagedIdentityCredential, EnvironmentCredential, AzureCLICredential
func run() {
  credential, _ := azidentity.NewDefaultAzureCredential(nil)
  client, _ := azsecrets.NewClient(vaultURL, otherCredential, nil)
  _, _ = credential, client
}`);
  assert.equal(evaluateRule("prompt/credential-chain-order", source), false);
  assert.equal(
    evaluateRule("prompt/credential-client-constructor", source),
    false,
  );
});
