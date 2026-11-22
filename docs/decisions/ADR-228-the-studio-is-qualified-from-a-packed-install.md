---
simt-affects: ["src/surface.mjs", "src/docs/reference.mjs", "docs/reference/surface.md", "test/studio-release.test.mjs", "test/fixtures/studio", "docs/plans/0007-studio-local-dashboard.md"]
---

# ADR-228 — the studio is qualified from a packed install

Status: accepted · 2026-11-22

## Context

ST01–ST14 proved each studio room against the checkout. That is not how a consumer runs
it: the shell, control route and optional bench package have to survive `npm pack`, an
install with no siblings, and a clean repository. The release slice also has to leave two
sanitized transcripts a maintainer can compare against, and ADR-207 requires the surface
inventory to say what was qualified and at which code SHA.

## Decision

1. **Qualification runs from the artefact.** `test/studio-release.test.mjs` packs the
   working tree, installs the tarball into a standalone consumer, and drives the installed
   `studio` binary. It does not import the checkout's server to answer the install claims.
2. **Both fixture shapes share the same contract.** A document corpus and a code repository
   each open a loopback studio; the overview answers, the helm reads a cited row, and one
   guarded `work setup` preview/apply/undo round-trip completes with journal and event
   evidence. A fixture that only works because the checkout is adjacent is not qualified.
3. **The transcripts are fixtures, not prose.** `test/fixtures/studio/qualification-document.json`
   and `qualification-code.json` record the commands, status, asset bytes and the
   loopback request set, with paths sanitized. They are compared for structure and
   provenance, never for live timing.
4. **The surface row carries the evidence.** `src/surface.mjs` keeps studio `optional` —
   it is supported when used, but it is not part of the adoption path — and records the
   qualification SHA `45b5298`, the studio source commit the transcripts measured. The
   generated `docs/reference/surface.md` renders that row, so a reader can go from the
   promise to the evidence without a second inventory.
5. **The manual walkthrough is named, not claimed.** Keyboard-only traversal of every view
   in both themes remains the review's manual step; the automated suite checks the focus
   styles, theme switch, reduced-motion rule, asset budget and request set, and the review
   records the human walkthrough.

## Consequences

- A studio change after `45b5298` must regenerate the qualification SHA and the two
  transcripts; the release test fails when the surface page and the fixtures drift.
- The optional bench is not required for qualification; its absence is exercised as the
  labelled state in ST14, and the transcripts record whether it was present.
- No new dependency, port or external origin arrives with the release slice.
