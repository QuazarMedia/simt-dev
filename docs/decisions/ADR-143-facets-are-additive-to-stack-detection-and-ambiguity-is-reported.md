---
simt-affects: ["src/work/facets.mjs", "test/work-facets.test.mjs"]
simt-supersedes: []
---
# ADR-143 — facets are additive to stack detection, and ambiguity is reported

Status: accepted · 2026-11-02

## Context

A repository whose product is documents was classified as stack `[react]` because a
supporting visualisation was one `.tsx` file. The classification was not a bug in the
detector: `.tsx` is evidence of React. It was the wrong question being asked of the wrong
artefact, and the consequence was that generated pages were reviewed as code while the
documents they render were described by nothing.

## Rulings

1. **Facets are orthogonal and additive.** A repository has zero or more artifact kinds
   (`source`, `document`, `dataset`, `recipe`, `remote-object`), activities (`research`,
   `generate`, `validate`, `operate`), execution loci (`local`, `remote`) and declared
   verification capabilities. Stack and facts are retained unchanged beside them.

2. **A facet adds an obligation and never removes one.** An incidental source file in a
   document repository makes the repository also source; it does not make the documents
   stop being the product, and it does not suppress structure, link or test checks.

3. **`remote-object` and `operate` are declarations, not inferences.** They require an
   explicit `work` namespace: a target list, or a recipe contract carrying `@mutates`.
   A directory name never establishes that a repository operates somebody else's state.

4. **Ambiguity is reported, not resolved.** A path that is both a recipe and a source
   (a Python helper under a recipe tree) is listed in `ambiguous` and contributes both
   kinds. Picking one would silently drop the obligations of the other.

5. **The walk is bounded and says so.** A facet probe reads at most a fixed number of
   paths to a fixed depth and reports `truncated`; it is a probe, not a scan, and an
   incomplete sample must not be presented as a complete inventory.

## Consequences

- A repository can adopt facets with no manifest change; `configured` stays false and the
  outputs describe only what was observed.
- Reports must print the evidence paths they used, because the same kind count from a
  different sample is a different claim.
- Facets do not decide which rules apply; that remains the projection's job, so no
  existing selection changes when facets are computed.
