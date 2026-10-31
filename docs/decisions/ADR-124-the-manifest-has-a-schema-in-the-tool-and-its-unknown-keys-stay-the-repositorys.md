---
simt-affects: ["src/manifest/schema.mjs", "src/resolve/fingerprint.mjs", "test/manifest-schema.test.mjs"]
simt-supersedes: []
---

# ADR-124 — the manifest has a schema in the tool, and its unknown keys stay the repository's

Status: **accepted** · 2026-10-31

## Context

`simt.json` is read in 29 places and 41 keys are read ad hoc across the tree. There was
no list of the keys, so `"mode": "kernal"` was accepted by every reader and reached the
projection as a mode nothing had heard of, and one reader (`fingerprint`) returned
`{error}` as the manifest, so a file that did not parse looked like a declaration of a
key called `error`.

Writing that list is where this repository's characteristic mistake is easiest to make:
the first draft was written from memory and called `limits.fileLines` a positive integer
and `surfaces` an object. In the only manifest the tool has to hand, the first is an
object of two tiers and the second is a list.

## Ruling

### 1. One table declares the manifest keys, their owner and their check

One table in `src/manifest/schema.mjs` declares every key with its owner (`tool` or
`repo`), the version it arrived in, and a check that returns a sentence naming what is
wrong. One loader, `loadManifest(root)`, returns the manifest, whether a file exists,
the version, and the problems. The table is held to this repository's own `simt.json` by
a test, because a schema written from memory fails that test in the same run that proves
the loader works.

### 2. An unparseable file is no manifest, and an absent version field is version 1

A caller that receives a half-read object cannot tell it from a declaration, so a file
that does not parse yields no manifest and one problem naming the parse error. `version`
arrived after every manifest now on disk, so absent means 1 rather than a problem.

### 3. An unknown key is not a problem, because the file invites the repository's own

The manifest comment tells a repository that a value it adds survives a re-init. A
validator that refused an unknown key would make the tool the owner of a file it calls
the repository's, so only a known key with an impossible value is reported.

## Consequences

- `fingerprint` reads through the loader, so a broken manifest no longer arrives as an
  object with an `error` key; a dependent read sees no declaration.
- The 29 direct `JSON.parse` call sites remain. Migrating them is the rest of Q69 and
  changes no behaviour this table already answers for a single call.
- `GENERATED_KEYS` is not yet derived from the table; the table distinguishes `tool`
  from `repo` keys, so the derivation is possible and is not taken here.

## Rejected

- **A JSON Schema file and a validator dependency.** `package.json` declares an empty
  dependency set (ADR-012), and a schema in a second language would be a second place
  the keys are stated.
- **Refusing unknown keys.** The file comment invites a repository to keep its own
  keys, and refusing them breaks every repository that already does.
- **Throwing on a bad value.** A manifest is read on the path of every command; a throw
  turns a typo into a crash with no remedy, where a named problem can be printed beside
  the answer.
