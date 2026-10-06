# ADR-022 — A key simt-dev reads is prefixed `simt-`

Status: accepted · 2026-10-08
**Affects:** `rules/*.md`, `rules/mdc/*.mdc`, `src/projection/mdc.mjs`, `src/projection/rules.mjs`, `test/shipped.test.mjs`. Supersedes the *spelling* of the keys named in ADR-013 and ADR-016; their rulings stand.

## Context

A canonical `.mdc` frontmatter block carries two vocabularies in one place:

```
id: test-gate
target: .cursor/rules/test-gate.mdc
description: ...
alwaysApply: true
applies: always
```

`description` and `alwaysApply` are Cursor's, cited in the `cursor` row of
`src/projection/surfaces.mjs` and re-emitted per surface. `id`, `target`, `applies`,
`optIn` and `substitutions` are simt-dev's own and appear in no vendor's
documentation. In the file above, nothing says which is which: `alwaysApply: true` and
`applies: always` sit four lines apart, both read as "always", and both are consumed by
something. The question was asked of this repository and could only be answered by
reading the source rather than the file.

That is a legibility failure with teeth behind it. ADR-016 records finding S11: a rule
shipped, was tested for its presence on disk, and reached no repository, because
`applies` was absent from its frontmatter. A missing simt-owned key is silent. A bare
key that looks like the key beside it is one typo away from the same silence, and this
block is precisely where a reader editing one key is looking at the other.

The prefix does not exist to make the files tidy. It exists so that a bare key is
either an editor's key or a defect, and never a third thing.

## Rulings

1. **Every key simt-dev reads out of a canonical rule file carries `simt-`.**
   `simt-id`, `simt-target`, `simt-title`, `simt-applies`, `simt-opt-in`,
   `simt-substitutions`, `simt-fallback`.

   | was | is |
   |---|---|
   | `id`, `target`, `title` (`.mdc`) | `simt-id`, `simt-target`, `simt-title` |
   | `applies`, `optIn`, `substitutions` (`.mdc`) | `simt-applies`, `simt-opt-in`, `simt-substitutions` |
   | `id`, `title`, `applies`, `fallback` (`rules/*.md`, `.simt-dev/profiles/`) | `simt-id`, `simt-title`, `simt-applies`, `simt-fallback` |

2. **An editor's key keeps the vendor's spelling, unprefixed.** `description` and
   `alwaysApply` are the only two keys in the estate with two owners: simt-dev reads
   them and re-emits them mapped per surface (`alwaysApply` becomes Antigravity's
   `trigger: always_on`). Prefixing them would be a lie in both directions — Cursor
   would ignore `simt-alwaysApply`, and the projector would have to strip the prefix
   before emitting. A key is prefixed when this tool is its only reader.

3. **An unrecognised key is a defect, not an ignored line.** `applies:` in a file that
   should say `simt-applies:` reports as a problem naming the prefixed spelling.
   This is the ruling that turns the prefix from a convention into an invariant: the
   failure mode ADR-016 hit is now loud, and loud before the rule reaches nobody.

4. **The prefix binds settings read from files, not identifiers in code.** `rule.applies`
   is still `rule.applies` in `src/`. Renaming the property would satisfy the sentence
   and change nothing a reader of a rule file sees, which is the only reader the prefix
   is for.

5. **Inside `simt-substitutions:` the keys stay `key`, `default` and `describe`.** The
   parent already namespaces them; `simt-key` reads as though the block were not there.

6. **Out of scope, deliberately: `simt-dev.json` and `graph/skills.graph.json`.** Both
   are namespaced by filename, neither contains a key any editor or agent reads, and
   both are read by this tool's own commands rather than by a person opening a rule
   file. The receiving repo's manifest is the one file a human edits by hand — to
   declare a gate command or a substitution — and `simt-gates` there is noise in the
   place noise costs the most.

## Consequences

- **No receiving repository is affected.** These keys are stripped before projection:
  `.md` frontmatter is dropped by `stripFrontmatter`, and a projected `.mdc` gets
  frontmatter rebuilt from the surface row (`description` + `alwaysApply`) or preserves
  whatever an adopted file already had, verbatim and unparsed. The change is
  confined to the files in this repository, which is why touching shipped rule text is
  cheap here and expensive in `rules/core.md`'s prose.
- A rule file that still says `applies:` now fails `check` with the prefixed spelling in
  the message. That is the intended break: it fails at the file, loudly, on first run.
- ADR-013 and ADR-016 name the old spellings in their examples. They are left verbatim
  — they are the record of what was ruled — and this record is the lookup from the old
  spelling to the new one.
- `rules list` keeps an `applies` column. It labels a value, not a key, and the value
  vocabulary (`always`, a tag list) is unchanged.

## Rejected

- **Prefix the manifest keys too.** Rejected: `simt-dev.json` is already namespaced by
  filename, and the keys a person edits by hand are the ones a prefix would obscure.
- **Prefix in code as well, for symmetry.** Rejected under ruling 4: it is a rename of
  variables that satisfies the wording and defeats the purpose.
- **Accept both spellings for one release.** Rejected: a key that may be written two
  ways is exactly the ambiguity this record exists to remove, and the failure it hides
  is the unreachable rule ADR-016 already shipped once.
