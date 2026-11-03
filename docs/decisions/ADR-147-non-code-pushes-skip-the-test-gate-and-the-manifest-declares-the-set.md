---
simt-affects: ["src/hooks/dispatcher.mjs", "src/commands/hooks.mjs", "simt.json", "test/hooks.test.mjs", "test/hooks2.test.mjs", "CHANGELOG.md"]
simt-supersedes: [{ adr: "ADR-113", kind: "superseded" }]
---

# ADR-147 — non-code pushes skip the test gate, and the manifest declares the set

Status: accepted · 2026-11-03

## Context

ADR-113 ruled that a push carrying only documentation skips the `test` gate,
classified by a commit ceiling and declared paths. The ruling held, and its name
outgrew the feature in two ways.

First, the repository's non-code pushes are no longer only documentation. A
release push carries screenshots and assets under `res/`, a notes file, the
changelog and the manifest pin — and "docs-only" misnames a push of a PNG, the
way a label that narrows the set it describes lets the reader miss what ran and
what did not.

Second, a path list is the wrong shape for a file kind that appears anywhere.
`**/*.md`, `**/*.png`, `**/*.txt` are three globs for one idea, and a kind like
`screenshot` that lands at the root, in `docs/` and in `res/` at once needs all
three to be admitted. The two dimensions are orthogonal: a path says *where*,
an extension says *what kind of file*, and a file is non-code when either
admits it.

The opt-in key, the fail-closed posture and the reported skip of ADR-113 all
stand. What changes is what the classifier admits and what it calls.

## Ruling

1. **The concept is "non-code", and the report says so.** The classifier's
   verdict is `nonCode`, and the fired skip is labelled a non-code push.
   ADR-113's "docs-only" name retires with it. Everything else of ADR-113
   stands: the `test` gate is the only gate a push can skip, the classification
   runs from the ref list git feeds on stdin, every uncertainty fails closed to
   the full suite, and a fired skip is reported with the count that earned it.
2. **An extension is a second, orthogonal dimension, and a file is inside when
   a declared path matches it or its extension is declared.** When the manifest
   declares no `extensions`, the built-in set applies: the image kinds
   (`avif bmp gif heic heif ico jpeg jpg png svg tif tiff webp`) and the
   document kinds (`doc docx epub md odt pdf rtf txt`) — the file kinds a push
   can add that no test reads. A declared `extensions` array REPLACES that
   set: the declared set is the only set that applies, because a union is a
   set the manifest does not state, and a declaration that does not state the
   set is one it did not make. Declared entries are normalized — trimmed,
   leading dot stripped, lowercased — and an `extensions` that is not an array
   of non-empty strings fails closed to the full suite, the same as any other
   mis-shaped field. The built-in set does not contradict ADR-113's rejection
   of extension-skip with no manifest declaration: the opt-in key is the
   declaration, and the set is part of its declared default.
3. **`maxCommits` and `paths` remain manifest-declared, and this repository
   declares five commits over `docs/`, `res/`, `package.json` and
   `simt.json`.** The shape of a release push here grew — a release commit,
   its changelog, its asset refresh — and a ceiling of two commits made the
   skip miss the very push it was named for. The redundant `**/*.md` glob is
   dropped from the declaration: the `md` extension covers it.

## Consequences

- A push of up to five commits touching `docs/`, `res/`, the manifest, or any
  image or document file anywhere skips the `test` gate in this repository,
  and the report says so with the commit and file count that earned it.
- A repository that wants a narrower or wider file-kind set declares
  `extensions` and owns it entirely: a repository that declares `["md"]` loses
  `png` from the built-in set, and the loss is visible in the diff.
- `gates.prePushSkipTest` gains an optional `extensions` key. Its absence is a
  declared default, not an absence of control.
- Consumer repositories that already declare `prePushSkipTest` keep their
  declared paths, and their document and image files now earn the skip the
  path globs were always trying to express.

## Rejected

- **Union with the built-in set.** A declared `extensions: ["md"]` that
  silently also admits `png` is a set the manifest does not state; the manifest
  is the classifier's declaration, and a declaration that does not state the
  set is one it did not make.
- **Per-kind toggles (`images: true, docs: false`).** A third shape of
  declaration for a need no repository has expressed; an array is the shape a
  set already is.
- **Skip by extension alone, dropping paths.** A path is the only dimension
  that can admit a file with no recognized extension (`res/data.csv`); the two
  dimensions cover what the other cannot.
