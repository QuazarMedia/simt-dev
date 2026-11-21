---
simt-affects: ["src/commands/verify.mjs", "src/verify/local-run.mjs", "src/ledger/index.mjs"]
simt-supersedes: []
---
# ADR-217 — Scoped local verification records evidence for observed inputs

Status: accepted · 2026-11-21

## Context

A selected check names an observation someone could make. Local work also
needs the outcome, the inputs it covered and the evidence that remains current.

## Rulings

1. Scoped execution is a CLI-only operation. It previews by default and runs
   admissible repository checks when the operator passes `--yes`.
2. A wrapper reports its observed item count as `simt checked: N`. Source tests
   may use the existing runner's report. Exit status alone cannot prove a pass.
3. The ledger holds the check identity, covered inputs, observed count, outcome
   and redacted output digest. Input changes during a run invalidate its result.
4. An explicit attestation can record a human review against the input digest
   printed by status. Its reviewer and basis remain visible.

## Consequences

- Selection, preview and status make no check invocation. Remote obligations
  stay open on the local route.
- Existing Git gates and explicit verification inputs retain their contracts.
