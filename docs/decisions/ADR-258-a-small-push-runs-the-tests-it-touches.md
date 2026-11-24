---
simt-affects: ["src/hooks/dispatcher.mjs", "src/manifest/schema.mjs", "src/ledger/index.mjs", "simt.json"]
simt-supersedes: []
---

# ADR-258 — a small push runs the tests it touches, and a fix push re-runs the failures

Status: accepted · 2026-11-24

## Context

A one-commit push pays the full test suite for the smallest possible change. The
selection this record asks for already exists: `simt gate` runs the tests a change
imports (ADR-094), and the dispatcher already evaluates two pre-push skips — a push
carrying no code skips the test gate and says so (ADR-147), and a push whose tree a
full-suite run already passed skips on that evidence (ADR-120). What is missing is a
third answer between "run everything" and "skip": when the push is small, run the
tests the pushed files touch, and record what ran so the push is never silent.

The same gap has a second face. A full suite fails, exactly one commit lands on top
of it, and that commit touches only test files: the next push re-runs everything,
although every passing test of the tree one commit back is still proven — a commit
that touches only test files cannot invalidate them, because each test file is an
independent unit of the runner. Re-running only the recorded failures is the narrow
answer, and it needs one fact the ledger does not keep today: *which* tests failed.

This record settles both, and the evidence rulings that make them honest. It stands
on ADR-087 (a run is evidence for one tree), ADR-094 (a change runs the tests that
import it), ADR-120 (the already-passed skip), ADR-147 (the non-code skip) and
ADR-002 (a second real use extracts).

## Rulings

1. **The threshold is validated in `src/manifest/schema.mjs` like its sibling
   key, and defaults to one.** `gates.prePushFocusedCommits` in the repository
   manifest is a positive integer, nothing else: the commit count at or below
   which pre-push runs focused impacted tests for every file in the unpushed
   commits; from one commit above, the current behaviour applies. Absent means 1,
   so a single-commit push is focused by default in every repository that adopts
   it; this repository self-adopts the key.

2. **Every miss is a full suite with its reason, decided in
   `src/hooks/dispatcher.mjs`.** A new-branch push (the remote sha is zero) has no
   base to count against; a manual run with no upstream cannot be counted at all;
   an empty focused selection means "no tests found", not "nothing to prove"; a
   declared `test` gate of a command kind that cannot take file arguments cannot be
   narrowed; a multi-ref push sums commit count and file set across the branch
   refs, mirroring `classifyPush` in `src/hooks/push-skip.mjs`; and a re-run lever
   that misses falls through to the threshold path, which is the old behaviour.
   None of these is a skip and none is silent: each reports as the `test` gate with
   a reason line naming what ran and why.

3. **Precedence is fixed.** The ADR-147 non-code skip, then the ADR-120
   already-passed skip (a full-suite pass on this tree needs no run of any size),
   then the re-run lever, then the focused threshold, then the full suite. The
   dispatcher evaluates them in that order in `src/hooks/dispatcher.mjs`.

4. **A focused pass is not full-suite evidence.** A focused run records
   `kind: 'test-focused'`, and the ledger's `isTestKind` requires `kind === 'test'`:
   a focused pass never earns the ADR-120 skip on a later push. The re-run lever's
   result records the same kind, for the same reason — it proved a subset, and a
   push that changes one more file is owed the rest.

5. **The re-run lever is narrow on purpose, and its premise is recorded.** It fires
   only when the ledger holds a failed `test` run with recorded failure identities,
   exactly one commit below the pushed HEAD, whose single intervening commit touches
   only test files. The ledger stores the *identities* of failed tests — parsed from
   the runner output — not their logs: the line already keeps `errorLine` and a
   `signature`, and a list of ids is the same digest principle extended to the one
   fact the next push must act on. An unparseable failure records no ids, so the
   lever cannot fire on a run it has no failures for. The soundness premise is
   ruling 5's own: a test-only commit cannot invalidate the passing tests of the
   tree one commit back.

6. **The selection-plus-execution path is one core with two callers.** The path the
   gate command uses today — read the import graph, select the tests, detect the
   runner, execute through the bounded spawn — becomes one module in `src/testing/`,
   and both the gate command and the dispatcher call it. That is the second real use
   the extraction exists for (ADR-002); nothing re-implements selection or runner
   detection.
