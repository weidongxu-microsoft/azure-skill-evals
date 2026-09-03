import { readFile } from "node:fs/promises";
import type { EvaluationCase } from "./types.js";

export async function loadEvaluationCases(
  path: string,
): Promise<EvaluationCase[]> {
  const content = await readFile(path, "utf8");
  const cases = content
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line, index) => parseCase(line, index + 1, path));
  if (cases.length === 0) {
    throw new Error(`Evaluation dataset is empty: ${path}`);
  }
  return cases;
}

function parseCase(line: string, lineNumber: number, path: string): EvaluationCase {
  const value: unknown = JSON.parse(line);
  if (
    typeof value !== "object" ||
    value === null ||
    !hasString(value, "id") ||
    !hasString(value, "query") ||
    !hasString(value, "groundTruth")
  ) {
    throw new Error(
      `Invalid evaluation case at ${path}:${String(lineNumber)}.`,
    );
  }
  return {
    id: readString(value, "id"),
    query: readString(value, "query"),
    groundTruth: readString(value, "groundTruth"),
  };
}

function hasString(
  value: object,
  property: string,
): value is Record<string, string> {
  return property in value && typeof Reflect.get(value, property) === "string";
}

function readString(value: object, property: string): string {
  const result = Reflect.get(value, property);
  if (typeof result !== "string") {
    throw new Error(`Expected ${property} to be a string.`);
  }
  return result;
}
