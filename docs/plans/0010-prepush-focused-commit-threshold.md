# Plan 0010 — pre-push runs the focused tests of a small push

Status: **queued** · 2026-11-23

## Scope

A one-commit push paying the full test suite is the slowest answer to the
smallest change. This plan gives the pre-push gate a third answer between
"run everything" and "skip": when the push is small, run the tests the pushed
files touch — the same selection `simt gate` already makes (ADR-094) — and
record what ran so the push is never silent.

1. **A config number, default 1.** `gates.prePushFocusedCommits` in the
   repository manifest is the commit count at or below which pre-push runs
   focused impacted tests for every file in the unpushed commits; from one
   commit above, the current behaviour applies (full suite unless already run
   and passed). The key is validated like `gates.prePushSkipTest`
   (`src/manifest/schema.mjs`): a positive integer, nothing else.
2. **A focused push module.** `src/hooks/focused-push.mjs` answers, for a
   ref list, how many commits the push carries and which files they change —
   the shape `classifyPush` in `push-skip.mjs` already produces, extended to
   the file set. A manual run (no ref list) counts against `@{u}`; no upstream
   is a full suite.
3. **One focused-run core.** The selection-plus-execution path
   `gateCommand`/`runSelected` uses today (`readGateGraph` → `selectTests`,
   `detectTestRunner` → `buildExec`) is the second real use the dispatcher
   makes of it, so it extracts to `src/testing/focused-run.mjs` (ADR-002) and
   both callers use it. Nothing re-implements selection or runner detection.
4. **Ledger honesty.** A focused run records `kind: 'test-focused'`. `isTestKind`
   in `src/ledger/index.mjs` already requires `kind === 'test'`, so a focused
   pass is *not* full-suite evidence: it never earns the ADR-120 skip on a
   later push. No ledger code changes — a test proves the exclusion holds.
5. **Re-run the last failures.** The full suite failed, and exactly one commit
   sits on top of that run: the next push re-runs only the tests that failed,
   not everything. Everything else already passed one commit back, and a commit
   that touches only test files cannot invalidate that — each test file is an
   independent unit of the runner. The ledger stores the *identities* of the
   failed tests (parsed by the existing `src/testing/parsers.mjs`), not their
   logs: the line already keeps `errorLine` and `signature` on a failure, and a
   list of test ids is the same spirit as the digest principle — identities,
   not output.

Fail-closed rules, each one a full suite rather than a skip:

| Situation | Disposition |
| --- | --- |
| New-branch push (remote sha is zero) | full suite — no base to count or diff against |
| Manual run with no upstream (`@{u}` unresolvable) | full suite |
| Focused selection is empty (no test imports the pushed files) | full suite — "no tests found" is not "nothing to prove" |
| The declared `test` gate is a command-kind that cannot take file arguments | full suite |
| Multi-ref push | commit count and file set sum across branch refs, mirroring `classifyPush` |
| Re-run lever: no failed full run with a recorded failure list one commit back, or the single commit touches a non-test file, or the distance is not exactly one commit | fall through to the threshold path — the lever is narrow on purpose, and its miss is the old behaviour |

Precedence: the ADR-147 non-code skip, then the ADR-120 already-passed skip
(a full-suite pass on this tree needs no run of any size), then the re-run
lever (a failed full run exactly one test-only commit back: re-run its recorded
failures), then the focused threshold, then the full suite. Every one of these
reports as the `test` gate with a reason line naming what ran and why — never
silent, never a skip.

## Tracker

| id | state | slice | evidence |
| --- | --- | --- | --- |
| PT01 | Complete | ADR-258 record in `docs/decisions/` | 4ba1909428c8c4f6105c03509ec7e07f8e395b12 |
| PT02 | Complete | `src/hooks/focused-push.mjs` + extract `src/testing/focused-run.mjs` + test | db648e0142051f371ca8e86c4a614306ada33943 |
| PT03 | Complete | dispatcher wiring + manifest validation + self-adoption + test | f3db4b35ccbabd46a4332b114c7c089e2a999f6c |
| PT04 | Complete | ledger evidence test for `test-focused` | 419186aa8f5369b6705ef2ad3a026c58ea9ee353 |
| PT05 | Complete | ledger records failed-test identities on a failed `test` run + test | a4799d6962bf2d46c477a676895c1e83f1e85115 |
| PT06 | Complete | dispatcher re-run-failures lever + test | 69acfc1a6415ba8b3d4de27191e663d6374d5dc4 |

## PT01 — ADR-258

The record settles: the key's shape and default (1 when absent, so a
single-commit push is focused by default in every repo that adopts it); the
fail-closed table above, each row a ruling with its reason; precedence —
ADR-147, then ADR-120, then the re-run lever, then the threshold; and two
evidence rulings — a focused pass records `kind: 'test-focused'` and is not
full-suite evidence, so it never earns the ADR-120 skip, and the re-run lever
is sound only because a test-only commit cannot invalidate the passing tests of
the tree one commit back (each test file is an independent runner unit). It
names the records it stands on: ADR-087 (a run is evidence for one tree),
ADR-094 (a change runs the tests that import it), ADR-120 (the already-passed
skip), ADR-147 (the non-code skip).

Acceptance: the ADR carries a `Status:` line and supersedes nothing it does not
name; `simt check` clean.

## PT02 — focused-push module + focused-run extraction

`src/hooks/focused-push.mjs` takes the ref list (or a manual-run flag) and
returns `{ commits, files, fullSuite: <reason|null> }`: `commits` summed across
branch refs the way `classifyPush` does, `files` the union of the per-commit
diffs, and `fullSuite` the reason a full suite is required when the threshold
cannot apply (new branch, no upstream, …). It runs git; it does not run gates.

`src/testing/focused-run.mjs` is the extracted core: given a file set, it
selects (`readGateGraph` → `coverage`/`selectTests` from `src/index/gate.mjs`)
and executes (`detectTestRunner` → `buildExec` from `src/testing/runners.mjs`)
through the bounded spawn the gate command already uses, returning a report
shape `gateCommand` consumes unchanged. `gateCommand`/`runSelected` in
`src/commands/gate.mjs` become a thin caller of it — the second real use that
justifies the extraction (ADR-002), not a rewrite.

Acceptance: `node --test test/hooks-focused-push.test.mjs` green — a 1-commit
push returns one commit and its files; a 2-ref push sums both; a new-branch
push and a no-upstream manual run both return the full-suite reason; an empty
selection returns one. And `node --test test/gate.test.mjs` green unchanged —
the extraction moved code, not behaviour.

## PT03 — dispatcher wiring, manifest validation, self-adoption

`src/manifest/schema.mjs` gains the `gates.prePushFocusedCommits` check
(positive integer) beside `gates.prePushSkipTest`. `runPushTarget` in
`src/hooks/dispatcher.mjs` asks `focused-push` after the existing skips have
been evaluated: when the threshold applies and the `test` gate can take file
arguments, it runs the focused core with the pushed files and records the run
as `kind: 'test-focused'` with a reason line; otherwise it runs the full
suite exactly as today. `simt.json` self-adopts the key, so this repository's
own single-commit pushes get the faster gate.

Acceptance: `node --test test/hooks-focused-dispatch.test.mjs` green — a
1-commit push of code files runs the focused selection and records
`test-focused`; a 2-commit push runs the full suite; an empty selection falls
back to the full suite; a declared command-kind `test` gate cannot take file
arguments and falls back; an ADR-120 pass on the tree skips both. And
`node --test test/hooks-push.test.mjs` green unchanged — the existing skip
classification is untouched.

## PT04 — ledger evidence test

`test/ledger-focused-evidence.test.mjs` proves the evidence ruling on this
tree: a ledger line recorded with `kind: 'test-focused'` that passes does not
satisfy `hasTestEvidence`, and a `kind: 'test'` pass on the same tree still
does. It is the regression guard for "a focused pass never earns a full-suite
skip" — no code change is expected, only the assertion.

Acceptance: `node --test test/ledger-focused-evidence.test.mjs` green.

## PT05 — ledger records the failed-test identities

A full-suite run that fails today stores `outputDigest`, `errorLine` and a
`signature`, but not *which* tests failed — the output is digested, not kept.
The re-run lever needs the identities. `recordRun` in `src/ledger/index.mjs`
gains an optional `failedTests: string[]`, populated only when a `test` gate
fails and `src/testing/parsers.mjs` can parse the runner output into a
`failures` list. The line stores ids, not logs — the same digest principle that
keeps `outputDigest` a hash, extended to the one fact the next push must act
on. An unparseable failure (a crash before tests ran) records no ids, so the
lever cannot fire on a run it has no failures for.

Acceptance: `node --test test/ledger-failures.test.mjs` green — a failed
`test` run with parseable output records the failed ids; a passing run records
none; an unparseable failure records none; and `node --test test/ledger.test.mjs`
stays green — the ledger's existing shape and evidence queries are untouched.

## PT06 — dispatcher re-run-failures lever

`runPushTarget` in `src/hooks/dispatcher.mjs`, after the ADR-147 and ADR-120
skips have been evaluated, asks the re-run question: is there a failed `test`
run in the ledger with recorded `failedTests`, exactly one commit below the
pushed HEAD, whose single intervening commit touches only test files
(`isTestPath` from `src/testing/paths.mjs`)? When yes, it runs exactly those
ids through PT02's focused-run core and records the result as `kind:
'test-focused'` with a reason line naming the re-run. Every miss — no such run,
distance not one, a non-test file in the commit, an empty id list — falls
through to the threshold path, which is the old behaviour. The lever is a
subset of what the focused threshold would run, so it never widens the gate;
it only narrows a known-failure re-check to the failures.

Acceptance: `node --test test/hooks-rerun-failures.test.mjs` green — a failed
full run one test-only commit back re-runs only the recorded ids; the same run
with a source file in the intervening commit falls through to the threshold;
a two-commit distance falls through; a crash failure with no recorded ids
falls through to the full suite. And `node --test test/hooks-focused-dispatch.test.mjs`
stays green — the threshold path is unchanged by the lever above it.
