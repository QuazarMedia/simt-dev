---
simt-affects: ["src/knowledge/rank.mjs", "test/knowledge-rank.test.mjs"]
simt-supersedes: []
---
# ADR-156 — ranking filters first, scores in named parts, and a linked page cannot win by being linked

Status: accepted · 2026-11-03

## Context

A lexical score is a statement about wording, and it is routinely read as a statement about
evidence. The page that mentions every term three times, the copy derived from the source,
and the page that was right until last year all outrank the one current source, and the
reader sees an ordered list with no indication that the order means "mentions" rather than
"applies".

Two smaller failures follow from the same confusion. A unit whose scope the question did not
ask about (a French rate for a German question) appears in the list because the words match;
and a unit with no stated scope disappears entirely, which is indistinguishable from "there
is nothing".

## Rulings

1. **Filter before scoring.** Permission and declared-scope conflicts remove a unit before it
   has a score. Scoring first and filtering afterwards would let a leaked unit influence the
   ordering it was later dropped from.

2. **An unplaceable unit is its own class.** A unit that states no scope where the question
   names one is reported as `unknown-scope`, beside the answer, never ranked as if it applied
   and never silently dropped.

3. **The score is a sum of named parts.** Lexical coverage, declared authority, evidence
   count, and a penalty for a derived copy, stale lineage or a boilerplate hub. `scoreFrom`
   recomputes the total from those parts, and the printed components are the ones it uses, so
   an explanation can be checked rather than believed.

4. **A hub is labelled, not hidden.** A heavily linked or stale page can still be the only
   thing that discusses the question, so it is retrieved and carries `boilerplate-hub`,
   `obsolete` or `derived-copy` with the penalty each label costs. Losing to the source is
   visible in the labels, not inferred from the order.

5. **Ties break on a stated order.** Score, then authority, then lexical coverage, then path,
   then id. The comparator is documented because "the order looked stable" is how input order
   becomes behaviour.

6. **Recall is reported per stratum, with its denominator.** `evaluateRank` reports
   recall@k by language and by artifact kind and names every miss with what was retrieved
   instead. A pooled average is not reported as the result, because one failing language
   disappears in it.

7. **Embeddings stay off.** No vector term is applied unless a measured uplift earns it; the
   result says `embeddings: 'off'` rather than leaving the absence implicit.

## Consequences

- `rank` is a pure function of the units and the question: no index, no clock and no network,
  so a corpus can be replayed and a score diffed.
- The unit contract is explicit (`scope`, `authority`, `evidence`, `links`, `derived`,
  `stale`, `permission`, `conflictsWith`), which is what a later retrieval slice reads from
  the claims and observation models rather than re-deriving.
- The hub penalty is capped, so a thousand links are not a thousand times worse; the label,
  not the arithmetic, is what tells the reader why the page lost.
