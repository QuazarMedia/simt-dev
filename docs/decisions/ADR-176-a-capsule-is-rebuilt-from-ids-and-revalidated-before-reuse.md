---
simt-affects: ["src/coordination/handoff.mjs", "test/work-handoff.test.mjs"]
simt-supersedes: []
---

# ADR-176 — a capsule is rebuilt from ids, and every dimension is revalidated before it is reused

Status: accepted · 2026-11-03

## Context

A resumed session is the most credulous reader in the system: it has a goal, a summary of what
happened, and no memory of the event. The failures behind this record:

- a resumed session replayed a step that had already taken effect, because the capsule described
  progress in prose rather than receipts;
- a target was reset between sessions and the capsule never rechecked its incarnation;
- an approval was recreated from the capsule summary, which is a decision nobody made;
- a stale or expired lease was handed over as if it still excluded anyone;
- a capsule carried a token or a page of source text into another session's context.

## Rulings

1. **A capsule is built from ids and provenance.** Goal, intent digest, target identity and
   incarnation, snapshot digest and revision, completed obligations with their receipts and
   revisions, unresolved uncertainty, the next admissible action, the remaining budget and the
   referenced approval. `rebuiltFrom` says `ids-and-provenance`, so nothing reads it as a summary.

2. **Content that must not travel is refused, not redacted.** A secret or a body over the bound is
   an error at build time; silent redaction would leave the caller believing the capsule holds the
   original.

3. **A resume revalidates five dimensions in order:** permission, target, dependencies,
   authorization, lease. Any failure blocks the resume and says which one.

4. **An approval is referenced and revalidated.** A digest mismatch is `authorization`, with the
   reason that the approval is never recreated from the capsule.

5. **A changed target or revision reopens what it invalidates.** `reopenFor` names the obligations,
   and a changed incarnation reopens all of them, because every completed obligation was a reading
   of the object that no longer exists.

6. **A repeated receipt is stopped.** `duplicateEffects` reports the receipts already complete, so
   a resumed run cannot perform the same effect twice.

## Consequences

- The capsule is a value with no clock; the caller supplies `now` for the lease check, so a resume
  can be replayed in a test.
- The capsule never carries authority: it carries a reference to an authorization that the
  executor checks again (W32).
