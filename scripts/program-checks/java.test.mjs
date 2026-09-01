import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { selectJavaBuild } from "./java.mjs";

function workspace() {
  return mkdtempSync(path.join(tmpdir(), "java-program-check-"));
}

test("selects Maven when pom.xml is present", () => {
  const root = workspace();
  writeFileSync(path.join(root, "pom.xml"), "");

  assert.deepEqual(selectJavaBuild(root), {
    command: "mvn",
    args: ["-q", "-DskipTests", "compile"],
  });
});

test("selects the platform Gradle wrapper", () => {
  const root = workspace();
  writeFileSync(path.join(root, "gradlew"), "");
  writeFileSync(path.join(root, "gradlew.bat"), "");

  assert.deepEqual(selectJavaBuild(root, "linux"), {
    command: "sh",
    args: [path.join(root, "gradlew"), "compileJava", "--no-daemon"],
  });
  assert.deepEqual(selectJavaBuild(root, "win32"), {
    command: path.join(root, "gradlew.bat"),
    args: ["compileJava", "--no-daemon"],
  });
});

test("falls back to installed Gradle for either build manifest", () => {
  for (const manifest of ["build.gradle", "build.gradle.kts"]) {
    const root = workspace();
    writeFileSync(path.join(root, manifest), "");

    assert.deepEqual(selectJavaBuild(root), {
      command: "gradle",
      args: ["compileJava", "--no-daemon"],
    });
  }
});

test("rejects workspaces without a supported Java manifest", () => {
  const root = workspace();
  mkdirSync(path.join(root, "src"));

  assert.throws(
    () => selectJavaBuild(root),
    /No supported Java build manifest found/,
  );
});
