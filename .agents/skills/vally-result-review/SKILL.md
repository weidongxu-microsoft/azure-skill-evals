---
name: vally-result-review
description: Review a completed Vally run, compare environment variants, and identify material grader errors.
---

# Vally Result Review

Use this skill when analyzing a completed Vally evaluation or comparing its
environment variants.

## Workflow

1. Collect the combined summary, shard results, trajectories, generated diffs,
   and program-check output. Reconstruct workspaces only when needed and record
   any limitations.
2. Summarize each variant's architecture and reported prompt, language, and
   program results. Do not treat installation or type checking as test success.
3. Validate failed criteria and suspicious perfect scores against executable
   code paths. Report only high-confidence false positives, false negatives,
   ambiguous criteria, and obvious runtime incompatibilities.
4. Compare trajectory evidence:
   - skills activated and guidance actually read;
   - MCP servers exposed versus tools invoked;
   - exact web URLs, hosts, successes, failures, and mutable references;
   - local package or SDK declaration inspection;
   - tool-call counts, retries, and duration.
5. Separate observed differences from unsupported causal claims. Recommend
   focused stimulus or criterion changes when the evidence supports them.

## Rules

- Grade application behavior, not skill activation, MCP calls, or tool choice.
- Workflow success does not prove application correctness.
- Treat generated code, executed tests, and service payloads as stronger
  evidence than comments, interfaces, mocks, or unused helpers.
- Do not perform an exhaustive criterion, defect, or security audit unless the
  user explicitly requests one.
- Keep downloaded and reconstructed artifacts outside the repository.
- If the run is still active, monitor it non-blockingly before reviewing it.

## Output

Provide:

- a per-variant architecture and score table;
- material grader discrepancies and runtime concerns;
- skill, MCP, web, and tool-use comparisons;
- concise evaluation improvement recommendations;
- artifact locations and reconstruction caveats when applicable.
