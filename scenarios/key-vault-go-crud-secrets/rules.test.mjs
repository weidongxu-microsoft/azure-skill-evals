import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  evaluateRule,
  loadGoWorkspace,
  ruleNames,
} from "./tools/key-vault-go-rules.mjs";

const goldenPath = fileURLToPath(new URL("./golden", import.meta.url));
const golden = loadGoWorkspace(goldenPath);

function workspace(source, goMod = golden.goMod) {
  return { sourceFiles: source.trim() ? ["app.go"] : [], source, goMod, goSum: "" };
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

test.skip("qualified aliases and errors.As are accepted", () => {
  const source = `
package main
import (
  "errors"
  core "github.com/Azure/azure-sdk-for-go/sdk/azcore"
  identity "github.com/Azure/azure-sdk-for-go/sdk/azidentity"
  secrets "github.com/Azure/azure-sdk-for-go/sdk/security/keyvault/azsecrets"
)
func run() error {
  credential, err := identity.NewDefaultAzureCredential(nil)
  if err != nil { return err }
  client, err := secrets.NewClient(vaultURL, credential, nil)
  if err != nil { return err }
  _, err = client.SetSecret(ctx, name, value, nil)
  _, err = client.GetSecret(ctx, name, "", nil)
  _, err = client.SetSecret(ctx, name, updated, nil)
  _, err = client.DeleteSecret(ctx, name, nil)
  _, err = client.PurgeDeletedSecret(ctx, name, nil)
  if err != nil {
    var responseError *core.ResponseError
    if errors.As(err, &responseError) { return responseError }
  }
  return err
}`;
  for (const rule of [
    "prompt/secrets-client",
    "prompt/secret-crud",
    "prompt/response-error",
  ]) {
    assert.equal(evaluateRule(rule, workspace(source)), true, rule);
  }
});

test.skip("operation names in comments and strings do not pass", () => {
  const fake = workspace(`package main
// client.SetSecret(); client.GetSecret()
var text = "client.DeleteSecret(); client.PurgeDeletedSecret()"
`);
  assert.equal(evaluateRule("prompt/secret-crud", fake), false);
});
