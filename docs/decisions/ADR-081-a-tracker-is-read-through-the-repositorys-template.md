# ADR-081 — A tracker is read through the repository's template

Status: **accepted** · 2026-10-16 · rulings 1 and 2 superseded by ADR-082

## Context

`plan next` has to open the directory a repository actually keeps its plans in, and it has to
recognise the columns that repository actually writes. Both were fixed: `docs/plans`,
`docs/reviews`, a column named State, and the word `review` in a dependency. That is this
package's own layout. A reader whose plans live somewhere else, or whose tracker says Done
in a column named Progress, would be told they had no plan.

The selection cannot live in the manifest. `init` rewrites that file from the fields it owns,
and a repository that has not adopted the tool has no manifest. A plan template has to work
in both, and it has to survive a re-init.

## Rulings

1. **The format is a template, and the one delivered with the tool is named simt-dev.** It
   reads `docs/plans` and `docs/reviews`, binds columns by the headers it lists, and treats
   `done` as complete. A repository that writes nothing gets that template.
2. **A repository replaces it with `simt-plan.json` at its root.** The file overlays the
   delivered template: a section it names replaces that section, and a section it omits stays.
   Directories, column headers, state words, which of those words unblocks a dependency, and
   the words a dependency uses to name another document are all in that file.
3. **A template that cannot be read is an error.** Falling back to the delivered template
   would index the wrong directories and could mark the wrong row done. A directory path has
   to stay inside the repository.
4. **`plan done` still previews unless `--yes`.** The template decides which word is written
   for the completed state. It does not decide that a row may change unseen.

## Consequences

- `simt plan status` names the template and the directories it read.
- Changing the delivered template changes what every repository without `simt-plan.json` is
  indexed as. The file is the format; the parser does not keep a second copy of the headers.
