# ADR-082 — The tracker override is a manifest key, and init keeps what it did not write

Status: **accepted** · 2026-10-16 · supersedes ADR-081 rulings 1 and 2

## Context

ADR-081 put the tracker format in a file named for this package, and put a repository's
override in a second file at the root. The name collided with the package and with the
manifest's old filename. The second file existed because `init` rebuilt the manifest from
the keys it knew and dropped the rest, so a `plans` key would not have survived a re-init.

A repository that has adopted already has one config file. A second one, present only when
the tracker differs from the delivered format, is a file most readers will not know to open.

## Rulings

1. **The delivered template is named `tracker`.** It is `templates/plan/tracker.json`. It
   reads `docs/plans` and `docs/reviews`. A repository that sets nothing gets that template.
2. **A repository overrides it with the `plans` key of its manifest.** The key overlays the
   delivered template. A section it names replaces that section, and a section it omits
   stays. The manifest's own comment says so, because that comment is the text a reader of
   the file sees.
3. **`init` keeps every key it does not write.** Owned keys still refresh, in the order the
   writer emits them. A key absent from that object is copied after them, in the order the
   file had those keys. That is what makes ruling 2 survivable: a re-init no longer deletes
   `plans`, or any other key a repository added.

## Consequences

- `simt plan` reads `plans` from `simt.json`, and from `simt-dev.json` while that name is
  still the manifest on disk.
- A manifest written by `init` carries the explanation of `plans` in its comment. The
  comment is generated, so the next `init` or `sync` refreshes it.
- ADR-081 rulings 3 and 4 stand: a template that cannot be read is an error, and `plan done`
  still previews unless `--yes`.
