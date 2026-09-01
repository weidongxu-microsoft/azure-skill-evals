import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  evaluateRule,
  loadGoWorkspace,
  ruleNames,
} from "./tools/resource-manager-go-rules.mjs";

const goldenPath = fileURLToPath(new URL("./golden", import.meta.url));
const golden = loadGoWorkspace(goldenPath);

function workspace(source, goMod = golden.goMod) {
  return { sourceFiles: source.trim() ? ["app.go"] : [], source, goMod, goSum: "" };
}

test.skip("the golden application passes exactly eight prompt rules", () => {
  assert.equal(ruleNames().length, 8);
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, golden), true, rule);
  }
});

test.skip("missing Go source fails every rule", () => {
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, workspace("")), false, rule);
  }
});

test.skip("qualified aliases and a variable tag map are accepted", () => {
  const source = `
package main
import (
  identity "github.com/Azure/azure-sdk-for-go/sdk/azidentity"
  resources "github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/resources/armresources"
)
func run() error {
  credential, err := identity.NewDefaultAzureCredential(nil)
  if err != nil { return err }
  client, err := resources.NewResourceGroupsClient(subscriptionID, credential, nil)
  if err != nil { return err }
  tags := map[string]*string{"environment": toPtr("test")}
  _, err = client.CreateOrUpdate(ctx, name, resources.ResourceGroup{
    Location: toPtr("eastus"), Tags: tags,
  }, nil)
  return err
}`;
  for (const rule of [
    "prompt/default-azure-credential",
    "prompt/resource-groups-client",
    "prompt/create-or-update",
    "prompt/tags-map",
  ]) {
    assert.equal(evaluateRule(rule, workspace(source)), true, rule);
  }
});

test.skip("pager and poller names in comments do not pass", () => {
  const fake = workspace(`package main
// pager := client.NewListPager(nil); pager.More(); pager.NextPage(ctx)
var text = "client.BeginDelete(); poller.PollUntilDone()"
`);
  assert.equal(evaluateRule("prompt/list-pager", fake), false);
  assert.equal(evaluateRule("prompt/begin-delete-poller", fake), false);
});
