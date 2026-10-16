# ADR-080 — The tool's own names are not repositories, and neither reader decides by shape

Status: **accepted** · 2026-10-16 · settles what `rules why` calls a repository

## Context

`ESTATE_NAME` matched `simt-<anything>` that was not `simt-dev`, on the reasoning that
every other name sharing the prefix is a repository in the estate these records were
written in. The reasoning is sound about the estate and false about this tool, which
prints its own prefixed names in its own records: `simt-priority`, `simt-applies`,
`simt-inferable-when`, `simt-hooks`.

Measured over the corpus before anything changed, 21 of the 33 records that named
anything named a name of ours, across 9 records; 7 of those named nothing else:

```
ADR-018  simt-hooks              ADR-047  simt-applies
ADR-022  simt-alwaysApply, simt-applies, simt-fallback, simt-gates, simt-id,
         simt-key, simt-opt-in, simt-owned, simt-substitutions, simt-target, simt-title
ADR-026  simt-package-ecosystem  ADR-056  simt-hooks
ADR-040  simt-hooks              ADR-062  simt-applies
ADR-073  simt-priority           ADR-078  simt-inferable-when, simt-priority
```

Two harms, and the second is the one that matters. `writtenAgainst` listed them under a
heading that says the record was written against those repositories, which is a false
claim about evidence — the one thing a decision record is for. Worse, `redactEstate`
replaced them in the prose, so a reader opening a record through `rules why` read
`` `a repository: hard | command | convention | style` `` where the record says
`simt-priority: hard | command | convention | style`. The command whose whole job is to
explain a citation printed a sentence with no subject.

The answer was already in this repository and in the wrong half of it: the shipped-text
guard derived `TOOL_OWN_WORDS` from `mdc.mjs` and `rules.mjs`, exactly to avoid calling
`simt-priority` a repository. The reader of the same corpus did not, so the guard passed
while the command that ships the corpus misdescribed it. ADR-079's own record is the third
instance of the shape: `simt-inferable-when` was reported as a surveyed repository.

## Rulings

**1. The tool's own prefixed names live in `src/toolwords.mjs`, derived from the modules
that own them.** `KNOWN_KEYS` from `mdc.mjs`, `PROFILE_KEYS` from `rules.mjs`, the
inferability marker from `kernel/inferability.mjs`, and the three names this tool writes
on disk (`simt-dev`, `simt-dev-check`, `simt-hooks`). Derived, not listed (ADR-022): a
second copy of a vocabulary is a copy that drifts and then forgives.

**2. Both readers read that one list.** The decision reader and the shipped-text guard
answer the same question — is this a repository or a name of ours? — and answering it
twice is how the two answers came apart. `test/shipped.test.mjs` now imports
`TOOL_WORDS` instead of deriving its own.

**3. A record whose subject is the prefix names no repository.** `PREFIX_ARGUING` maps
two files (ADR-022, ADR-026) to the reason each spells the prefix, and both readers use
it. A vocabulary cannot settle these: a hypothetical key in an argument and a repository
name are the same shape. The guard's staleness test is unchanged — an exemption that
stops being needed still fails.

**4. Redaction keeps the tool's names and replaces the estate's.**
`redactEstate('simt-priority')` is `simt-priority`; `redactEstate` of an estate-shaped
name is `a repository`. The rule is about what the reader cannot act on, and a key of the
tool they are running is not that.

**5. Detection stays shape-based and strict.** `test/leaks.mjs` keeps `ESTATE_NAME` and
does not consult the vocabulary. Detection may be stricter than rendering without harm: a
word of ours that a surface never should have shipped still fails, and ADR-080 adds no
false negative. This asymmetry is deliberate and is the reason the list did not become a
filter inside the pattern.

**6. `writtenAgainst` still names the estate.** 26 of 80 records list `repo-NN` labels and
keep listing them, every label one of those; the field's purpose is unchanged and the
reader still learns which parts of a record are not about them.

## Consequences

- 21 misdescribed reads are gone and no record names a name of ours; `simt rules why ADR-073 --json` reports
  `writtenAgainst: []` and the record is served with `simt-priority` intact.
- `src/toolwords.mjs` imports `mdc.mjs`, `rules.mjs` and `kernel/inferability.mjs`, so the
  decision reader loads the projection stack. `rules why` is interactive and pays ~5 ms;
  no import in that chain has import-time side effects, which is what makes it safe to add
  to a module the MCP server also loads.
- The guard gained an import and lost a derivation. Its own comment about where the
  vocabulary comes from is now in `src/`, next to what it describes.
- An estate repository whose name does not begin `simt-` is still undetectable, as
  `ESTATE_NAME` says, and this record does not change that.

## Rejected

- **Keeping the shape and documenting the exception.** The defect was not the pattern's
  comment; it was that the pattern was the only definition.
- **Exempting the words instead of the records.** ADR-022's `simt-gates` and a repository
  sharing that shape are indistinguishable, so a word list would either over-exempt a
  repository or under-exempt the argument.
- **A second list inside `src/decisions/index.mjs`.** The guard already had one, and the
  two drifting apart is the defect this record is about.
- **Filtering inside `ESTATE_NAME` itself with a lookahead built from the vocabulary.**
  Detection and rendering want different answers on purpose (ruling 5), and a shared
  pattern would have silently coupled them.
- **Renaming `writtenAgainst` to something vaguer.** The field is right; the shape it
  matched was wrong.
