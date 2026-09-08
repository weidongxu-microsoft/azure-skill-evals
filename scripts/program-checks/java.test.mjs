import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { main, selectJavaBuild } from "./java.mjs";

function workspace() {
  return mkdtempSync(path.join(tmpdir(), "java-program-check-"));
}

test("selects Maven when pom.xml is present", () => {
  const root = workspace();
  writeFileSync(path.join(root, "pom.xml"), "");

  assert.deepEqual(selectJavaBuild(root, "linux"), {
    command: "mvn",
    args: ["-q", "-DskipTests", "compile"],
  });
  assert.deepEqual(selectJavaBuild(root, "win32"), {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", "mvn -q -DskipTests compile"],
    windowsVerbatimArguments: true,
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
    command: "powershell.exe",
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `& '${path.join(root, "gradlew.bat")}' compileJava --no-daemon`,
    ],
  });
});

test(
  "executes a Windows Gradle wrapper whose path contains spaces",
  { skip: process.platform !== "win32" },
  () => {
    const root = path.join(workspace(), "project with spaces");
    mkdirSync(root);
    writeFileSync(path.join(root, "gradlew.bat"), "@exit /b 0\r\n");

    assert.equal(main(root), 0);
  },
);

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
