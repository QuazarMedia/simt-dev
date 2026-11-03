---
simt-affects: ["src/ledger/evidence.mjs", "test/work-ledger.test.mjs"]
simt-supersedes: []
---

# ADR-165 — evidence is current only for the subject and target it names, and a chain is not an attestation

Status: accepted · 2026-11-03

## Context

The ledger's existing answer — a command passed on this tree — is correct and narrow. It became
wrong when it was read as an answer about a remote target, because the two failures are
invisible in the record:

- a target that was reset keeps the same name and a different incarnation, so the same local
  tree still looks verified against it;
- an unrelated object moving in that target invalidated explicitly scoped proofs, which teaches
  a reader that the evidence is noise;
- an unscoped result was kept after the target revision moved, which is the opposite error;
- a verifier that wrote to its own subject left a record about a tree that no longer exists.

There is also a disclosure failure with no failing test unless it is asked for: a raw log kept
for convenience, with a token in it.

## Rulings

1. **The envelope binds everything the claim depends on:** local tree and overlay digest,
   verifier and contract digests, source observations, target namespace and incarnation, actor
   context, before/after revisions, obligation results and observation time. A claim with no
   binding is not evidence.

2. **Validation asks whether the record is current for this question.** A moved tree is `stale`;
   a different target incarnation is `raced`; a verifier that changed its subject, a record that
   does not contain the obligation, a failed obligation, a local result offered for a remote
   obligation, or a scoped dependency that moved are `inapplicable`.

3. **Explicit scope survives unrelated movement.** A proof scoped to specific refs stays current
   when the target revision changes and those refs do not. An unscoped remote result does not:
   unknown dependencies are `stale` when the target revision moves, because the record cannot
   say what it depends on.

4. **V1 keeps its local meaning and proves nothing remote.** A ledger line without this schema —
   including the run records the ledger already writes — is local evidence about a tree. Offered
   for a remote obligation, it is `inapplicable` with that reason.

5. **A raw log is never stored.** The record keeps a redacted first-line summary, a count of
   redactions and a digest of the redacted text. That is enough to recognise a run and not enough
   to leak a credential.

6. **The chain detects damage, and says what it is not.** Canonical digests and `previous` links
   catch an edited line, a removed record or a truncated file. `attestsExecution` is always
   false: anyone who can rewrite the file can rewrite the chain, and a verifier that claimed
   otherwise would be the most dangerous kind of evidence.

## Consequences

- `src/ledger/index.mjs` is unchanged: existing run records keep their `v: 2` meaning, and this
  module reads them as v1 evidence rather than reinterpreting them.
- The envelope is a value, not a file format change: a caller decides where to append it, and
  the append-only properties come from `chainEvidence` plus the store's own discipline.
- The module reads no clock (`observedAt` is supplied) and no filesystem, so a record can be
  replayed against a fixture target.
