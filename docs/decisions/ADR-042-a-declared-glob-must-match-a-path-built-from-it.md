# ADR-042 — A declared glob must match a path built from it

Status: **accepted** · 2026-10-08 · ruling 1 superseded by ADR-053 · affects `src/resolve/resolve.mjs` and `graph lint`

## Context

`matchesGlob` rewrote one shape of double star and left the rest to the JavaScript regex engine:

```js
.replace(/\/\*\*/g, '(?:/.*)?')
```

A glob that **started** with a double star compiled to an anchored pattern beginning `**`, which is
not a valid regex. A `try`/`catch` returned `false`, so the failure was indistinguishable from the
glob not matching — which is what a glob is for. 13 of the registry's 65 globs start that way
(`**/*.test.ts`, `**/*.kt`, `**/build/**`, and ten more), and path is the heaviest signal the
resolver has at weight 100. Every one of those skills was unreachable by a diff, and the only
evidence was a staged `.spec.ts` file producing a selection that did not include the skill for
writing tests.

Two facts made this durable rather than a slip. The registry is hand-authored, so nothing compiles
a glob until a real diff happens to contain a matching path. And `graph lint` — the check that
exists to keep the registry describing reality — asked only whether a path array was **present**.
`checkStack` had already established the principle one field over: a tag `fingerprint()` cannot emit
matches nothing, forever, with no error at resolution time, so lint rejects it. A glob that matches
nothing is the same failure wearing a different field name, and no check asked.

Review 0001 §S02 diagnosed both halves and proposed the segment-by-segment translation. Review 0002
§4.1 noted that with a raised Node floor this becomes `path.matchesGlob`, which is one line instead
of twenty. That floor is proposal P8 and S47, still queued; `engines.node` reads `>=20` today and
using a built-in that needs `>=22.20` would have quietly broken the declared range. So the translation
is hand-written here and becomes a one-liner when S47 lands.

## Ruling

**One.** A glob is translated segment by segment. A leading double star is any number of leading
directories, a middle one is any number of middle ones, a trailing one is anything beneath, and a
bare one is everything. `*` remains confined to a single segment, because that is what makes the
double star worth translating rather than treating every star alike.

**Two.** A glob that matches nothing is a lint error, not a zero. `graph lint` now builds paths from
each declared glob and requires the glob to match every one of them. This is the same question the
resolver asks, asked at authoring time by the only tool in this repository that sees the whole
registry at once.

**Three.** A check that reads the same generator it is validating cannot catch that generator
misbehaving. The synthetic expansion is asserted in its own right — a glob claiming any depth must
be shown a path at depth and a path not at depth — because the registry-wide test otherwise just
checks fewer paths when the expansion is narrowed, and checks fewer without saying so.

**Four.** `?` is escaped, not read as a single-character wildcard. Nothing in the registry uses it,
and reading it as a quantifier made `src/a?.ts` match `.ts`. A glob the matcher cannot honour now
fails ruling two loudly instead of matching the wrong paths.

## Consequences

| Mutation | Caught by |
| --- | --- |
| a leading double star translated as a trailing one | `** in each position is anchored the way a path segment is` |
| the synthetic expansion narrowed to the empty case only | `a double star is expanded both ways, or the check above is a mirror` |
| `checkGlobs` deleted | `lint: detects a path glob that matches nothing (S02)` |
| the path signal dropped from `scoreSkill` | `a path signal now reaches the skills that declare a leading **` |

The second mutation is the one worth reading twice. The registry-wide test passed with it — it reads
the generator it is checking, so narrowing the generator narrows the test in step. Only the lint
rule noticed, and only because a bare double star then expanded to nothing at all. Ruling three is
the fix, and it exists because the obvious assertion was not enough.

Measured end to end through the shipped binary: in a Node repo with one staged `src/other.spec.ts`,
`complete-testing` now resolves with the reason `path:**/*.spec.ts`. Before this record it did not
resolve at all. `graph lint` over the real registry reports 49 unique globs and 0 unreachable.

## Rejected

**Waiting for S47 and using `path.matchesGlob`.** It is the better implementation and it is one line.
It is also unavailable under the `engines.node` this package currently declares, and a resolver fix
that breaks a stated runtime range is a worse defect than the one it removes. When the floor moves,
this file's ruling one collapses into that call and the rest stands unchanged.

**Catching the bad glob at match time instead of lint time.** A `throw` in `matchesGlob` converts one
silent zero into a loud crash for whoever happened to stage the right file first — a user, in a
repository, with no pointer to the hand-authored registry field that caused it. The same fact is
available to `graph lint`, where the remedy is a file and a line number.

**Extending the glob language to cover brace and character-class patterns.** `matchesGlob` is called
with `skill.paths` and nothing else; the registry declares no braces and no character classes, and
every one added is a rule that must hold for every future glob with no second caller to check it
against. Ruling four turns the gap into a lint error instead, which is the honest description of a
field the matcher does not implement.

**Testing only the translation, as review 0001's acceptance described.** Unit cases for leading,
middle, trailing and bare double stars all pass while a declared glob nobody staged still matches
nothing. The unit tests prove the function; the lint rule is what proves the data.