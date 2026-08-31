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

## Pilot

Start with a small set of analyzer-heavy scenarios, including the Python Blob
Event Notifier. Re-grade saved trajectories where possible so grader
experiments do not require new agent runs. Use the pilot to decide which
criteria remain deterministic, move to prompted judgment, or retain both
forms.

This document records a proposal, not a decision to migrate all graders.
