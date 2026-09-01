import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  evaluateRule,
  loadGoWorkspace,
  ruleNames,
} from "./tools/managed-identity-go-rules.mjs";

const goldenPath = fileURLToPath(new URL("./golden", import.meta.url));
const golden = loadGoWorkspace(goldenPath);

function workspace(source, goMod = golden.goMod) {
  return { sourceFiles: source.trim() ? ["main.go"] : [], source, goMod, goSum: "" };
}

test.skip("the golden application passes exactly six prompt rules", () => {
  assert.equal(ruleNames().length, 6);
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, golden), true, rule);
  }
});

test.skip("missing Go source fails every rule", () => {
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, workspace("")), false, rule);
  }
});

test.skip("qualified aliases and variable client IDs are accepted", () => {
  const source = `
package main
import identity "github.com/Azure/azure-sdk-for-go/sdk/azidentity"
func credentials() error {
  system, err := identity.NewManagedIdentityCredential(nil)
  if err != nil { return err } // fallback when not running in Azure
  options := &identity.ManagedIdentityCredentialOptions{
    ID: identity.ClientID(clientID),
  }
  user, err := identity.NewManagedIdentityCredential(options)
  if err != nil { return err }
  fallback, err := identity.NewDefaultAzureCredential(nil)
  if err != nil { return err }
  _, err = identity.NewChainedTokenCredential(
    []azcore.TokenCredential{system, user, fallback}, nil,
  )
  return err
}`;
  for (const rule of ruleNames().filter(
    (name) => name !== "prompt/managed-identity-credential",
  )) {
    assert.equal(evaluateRule(rule, workspace(source)), true, rule);
  }
});

test.skip("comments and unrelated option fields do not pass", () => {
  const fake = workspace(`package main
// azidentity.NewManagedIdentityCredential(nil)
func run() {
  options := ManagedIdentityCredentialOptions{ClientID: ClientID(value)}
  _ = options
}`);
  assert.equal(
    evaluateRule("prompt/managed-identity-credential", fake),
    false,
  );
  assert.equal(evaluateRule("prompt/user-assigned-client-id", fake), false);
});
