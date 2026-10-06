# ADR-026 — a config whose grammar cannot hold a region is a file the repo owns

Status: accepted · 2026-10-06
**Affects:** `src/ci/dependabot.mjs`, `src/commands/ci.mjs`, `src/commands/init.mjs`,
`src/commands/help.mjs`, `src/projection/project.mjs`, `test/ci.test.mjs`.
**Narrows:** ADR-025 rulings 1 and 2. **Extends:** ADR-023 (bytes copied, written once),
ADR-024 (simt-dev's own copies are refreshed by `simt-dev ci`). Settles the Dependabot
item §3.1 row 8 of `docs/plans/0001-centralise-agent-rules.md` named as still missing.

## Context

ADR-025 ruled that a baseline is a marker-managed region, and that only a file whose format
can carry a comment may hold one. Ruling 2 named `tsconfig.base.json`, `.prettierrc.json` and
`.nvmrc` as "ruled out, not deferred", and its consequences promised that "the next fix is
three more JSON files and therefore a different mechanism". That mechanism did not exist.

Dependabot arrived first, and not by accident: it was the one owed baseline that needed no
new mechanism at all, and the gap had been named and dated in the plan since before any of
this existed — row 8 says the Dependabot config "is still missing and is not part of that
ruling". A repo with no Dependabot config does not receive security patches as pull requests;
it finds out from an advisory.

Dependabot also supplied the missing counterexample to ADR-025's ruling 2, which is why
this record exists rather than a template file. `updates:` is a **YAML list**. Two lists
cannot be concatenated. There is no region shape that means "these entries are mine and
those are yours", so there is nothing to merge and nothing to preserve — the mechanism
ADR-025 chose does not apply to this file because the file's grammar has nowhere to put it.

That is a property of the file, not a reason to prefer a different file. The question worth
ruling on is what ownership means for a config simt-dev writes into a repo and must not
rewrite, and ADR-023/024 had already answered it for the file sitting next to this one in
the same directory.

## Rulings

1. **A config whose grammar cannot hold a region is a whole file the repo owns from the
   moment it is written.** `simt-dev init` creates `.github/dependabot.yml` once and never
   touches it again. There is no partial ownership to describe because there is nothing to
   merge; the repo's own cadence, `ignore` rules, `groups` and private `registries` are
   edits to a file simt-dev has already stopped writing.

2. **Ownership does not depend on content being mergeable.** ADR-023's rule — copied bytes,
   written once, the reader's from the first commit — extends from the CI gate to this file
   unchanged. A reader of ADR-023 who assumed the rule depended on the file having a
   place for a region was wrong, and this is the record that says so.

3. **The content is detection-driven, from facts that already exist.** Each entry names an
   ecosystem this tree has a manifest for, derived from `fingerprint`'s `has-*` facts and
   stack tags. No new fact is declared, so ADR-013's "content is data, the engine is code"
   holds without a profile change. The failure this prevents is an entry that looks
   configured and configures nothing: Dependabot finds no manifest, opens no pull request,
   and the config reads as though the repo's dependencies are watched.

4. **One entry per ecosystem, not one per manifest.** `pyproject.toml` and `requirements.txt`
   are two ways of declaring python dependencies and Dependabot reads both under `pip`. Two
   `pip` entries is a duplicate the config rejects or silently collapses, and the reader has
   no way to tell which won.

5. **`has-build-system` is not mapped to an ecosystem.** Makefile, CMakeLists and
   `meson.build` are build files, not dependency manifests, and Dependabot has no ecosystem
   that reads them. Mapping the fact to `maven` would be a plausible-looking line that
   watches nothing — ruling 3's failure mode, wearing a fact's name.

6. **`github-actions` is the one unconditional entry,** and it is unconditional because of
   what this package ships: simt-dev writes a workflow into every repo it adopts, so every
   repo that adopted it has Actions to watch. A repo with no workflow has no Actions.

7. **The file appears only where `.github/workflows` already exists,** for the same reason
   ADR-023 ruled it for the gate: creating that directory silently would start opening
   pull requests nobody asked for.

8. **Both `.github` files are planned, written and refused together, by one command.**
   `simt-dev ci` handles the workflow and the config because they answer the same question
   the same way; a reader learning which command owns which file would be learning about
   ownership twice to learn nothing new. `simt-dev ci` still refuses outside this
   repository, naming `simt-dev init --yes` as the writer.

9. **`check` reports absence and never contents,** as it does for the gate. A file whose
   every byte is legitimately theirs cannot be diffed against a template without reporting
   their work as drift.

## Consequences

`.github/dependabot.yml` joins `.github/workflows/simt-dev-check.yml` as a second shipped
`.github` file with one ownership rule and one writer. `check` gains a second `absent`
finding whose remedy is the same `simt-dev init --yes`, so a repo that runs Actions with a
gate but no dependency updates is reported rather than left to find out from an advisory.

What this does **not** settle: `tsconfig.base.json`, `.prettierrc.json` and `.nvmrc` are
still regions that cannot exist. Ruling 1 answers the ownership question for them when
someone writes one, and it is deliberately the same answer as here, but no file has been
written and none should be inferred. The gap stays named in §3.1 row 5.

The estate consequence is the one that costs: no repository in it had a Dependabot config,
and the three pilot repositories from Phase 4 will each need `simt-dev upgrade` to receive
one. That is ADR-001's ordinary cost and is not a defect.

## Rejected

- **A region inside `updates:`**, with entries above and below it. Rejected because it does
  not exist: YAML lists have no interior, and a comment-delimited block in the middle of a
  sequence is not a sequence. Shipping it would produce a config GitHub rejects.
- **Merging by rewriting the whole `updates:` list,** preserving the repo's entries by
  parsing and re-emitting them. This is the one design that could give partial ownership,
  and it is rejected for the same reason as a manifest merge: simt-dev would have to parse
  and re-emit a config it does not own, and every round trip through this tool would be an
  opportunity to drop a key this tool never understood. ADR-015's content-not-location
  principle cuts the same way — the repo's config is identified by its bytes, and this tool
  does not hold those bytes.
- **Prefixing the keys** to claim ownership, as ADR-022 does for rule frontmatter. Rejected
  because these keys are GitHub's: Dependabot rejects `simt-package-ecosystem`. Ownership
  here is expressed by not writing the file again, not by renaming what GitHub reads.
- **One fixed list for every repo,** `github-actions` plus `npm`. Rejected by ruling 3: it
  writes an `npm` entry into a repo with no `package.json`.
- **A new `has-node-manifest` fact,** so the table reads uniformly. Rejected because `node`
  is already a stack tag and `typescript` already a dependency name; a third name for one
  observation is the duplication `fingerprint.mjs`'s own table header rules out.
