import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  evaluateGoCheck,
  goCodeOnly,
  loadGoWorkspace,
} from "./checks.mjs";

const completeWorkspace = {
  sourceFiles: ["main.go"],
  hasGoMod: true,
  goMod: `module example.com/azure

go 1.25.0

require github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/resources/armresources v1.2.0
`,
  source: `
package main

import (
    "context"
    "fmt"
    "github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/resources/armresources"
)

func run(ctx context.Context, client *armresources.ResourceGroupsClient) error {
    response, err := client.Get(ctx, "example", nil)
    if err != nil {
        return fmt.Errorf("get resource group: %w", err)
    }
    _ = response
    pager := client.NewListPager(nil)
    for pager.More() {
        if _, err := pager.NextPage(ctx); err != nil {
            return fmt.Errorf("list resource groups: %w", err)
        }
    }
    poller, err := client.BeginDelete(ctx, "example", nil)
    if err != nil {
        return fmt.Errorf("begin delete: %w", err)
    }
    if _, err := poller.PollUntilDone(ctx, nil); err != nil {
        return fmt.Errorf("delete: %w", err)
    }
    return nil
}
`,
};

test.skip("shared Go checks accept a current SDK application", () => {
  for (const check of [
    "language/go-module-manifest",
    "language/current-azure-modules",
    "language/returned-error-handling",
    "language/context-propagation",
    "language/pager-iteration",
    "language/poller-usage",
  ]) {
    assert.equal(evaluateGoCheck(check, completeWorkspace), true, check);
  }
});

test.skip("legacy modules and discarded errors fail", () => {
  const workspace = {
    ...completeWorkspace,
    goMod: completeWorkspace.goMod.replace(
      "/sdk/resourcemanager/resources/armresources",
      "",
    ),
    source: completeWorkspace.source
      .replace("/sdk/resourcemanager/resources/armresources", "")
      .replace(
        "response, err := client.Get(ctx, \"example\", nil)",
        "response, _ := client.Get(ctx, \"example\", nil)",
      ),
  };

  assert.equal(
    evaluateGoCheck("language/current-azure-modules", workspace),
    false,
  );
  assert.equal(
    evaluateGoCheck("language/returned-error-handling", {
      ...workspace,
      source: "package main\nfunc main() { value, _ := operation() }",
    }),
    false,
  );
});

test.skip("comments and strings cannot satisfy behavioral checks", () => {
  const source = `
package main
// pager := client.NewListPager(nil); pager.More(); pager.NextPage(ctx)
const fake = "poller, err := client.BeginDelete(ctx); poller.PollUntilDone(ctx, nil)"
`;
  const workspace = { ...completeWorkspace, source };

  assert.equal(evaluateGoCheck("language/pager-iteration", workspace), false);
  assert.equal(evaluateGoCheck("language/poller-usage", workspace), false);
  assert.doesNotMatch(goCodeOnly(source), /PollUntilDone/);
});

test.skip("loader reads only root production source and root go.mod", () => {
  const root = fileURLToPath(
    new URL(
      "../../scenarios/resource-manager-go-resource-group-crud/golden",
      import.meta.url,
    ),
  );
  const workspace = loadGoWorkspace(root);

  assert.equal(workspace.sourceFiles.length, 1);
  assert.equal(workspace.hasGoMod, true);
  assert.match(workspace.goMod, /armresources/);
});
