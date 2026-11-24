---
simt-affects: ["test/tier.mjs", "scripts/run-tests.mjs", "package.json", "test/ci.test.mjs", "test/tiers.test.mjs"]
---

# ADR-259 — the pre-push gate runs every test except benches and studio

Status: accepted · 2026-11-24

## Context

The pre-push gate runs `npm test`, which was the full suite: 1,800-plus tests that take
minutes, including benches that measure the tool and studio tests whose wall-clock
ceilings are sized to a quiet machine (ADR-254, ADR-255). The gate has failed on
contention, not on code: a push blocked on `studio-server`'s 1100 ms ceiling while
another suite ran on the same machine, and every gate run pays minutes of bench time
that no change asked for. Neither family is evidence a change needs - benches measure,
and studio's bars assume the machine is idle - and both are what made the gate slow
and flaky. The rulings below settle what the gate runs, where that knowledge lives,
and which door the full suite keeps.

## Rulings

1. **The gate runs a view, and the view is the complement of a classification.**
   `test/tier.mjs` classifies a file out of the gate by name prefix - benches
   (`bench*`, `pack-bench`) and studio (`studio-*`) - and `scripts/run-tests.mjs`
   runs the view as its `gate` argument. The exclusion is a prefix classification,
   not a file list: a new bench or studio file joins the view's complement without a
   second copy of the test set to update (ADR-137), and a view that runs less than its
   complement is a partition defect `test/tiers.test.mjs` names by name.
2. **The gate keeps its name `test`; the lever is what its script runs.** The
   dispatcher special-cases `name === 'test'` for skip logic and ledger-kind mapping
   (`src/hooks/dispatcher.mjs`), so the gate is not renamed; `package.json` redefines
   `"test"` to `node scripts/run-tests.mjs gate`, and the centrally pinned
   `script: 'test'` in `src/hooks/gates.mjs` picks up the change with no manifest
   edit. The gate view runs at four-way concurrency, because the unit files inside it
   carry wall-clock bars calibrated under a four-way load.
3. **The full suite keeps its door as `test:all`.** `package.json` adds
   `"test:all"` with the full glob `test` used to carry, for named triggers - phase
   exit, release gates, explicit instruction (ADR-003). The file-naming invariant - no
   directory spelling, every `.test.mjs` covered - moves to `test:all` in
   `test/ci.test.mjs`, because a glob is where a narrowing can drop a test silently.
4. **No test file is deleted.** The exclusion changes which files the gate runs, not
   which files exist: benches and studio tests remain in `test/`, remain covered by
   `test:all`, and remain runnable on their own.
