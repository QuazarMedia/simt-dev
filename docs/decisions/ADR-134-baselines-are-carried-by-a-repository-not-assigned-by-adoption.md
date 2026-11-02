---
simt-affects: [".editorconfig", ".gitattributes", "src/argv.mjs", "src/commands/spec.mjs", "src/projection/baselines.mjs", "src/projection/project.mjs", "src/projection/rules.mjs", "test/baselines.test.mjs"]
simt-supersedes: []
---
# ADR-134 — baselines are carried by a repository, not assigned by adoption

Status: accepted · 2026-11-02

## Context

ADR-025 and ADR-027 gave every adopting repository a generated region in
`.editorconfig` and `.gitattributes`. Both files were written on adoption and their
bodies were hashed into the rule digest, so the two decisions together had three
effects nobody chose:

- a TypeScript repository received the Go, Make and Python sections, because the baseline
  is one body for the whole estate;
- `eol=lf` reached repositories that had never decided on line endings, and the first
  `git add` after adoption could renormalise the tree;
- an edit to either body changed the digest, which made **every** repository's AGENTS.md
  region stale — including repositories that had deleted the baseline file entirely.

Review 0003 Q84 measured this row as "hashed into the digest (edits drift every repo);
ship Go/Make/Python sections into TS repos; `eol=lf` renormalisation diffs", and
recommended opt-in for fresh adoptions while keeping the region for repositories that
already carry it.

## Rulings

1. **Presence is the opt-in.** A baseline target is built only for a file that already
   carries a well-formed region. A file the repository wrote without one is left alone,
   and an absent file stays absent. `--baselines` on `init` or `sync` is the explicit
   request that writes the region into a repository that has none; it is the only path
   that creates one.

2. **Removing a baseline is opting out.** `check` reports a baseline that is present and
   stale, misplaced or malformed. It does not report one that is absent: after this
   ruling the absence is not drift, it is the repository's answer, and a finding there
   would demand a file the repository just decided against.

3. **Baseline bodies are not rule content.** `provenanceInputs` no longer hashes
   `.editorconfig` and `.gitattributes`, so an edit to either body cannot make an
   adopted repository's AGENTS.md stale. A baseline's own region still carries the rule
   digest, so a change to the *rules* still reaches it; a change to the *baseline* is
   seen where it belongs, in that file's own byte comparison.

## Consequences

- ADR-025 and ADR-027 still rule on the region's content and placement, and on why the
  file is a region rather than a file simt-dev owns. What changes is who decides a
  repository gets one.
- This repository keeps both baselines: it carries the regions, so `sync` maintains
  them. Nothing about the self-adoption changes.
- A fresh adoption writes AGENTS.md, the rule files and the lock, and no baseline.
  `simt init --baselines` writes the two the estate has decided on.
- The digest moves once for every repository, because three inputs left it; the stamp is
  a digest of rule content and this is the last time a baseline edit moves it.

## Rejected

- **Record adoption in `simt.json`.** A manifest key would distinguish "never adopted"
  from "adopted then deleted", at the cost of a schema version, a second source of truth
  for a file's own contents, and a migration for every repository — to answer a question
  no command asks. Presence answers it already, and the file is the record.
- **Keep hashing the bodies and accept the drift.** The drift is the defect: sixteen
  repositories re-rendered an AGENTS.md stamp for a byte they do not carry.
- **Ship per-ecosystem baseline sections.** The review's other half, and a larger change
  than a ruling can carry: it would make the baseline body detection-driven, and the
  sections are the reason the region is shared rather than owned.
