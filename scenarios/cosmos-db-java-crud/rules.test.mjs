import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  evaluateJavaCheck,
  javaCheckNames,
  loadJavaWorkspace,
} from "../../languages/java/checks.mjs";
import {
  evaluateRule,
  ruleNames,
} from "./tools/cosmos-java-rules.mjs";

const goldenWorkspacePath = fileURLToPath(new URL("./golden", import.meta.url));
const completeWorkspace = loadJavaWorkspace(goldenWorkspacePath);
const baseline33441637671 = loadJavaWorkspace(
  fileURLToPath(
    new URL("./fixtures/baseline-33441637671", import.meta.url),
  ),
);

test("Java reference application passes every prompt rule", () => {
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, completeWorkspace), true, rule);
  }
});

test("Java reference application passes every language check", () => {
  for (const check of javaCheckNames()) {
    assert.equal(evaluateJavaCheck(check, completeWorkspace), true, check);
  }
});

test("baseline run 33441637671 exact output passes every grader", () => {
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, baseline33441637671), true, rule);
  }
  for (const check of javaCheckNames()) {
    assert.equal(
      evaluateJavaCheck(check, baseline33441637671),
      true,
      check,
    );
  }
});

test("literal SQL without a parameter fails the query rule", () => {
  const workspace = {
    ...completeWorkspace,
    source: completeWorkspace.source.replace(
      'List.of(new SqlParameter("@category", "electronics"))',
      "List.of()",
    ),
  };

  assert.equal(evaluateRule("prompt/parameterized-query", workspace), false);
  assert.equal(evaluateRule("prompt/query-iteration", workspace), true);
});

test("replacing an unchanged item fails the CRUD rule", () => {
  const workspace = {
    ...completeWorkspace,
    source: completeWorkspace.source.replace("item.setQuantity(2);", ""),
  };

  assert.equal(evaluateRule("prompt/item-crud", workspace), false);
});

test("unused query parameter fails the parameterized-query rule", () => {
  const workspace = {
    ...completeWorkspace,
    source: completeWorkspace.source.replace(
      "SELECT * FROM c WHERE c.category = @category",
      "SELECT * FROM c",
    ),
  };

  assert.equal(evaluateRule("prompt/parameterized-query", workspace), false);
});

test("database and container constants must be connected to creation and use", () => {
  const cases = [
    ["database", baseline33441637671.source.replace('"TestDB"', '"OtherDB"')],
    ["container", baseline33441637671.source.replace('"Items"', '"OtherItems"')],
    ["partition key", baseline33441637671.source.replace('"/category"', '"/tenant"')],
    [
      "unused properties",
      baseline33441637671.source.replace(
        /createContainerIfNotExists\(\s*properties,/,
        'createContainerIfNotExists(\n                new CosmosContainerProperties("OtherItems", "/category"),',
      ),
    ],
  ];
  for (const [label, source] of cases) {
    assert.equal(
      evaluateRule(
        "prompt/database-container",
        { ...baseline33441637671, source },
      ),
      false,
      label,
    );
  }
});

test("query results may use direct and bound iteration forms", () => {
  const directForEach = baseline33441637671.source.replace(
    /for \(Item item : container\.queryItems\([\s\S]*?item\.getId\(\)\);\s*\}/,
    "container.queryItems(query, new CosmosQueryRequestOptions(), Item.class)" +
      ".forEach(item -> System.out.println(item.getId()));",
  );
  assert.equal(
    evaluateRule(
      "prompt/query-iteration",
      { ...baseline33441637671, source: directForEach },
    ),
    true,
  );
  assert.equal(
    evaluateRule(
      "prompt/parameterized-query",
      { ...baseline33441637671, source: directForEach },
    ),
    true,
  );

  const unused = baseline33441637671.source.replace(
    /for \(Item item : container\.queryItems\([\s\S]*?\n        \}/,
    "container.queryItems(query, new CosmosQueryRequestOptions(), Item.class);",
  );
  assert.equal(
    evaluateRule("prompt/query-iteration", { ...baseline33441637671, source: unused }),
    false,
  );
  assert.equal(
    evaluateRule("prompt/parameterized-query", { ...baseline33441637671, source: unused }),
    false,
  );
});

test("query alias, parameter identity, and caller literal remain correlated", () => {
  for (const source of [
    baseline33441637671.source.replace(
      "WHERE c.category = @category",
      "WHERE x.category = @category",
    ),
    baseline33441637671.source.replace(
      'new SqlParameter("@category", category)',
      'new SqlParameter("@other", category)',
    ),
    baseline33441637671.source.replace(
      'queryItems(container, "electronics")',
      'queryItems(container, "books")',
    ),
    baseline33441637671.source.replace(
      'new SqlParameter("@category", category)',
      'new SqlParameter("@category", "books")',
    ),
  ]) {
    assert.equal(
      evaluateRule(
        "prompt/parameterized-query",
        { ...baseline33441637671, source },
      ),
      false,
    );
  }
});

test("comments, local fakes, and unreachable query helpers do not count", () => {
  const minimal = `import com.azure.cosmos.CosmosClientBuilder;
public class App { public static void main(String[] args) {} }`;
  const decoys = [
    `${minimal}\n/* ${baseline33441637671.source} */`,
    `${baseline33441637671.source}\nclass SqlQuerySpec {}`,
    `${minimal}
private static void unused(CosmosContainer container) {
  SqlQuerySpec query = new SqlQuerySpec(
      "SELECT * FROM c WHERE c.category = @category",
      List.of(new SqlParameter("@category", "electronics")));
  for (Item item : container.queryItems(
      query, new CosmosQueryRequestOptions(), Item.class)) {}
}`,
  ];
  for (const source of decoys) {
    assert.equal(
      evaluateRule(
        "prompt/parameterized-query",
        { ...baseline33441637671, source },
      ),
      false,
    );
  }
});
