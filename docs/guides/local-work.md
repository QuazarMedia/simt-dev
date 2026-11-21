# Find evidence in one local scope

Run these commands from a Git checkout with SIMT installed. Replace `handbook` in
the path and scope arguments with the directory and scope id you want to use.
Stage or commit the Markdown you want to search before building.

```sh
simt work inspect
simt work setup --scope handbook --path handbook --kind document
simt work setup --scope handbook --path handbook --kind document --yes
simt knowledge build --scope handbook
simt knowledge build --scope handbook --yes
simt knowledge rank --scope handbook --query "device checkout retention"
simt knowledge rank --scope handbook --query "device checkout retention" --where jurisdiction=DE
simt knowledge why device-checkout-current#device-checkout --scope handbook
simt knowledge why retention.current --scope handbook --as-of 2024-06-01 --known-at 2024-06-01
```

Use the returned path and anchor to open the section in your editor. The scope limits
which repository files enter the corpus. The optional `--where` limits which
metadata values can answer a particular query. A historical query supplies both
the effective date and the date through which observations may be used.

To attach a reviewed claim, record its jurisdiction and dates in the existing
source and put the claim marker under the relevant heading. These are example
values for a maintainer who has reviewed a 30-day rule.

```markdown
---
id: device-checkout-current
scope: {"jurisdiction":"DE"}
authority: reviewed
validFrom: 2025-01-01
knownAt: 2025-01-02
---
# Device checkout

Device checkout retention is 30 days.

<!-- claim: id=retention.current subject=device-checkout predicate=retention type=number value=30 unit=days status=reviewed -->
```

Rebuild after updating a source. For an absent answer, check that the file is
tracked and inside the scope. Try its path as an exact query. Ordinary sections
can be cited as evidence, and SIMT reports when a section lacks a reviewed claim.

## Check one change

Keep your existing validator and Git workflow. In a version 3 `work`
declaration, add a check to the scope's `checks` list. This entry assumes the
repository already has `scripts/check-handbook.mjs` and that the wrapper checks
structure. Adjust the arguments and coverage to match your own check.

```json
{
  "id": "handbook-structure",
  "argv": ["node", "scripts/check-handbook.mjs"],
  "covers": ["structure"]
}
```

The wrapper reports a count as `simt checked: N`. A passing exit with a missing
count or zero observations leaves verification open. For a tracked edit, run:

```sh
simt knowledge impact --changed --scope handbook
simt verify select --changed --scope handbook
simt verify run --changed --scope handbook
simt verify run --changed --scope handbook --yes
simt verify status --changed --scope handbook
```

Use `simt verify select --staged --scope handbook` to plan from index contents. The
execution command reads the working tree. The ledger keeps input digests and
check outcomes. Human review remains pending until a reviewer checks the content
and supplies an attestation using the obligation id and input digest from the
JSON status. Pass a JSON object with an `attestations` array of entries containing
`id`, `inputDigest`, and `reviewer` to `simt verify status --input <file>` alongside the
scope and diff flags.

## Keep existing workflows

Explicit JSON inputs continue to work alongside a scope. The local corpus
understands Markdown sections, inline metadata, adjacent tracked Markdown
sidecars, and the procedure annotations your repository uses. It preserves
declared dates and jurisdictions and searches lexical terms in the actual
source language. Binary files, live sources, semantic equivalence and remote
verification require separate evidence.

A version 3 scope can declare a `tracker` with `kind`, `path` and `visibility`.
Recognized kinds are `plan`, `markdown-items`, `markdown-table`, and `json`.
A JSON tracker uses `version: 1` and a `tasks` array. Define each task's `id`,
`state`, and `artifacts` using its existing identifier and source paths. A
handoff refers to the issuing worktree's evidence ledger.

```sh
simt work schedule --scope handbook
simt work handoff --scope handbook --task CHECK-1 --json > .simt/local/capsule.json
simt work resume --scope handbook --input .simt/local/capsule.json
```

Use the actual task id from the schedule. Keep local capsules with the worktree
or in a private location. A private tracker is omitted by
`simt work schedule --scope handbook --public`.

Optional version 3 fields `catalogue` and `share` point to a local JSON catalogue
and list paths explicitly approved for sharing. A version 1 catalogue names the
repository and Git revision and supplies candidates with `id`, `path`, `anchor`,
`revision`, and `permission`. Use `simt knowledge import --scope handbook --input <file>`
to check it. `simt knowledge export --scope handbook` exports committed citations
under the approved paths. It withholds private tracker paths and ignored sources.

## Roll back a scope

If `work setup` was the last journaled write, preview `simt undo` and apply it
with `simt undo --yes` if the preview matches the change you want to remove.
Otherwise, remove only the scope you added from `simt.json` and delete its
rebuildable cache at `.simt/local/corpus/handbook.json`. Keep your canonical
documents, reviewed metadata, existing validators, tracker and receipts.
