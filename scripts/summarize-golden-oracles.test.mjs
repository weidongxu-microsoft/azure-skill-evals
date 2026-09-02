import assert from "node:assert/strict";
import test from "node:test";

import { summarize } from "./summarize-golden-oracles.mjs";

function category(passed, total, failures = []) {
  return { failures, passed, total };
}

test("summarizes all oracle failures without treating them as integrity errors", () => {
  const result = summarize(
    [
      {
        error: null,
        language: "python",
        languageChecks: category(4, 5, [
          { evidence: "client not closed", name: "language/client-lifecycle" },
        ]),
        program: category(1, 1),
        prompt: category(9, 10, [
          { evidence: "not recognized", name: "prompt/run" },
        ]),
        scenario: "example-python",
        status: "failed",
      },
      {
        error: null,
        language: "dotnet",
        languageChecks: category(3, 3),
        program: category(1, 1),
        prompt: category(8, 8),
        scenario: "example-dotnet",
        status: "passed",
      },
    ],
    2,
  );

  assert.deepEqual(result.integrity, []);
  assert.match(result.markdown, /python \| 1 \| 9\/10 \(90\.0%\)/);
  assert.match(result.markdown, /example-python \| prompt \| prompt\/run/);
  assert.match(
    result.markdown,
    /example-python \| language \| language\/client-lifecycle/,
  );
  assert.match(result.markdown, /All expected oracle results were collected/);
});

test("rejects structurally malformed result rows", () => {
  const result = summarize(
    [
      {
        language: "",
        languageChecks: category(2, 1),
        program: null,
        prompt: category(0, 0),
        scenario: null,
        status: "bogus",
      },
    ],
    1,
  );

  assert.ok(result.integrity.length >= 5);
  assert.match(result.markdown, /invalid scenario/);
  assert.match(result.markdown, /invalid language/);
  assert.match(result.markdown, /invalid status/);
});

test("reports missing and duplicate scenario results as integrity errors", () => {
  const row = {
    error: "judge unavailable",
    language: "python",
    languageChecks: category(0, 0),
    program: category(0, 0),
    prompt: category(0, 0),
    scenario: "duplicate",
    status: "error",
  };

  const result = summarize([row, row], 3);

  assert.equal(result.integrity.length, 2);
  assert.match(result.markdown, /Duplicate scenario result/);
  assert.match(result.markdown, /Expected 3 scenario results, received 2/);
});
