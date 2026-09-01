import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  evaluateRule,
  loadGoWorkspace,
  ruleNames,
} from "./tools/storage-go-rules.mjs";

const goldenPath = fileURLToPath(new URL("./golden", import.meta.url));
const golden = loadGoWorkspace(goldenPath);

function workspace(source, goMod = golden.goMod) {
  return { sourceFiles: source.trim() ? ["main.go"] : [], source, goMod, goSum: "" };
}

test.skip("the golden application passes exactly nine prompt rules", () => {
  assert.equal(ruleNames().length, 9);
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, golden), true, rule);
  }
});

test.skip("missing Go source fails every rule", () => {
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, workspace("")), false, rule);
  }
});

test.skip("aliases and split construction are accepted", () => {
  const source = `
package main
import (
  identity "github.com/Azure/azure-sdk-for-go/sdk/azidentity"
  storage "github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/storage/armstorage"
)
func run() error {
  cred, err := identity.NewDefaultAzureCredential(nil)
  if err != nil { return err }
  client, err := storage.NewAccountsClient(subscriptionID, cred, nil)
  if err != nil { return err }
  params := storage.AccountCreateParameters{
    SKU: &storage.SKU{Name: toPtr(storage.SKUNameStandardLRS)},
    Kind: toPtr(storage.KindStorageV2), Location: toPtr(location),
  }
  poller, err := client.BeginCreate(ctx, group, account, params, nil)
  if err != nil { return err }
  _, err = poller.PollUntilDone(ctx, nil)
  return err
}`;
  for (const rule of [
    "prompt/default-azure-credential",
    "prompt/accounts-client",
    "prompt/begin-create",
    "prompt/poll-until-done",
  ]) {
    assert.equal(evaluateRule(rule, workspace(source)), true, rule);
  }
});

test.skip("comments and strings cannot provide account operations", () => {
  const fake = workspace(`package main
// client.BeginCreate(); poller.PollUntilDone()
var example = "client.Update(); client.Delete()"
`);
  for (const rule of [
    "prompt/begin-create",
    "prompt/poll-until-done",
    "prompt/update-account",
    "prompt/delete-account",
  ]) {
    assert.equal(evaluateRule(rule, fake), false, rule);
  }
});
