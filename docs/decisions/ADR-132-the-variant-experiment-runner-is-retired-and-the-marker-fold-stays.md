---
simt-affects: ["packages/bench/src/commands.mjs", "src/commands/spec.mjs", "src/commands/index.mjs", "src/commands/bench.mjs", "src/commands/help.mjs", "test/variants.test.mjs"]
simt-supersedes: []
---
# ADR-132 — The variant experiment runner is retired, and the marker fold stays

Status: accepted · 2026-11-02

## Context

R35 shipped two halves. The fold (`src/kernel/variants.mjs`) lets a rule line carry a
`<!-- simt-variants: … -->` marker, renders the baseline while unlocked, and renders a locked
winner from `simt.lock.json`. The runner (`packages/bench/src/variants.mjs`, plus
`simt bench variants`) mined tasks, ran a canary suite across the variant arms and locked the
winner with its evidence.

The review measured what the runner produced: `grep simt-variants rules/` finds no marker in
this repository's rule corpus. The runner's cost is a shipped command, a help entry, a
dispatch entry and 525 lines in the optional bench package; its benefit so far is tests.

## Rulings

1. **The marker fold stays.** A consumer profile may carry a marker, and the fold is what makes
   a marker safe to project: it strips it when unlocked and renders the locked winner when
   `simt.lock.json` names one. Nothing about that depends on this repository using it.

2. **The experiment runner is retired.** `simt bench variants`, its dispatcher entry, its spec
   row, its help page entry and `packages/bench/src/variants.mjs` are removed. `simt.lock.json`
   continues to be read: a `variants` map written by an earlier run still selects the winner it
   recorded, because the fold reads the lock and not the runner.

## Consequences

- The `bench` surface loses one command, and the optional bench package loses 525 lines that
  nothing in this estate exercised for its output.
- `test/variants.test.mjs` keeps the fold's tests — parsing, defect reporting, projection with a
  locked winner, the legacy lock name — and loses the runner's. The lock-reading test is the
  one that proves retired evidence still applies.
- Reintroducing selection is a new record, not a revert: it needs a corpus that carries a
  marker, which is the evidence this retirement says never arrived.

## Rejected

- **Leaving the command and its code in place, unused.** Rejected: a shipped command with no
  consumer is the defect the review named, and dead code in the optional package still costs
  every reader who greps for what produces a lock entry.
- **Removing the lock's `variants` field too.** Rejected: locks written by earlier runs exist,
  and a fold that stopped honouring them would silently change what a repository projects on
  upgrade. Retirement stops new evidence; it does not invalidate old evidence.
