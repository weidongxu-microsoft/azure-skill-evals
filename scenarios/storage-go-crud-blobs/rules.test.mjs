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

test.skip("UploadStream and standard pager iteration are accepted", () => {
  const source = `
package main
import (
  "io"
  blobs "github.com/Azure/azure-sdk-for-go/sdk/storage/azblob"
)
func run() error {
  client, _ := blobs.NewClient(serviceURL, credential, nil)
  _, _ = client.CreateContainer(ctx, container, nil)
  _, _ = client.UploadStream(ctx, container, blob, reader, nil)
  pager := client.NewListBlobsFlatPager(container, nil)
  for pager.More() {
    if _, err := pager.NextPage(ctx); err != nil { return err }
  }
  response, err := client.DownloadStream(ctx, container, blob, nil)
  if err != nil { return err }
  defer response.Body.Close()
  _, err = io.ReadAll(response.Body)
  _, _ = client.DeleteBlob(ctx, container, blob, nil)
  _, _ = client.DeleteContainer(ctx, container, nil)
  return err
}`;
  for (const rule of [
    "prompt/create-container",
    "prompt/upload-blob",
    "prompt/list-blobs-pager",
    "prompt/download-blob",
    "prompt/delete-blob-and-container",
  ]) {
    assert.equal(evaluateRule(rule, workspace(source)), true, rule);
  }
});

test.skip("comments and strings cannot provide blob operations", () => {
  const fake = workspace(`package main
// client.UploadBuffer(); client.NewListBlobsFlatPager()
var text = "client.DownloadStream(); client.DeleteBlob()"
`);
  for (const rule of [
    "prompt/upload-blob",
    "prompt/list-blobs-pager",
    "prompt/download-blob",
    "prompt/delete-blob-and-container",
  ]) {
    assert.equal(evaluateRule(rule, fake), false, rule);
  }
});
