# Work Routing

How to decide who handles what.

## Routing Table

| Work Type | Route To | Examples |
|-----------|----------|----------|
| Python evaluations | Fry | Python golden apps, scripts, SDK usage, pytest flows |
| .NET evaluations | Leela | .NET golden apps, SDK calls, xUnit flows |
| Java evaluations | Amy | Java golden apps, SDK calls, JUnit flows |
| TypeScript evaluations | Bender | TypeScript golden apps, Node scripts, Playwright or test harnesses |
| Quality and testing | Zoidberg | Deterministic graders, edge cases, regressions, coverage checks |
| Scope & priorities | Farnsworth | Architecture, trade-offs, sequencing, and cross-language decisions |
| Session logging | Scribe | Automatic — never needs routing |
| Work queue monitoring | Ralph | Stalled work, backlog nudges, heartbeat checks |

## Issue Routing

| Label | Action | Who |
|-------|--------|-----|
| `squad` | Triage: analyze issue, assign `squad:{member}` label | Farnsworth |
| `squad:{name}` | Pick up issue and complete the work | Named member |

### How Issue Assignment Works

1. When a GitHub issue gets the `squad` label, the Lead triages it — analyzing content, assigning the right `squad:{member}` label, and commenting with triage notes.
2. When a `squad:{member}` label is applied, that member picks up the issue in their next session.
3. Members can reassign by removing their label and adding another member's label.
4. The `squad` label is the inbox for untriaged issues waiting for Lead review.

## Rules

1. Eager by default — spawn all agents who could usefully start work, including anticipatory downstream work.
2. Scribe always runs after substantial work, always as `mode: "background"`. Never blocks.
3. Quick facts go to the coordinator directly.
4. When two agents could handle it, pick the one whose domain is the primary concern.
5. Team-wide requests fan out to all relevant agents in parallel.
6. Anticipate downstream work.
7. Issue-labeled work routes to the named member.
