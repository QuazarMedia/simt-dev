---
simt-affects: ["src/knowledge/claims.mjs", "test/knowledge-claims.test.mjs"]
simt-supersedes: []
---
# ADR-150 — a claim is a typed record, an edge has a direction, and a proposal is not authority

Status: accepted · 2026-11-03

## Context

"Shows that claim X supports document Y" is the sentence the whole knowledge layer would
rest on, and it is three claims at once: that X exists, that it says a particular thing, and
that Y was built from it. Left as prose and links, none of the three is checkable. Left as a
free-form graph, the third is worse than uncheckable — an edge extracted by a model looks
exactly like an edge a reviewer approved, and impact analysis then reports a chain as
complete because nothing said where any link came from.

The subtler defect is identity. A claim `19` and a claim `"19"` render the same, and so do
`19 %` and `19`. Unifying them is not a formatting slip: every downstream check afterwards
verifies the wrong assertion, and reports success for it.

## Rulings

1. **A claim is a typed record**: `subject`, `predicate`, `type`, `value`, optional `unit`,
   optional `applicability`, `evidence`, and a review `status`. Type, value and unit are
   validated together, and an untyped record is refused rather than inferred from the prose
   that carries it.

2. **Identity includes the type, the value and the unit.** Two claims unify only when all
   three agree, so a number never unifies with the string that spells it, and a percentage
   never unifies with the bare number. Groups come back as candidate sets, never merged.

3. **An edge points from the entity discussed to its basis.** `claim --derived-from-->
   source`, `helper --implements--> recipe`, `recipe --affects-object--> object`; `supports`
   is the one that reads the other way, because the supporter is the basis. The table is
   explicit, so one traversal answers both lineage and impact without a second resolver.

4. **Contradiction and supersession are not dependencies.** They are recorded and queried,
   and they are not followed by either traversal — a rival claim disagreeing with a document
   does not make the document stale.

5. **A proposed edge is queryable and not authoritative.** Edges default to `proposed`;
   traversal used for checks and authority selection skips them, and `proposedEdges` returns
   them by name. A model- or agent-written dependency becomes usable only by being reviewed.

6. **Text without an explicit marker is unassessed.** Only a marker becomes a claim, a
   misspelt marker field is a reported problem rather than a silently dropped claim, and the
   count of unassessed lines is part of the result. Prose is never turned into an assertion
   on the document's behalf.

## Consequences

- `extractClaims` reads an HTML-comment marker, which survives rendering and needs no
  dependency. Natural-language extraction, when it arrives, is an adapter that proposes
  claims and edges as `proposed`.
- `buildClaimGraph` refuses a dangling edge instead of creating its far end: an absent
  dependency is the unknown frontier and must stay visible.
- Applicability is carried on the claim but is not part of its identity; deciding whether two
  scopes of one claim conflict belongs to the temporal model (plan 0004 W14), not here.
