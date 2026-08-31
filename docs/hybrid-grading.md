# Hybrid grading proposal

## Motivation

Deterministic graders are reproducible, but they recognize only implementation
forms anticipated by their authors. Golden, negative, and alternate-form
fixtures reduce this risk without proving that a rule accepts every valid
implementation. Discovery of a false negative is itself probabilistic: an
agent must generate an unanticipated valid form, and someone must investigate
the resulting failure.

Prompt graders can interpret unfamiliar but semantically valid code, but their
results are probabilistic, costly, and capable of false positives and false
negatives. They should complement deterministic evidence rather than replace
it wholesale.

Both grader types inspect approximately the same final application:

- A deterministic `run-command` grader reads workspace files directly.
- A prompt grader with `evidence: [repo]` receives a bounded snapshot of the
  final workspace, including source and dependency manifests.

The useful difference is how they interpret that evidence.

## Proposed split

Keep deterministic checks for objective facts:

- syntax, builds, and linting
- required packages and pinned versions
- forbidden secrets, keys, or connection strings
- required SDK types, methods, and authentication forms
- file existence and directly testable behavior

Use prompted judgment for semantic properties that require understanding the
whole implementation:

- whether components form a coherent end-to-end workflow
- whether error handling protects the relevant operations and is useful
- whether sync and async implementations are functionally equivalent
- whether an unfamiliar design still satisfies the requested architecture

Do not use prompted judgment for facts that a command or parser can establish.
For example, run the compiler instead of asking a judge whether code compiles.
Do not grade MCP calls, tool calls, or skill activation.

## Shadow evaluation

Introduce prompted grading without initially changing the primary score:

1. Add one prompt grader per pilot scenario with explicit rubric items and
   `evidence: [repo]`.
2. Run it alongside the existing deterministic graders.
3. Record criterion-level disagreements.
4. Human-review disagreement samples.
5. Add confirmed valid implementations as deterministic regression fixtures.
6. Track disagreement rates and simplify or replace brittle deterministic
   rules when warranted.

Interpret disagreement as a review signal, not proof:

| Deterministic | Prompted | Review focus |
|---|---|---|
| pass | pass | likely supported implementation |
| fail | pass | possible deterministic false negative |
| pass | fail | possible deterministic false positive or judge error |
| fail | fail | likely missing behavior, still subject to review |

Use a judge model different from the generator, or a small panel, during
calibration. Keep deterministic and prompted scores separate until their
agreement and stability are understood. Use repeated trials before comparing
environment variants.

## Prompt fallback

Vally runs graders declared in `eval.yaml` independently; it does not natively
express "run this prompt grader only when that deterministic grader fails."
Fallback scoring would require either a custom composite grader plugin or a
second offline grading pass.

A composite grader could:

1. Run the deterministic checks once.
2. Return a pass immediately for each deterministic success.
3. Send only deterministic failures to one prompted review.
4. Use the prompted verdict as the final result for those criteria.
5. Mark every prompt-resolved pass for later human review.
6. Report deterministic errors and timeouts separately instead of silently
   treating them as ordinary failures.

This reduces false negatives and avoids repeating an expensive analyzer or
making one LLM call per criterion. It does not detect deterministic false
positives because a deterministic pass skips prompted review. Therefore,
fallback should follow a calibration period in which both graders run and
their disagreements are measured.

Suggested result states:

| Deterministic | Prompt fallback | Final result | Review |
|---|---|---|---|
| pass | not run | pass | none |
| fail | pass | pass | human review |
| fail | fail | fail | sample as needed |
| error or timeout | pass or fail | report separately | infrastructure review |

An initial prototype can use `vally grade` to prompt-grade failed saved
trajectories and workspaces without rerunning the agent. Integrate fallback
into the primary score only after the behavior and reporting are validated.

## Pilot

Start with a small set of analyzer-heavy scenarios, including the Python Blob
Event Notifier. Re-grade saved trajectories where possible so grader
experiments do not require new agent runs. Use the pilot to decide which
criteria remain deterministic, move to prompted judgment, or retain both
forms.

This document records a proposal, not a decision to migrate all graders.
