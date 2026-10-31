---
simt-affects: ["src/hooks/dispatcher.mjs", "rules/core.md", "rules/mdc/slice-commit.mdc", "test/hooks.test.mjs"]
simt-supersedes: []
---

# ADR-120 — a pre-push whose tree is already proven green skips the test gate on that evidence

Status: **accepted** · 2026-10-31

## Context

The shared dispatcher runs a repository's declared pre-push gates on every push. For
this repository that is the full test suite — minutes of wall clock — and the common
shape of push pays it twice: the author ran the suite green on the very tree being
pushed, committed nothing further, and the gate runs it again at push time.

ADR-113 already ruled that a push carrying only documentation skips the test gate and
says so. It is the right shape of the answer and the template for this one: a skip
earned by a property of the push, reported with a reason, and the record that earned it
named in the report. This record extends it with a second property: a push whose
committed tree is one the suite has already passed.

The dispatcher records every gate run against the tree it ran on (ADR-087). A passing
run is evidence about one tree and no other; editing any file afterwards produces a
different tree, and the old line no longer proves anything about what is on disk. The
evidence the ledger already keeps is exactly the evidence this skip needs, and no
other state is required.

## Ruling

### 1. The skip is unconditional, evidence-driven, and fail-closed

A pre-push `test` gate is skipped when — and only when — the ledger records a passing
`test` run whose tree equals the committed tree being pushed (`HEAD^{tree}`). There is
no manifest key to declare: the condition is a fact about the evidence, not a policy
choice. Every uncertainty fails closed to the suite — an unborn HEAD, an unreadable
ledger, no entry for this tree, or a later failure on the same tree. A gate that cannot
prove it need not run does not run; a gate that cannot prove it is a failure, not a
skip.

"No changes since" is enforced by the digest, not by trusting the author: a clean
working tree's recorded `worktreeTree` equals `HEAD^{tree}`, and any later edit changes
the tree id, so the match fails and the suite runs.

### 2. The skip is reported, and names the record that earned it

The report prints the skip with its reason and the ADR that earned it — the same shape
ADR-113 fixed for the docs-only path. The `test` gate line reads
`SKIPPED test … [ADR-120]`, so a skip is never silent and the two skip paths are
distinguishable in the same report.

### 3. The docs-only skip keeps its own record

The two skips are independent and compose: the docs-only classification is consulted
first (it is cheaper — no ledger read), and where it does not fire, the evidence check
decides. A push that earns both is reported under whichever fired first; both earn the
same outcome, and the report names the one that did the work.

### 4. The rule tells the agent to cite the pass, not re-run it

`rules/core.md`'s Git section and the `slice-commit` rule both state the agent-side
half: once a push is approved and the suite ran green on the current state with nothing
changed since, the agent pushes directly and cites the already-passing run as the pass.
The gate recognising the evidence is what makes that citation verifiable — the agent
claims a run the ledger records, and a claim the ledger does not record is a claim the
evidence check flags.

## Consequences

- `src/hooks/dispatcher.mjs` gains `resolveAlreadyPassedSkip(root)` and threads the
  earning record (`adr`) through `skipTest` so the report distinguishes ADR-113 from
  ADR-120.
- The `slice-commit` rule becomes the git-workflow home — commit order, message
  format, push approval, worktrees — and the Git section of `rules/core.md` points
  at it. This is a change to shipped rule text: every adopting repository's
  projection re-renders on its next sync.
- A repository that never records a run (a fresh clone, a clean checkout) is
  unaffected: the ledger is empty, the check fails closed, and the suite runs exactly
  as before.
- The skip is strictly weaker than the re-run — it proves the same tree, with the
  same suite, already passed — so it cannot admit a state the suite would have
  rejected.

## Rejected

- **A manifest key (opt-in).** Consistent with ADR-113's declared skip, but the
  condition here is a fact about the evidence, not a policy a repository chooses; a
  key would let a repository declare a skip it never earns and hide the evidence
  requirement. The docs-only skip stays declared because its condition — the shape of
  the push — is not observable from the ledger.
- **Matching the working tree.** The pre-push gate runs at HEAD, so the evidence that
  matters is a pass on the committed tree. Matching the working tree would let a
  dirty tree skip on a pass that did not include its changes.
- **A TTL or recency window.** The tree digest is a stronger condition than age: an
  entry from a week ago is valid if the tree is the one being pushed, and a fresh
  entry is void the moment a file changes. Age is not evidence; the digest is.
