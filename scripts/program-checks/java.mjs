import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

export function selectJavaBuild(workDir, platform = process.platform) {
  if (existsSync(path.join(workDir, "pom.xml"))) {
    return {
      command: "mvn",
      args: ["-q", "-DskipTests", "compile"],
    };
  }

  const windowsWrapper = path.join(workDir, "gradlew.bat");
  const unixWrapper = path.join(workDir, "gradlew");
  if (platform === "win32" && existsSync(windowsWrapper)) {
    return {
      command: windowsWrapper,
      args: ["compileJava", "--no-daemon"],
    };
  }
  if (platform !== "win32" && existsSync(unixWrapper)) {
    return {
      command: "sh",
      args: [unixWrapper, "compileJava", "--no-daemon"],
    };
  }
  if (
    existsSync(path.join(workDir, "build.gradle")) ||
    existsSync(path.join(workDir, "build.gradle.kts"))
  ) {
    return {
      command: "gradle",
      args: ["compileJava", "--no-daemon"],
    };
  }

  throw new Error(
    "No supported Java build manifest found; expected pom.xml, build.gradle, or build.gradle.kts",
  );
}

export function main(workDir = process.cwd()) {
  let build;
  try {
    build = selectJavaBuild(workDir);
  } catch (error) {
    console.error(error.message);
    return 1;
  }

  const result = spawnSync(build.command, build.args, {
    cwd: workDir,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(result.error.message);
    return 1;
  }
  if (result.signal) {
    console.error(`Java build terminated by signal ${result.signal}`);
    return 1;
  }
  return result.status ?? 1;
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  process.exitCode = main();
}
