# ADR-065 — A pack is one shared rule set, vendored into the repository and pinned by digest

Status: **accepted** · 2026-10-13 · filed as S39
**Affects:** `src/packs.mjs`, `src/projection/rules.mjs` (`loadRules`, `select`), `src/projection/manifest.mjs` (`packs` field), `src/commands/sync.mjs` (`check`), `src/compare/row.mjs` (`packs`, `problems`), `test/packs.test.mjs`

## Context

S39 found estate product policy shipping as if it were universal: a profile that named
one company's domain layer, a rule file that named its Firebase environment variables, and
a `gender` sentinel in a map profile. Fourteen repositories shared one set of those rules
and each carried its own copy, so a policy change was fourteen edits that could be thirteen.

Two answers were available. The first is a remote: a pack published somewhere, a `source`
in the manifest, and the renderer fetching it. The second is a directory in the repository
holding the bytes, with a digest recorded so nobody has to trust that the two agree.

The remote is the one that reads better in a design document and is worse for the reader
this tool is for. A region rendered from a fetched pack is a region whose bytes depend on
something the receiving repository does not contain: a reader who clones the repo, deletes
their network, and runs the gate gets a different answer, and a reviewer approving a diff
is approving text they cannot produce from what is in front of them. That is the single
failure this repository exists to prevent, and a shared-rules feature is exactly where it
would arrive.

The vendored answer has one obvious weakness: updating a pack is a commit in every
repository that declares it, not one push somewhere. That is the cost of the property
above, and it is the right trade — a rule a reader cannot account for is worth less than a
rule that is one merge behind.

ADR-061 already settled half of P4. A pack may have carried the skill registry, and the
review's fix line says it should; ADR-061 ruled the registry to be workspace data that the
package no longer ships. A second source for it would reopen that ruling by accident, from
a feature that is not about skills at all.

## Rulings

1. **A pack's bytes live in the adopting repository, and the manifest records a digest of
   them.** The manifest gains a `packs` list of `{name, source, version, digest}`; the
   directory the tool reads is a fixed one, and `source` and `version` record where the
   bytes came from for a human and for a future fetch. Nothing in a projection reads a
   path outside the repository it is rendering into.

2. **Precedence is ranked, not special-cased: the repository's own profile, then a pack it
   declares, then what the tool ships.** The ranking is one table read by the selector, so
   the precedence and the order the files are collected in cannot disagree. A replacement
   is reported in the existing `shadowed` list, because a profile that silently replaced
   another leaves a reader unable to tell which of two texts they are being held to.

3. **A pack that is present but disagrees with its pin still projects.** What is
   questioned is the pin, and the gate blocks and prints both digests. Dropping the pack
   instead would let the remedy the finding names — `sync` — delete every rule the pack
   carries, which is the opposite of what a reader who ran it meant. A pack that is absent
   has nothing to project and blocks with a remedy that restores it; a pack with no digest
   is reported and does not block, because its rules render correctly and only the record of
   which bytes they were is missing.

4. **A pack carries rule files, not a skill registry.** A profile it ships is selected by
   the same matcher as any other and appears in the region's source list under its pack's
   directory. A registry inside a pack is read by nothing, and that is the ruling rather
   than an oversight: ADR-061 makes the registry workspace data, and a second source for
   it needs its own decision about which of two registries answers.

5. **`compare` reports every pack and the digest it is pinned to, per repository.** The
   pinned digest, not the computed one — it answers "which bytes was this declared at", and
   a row reporting the new digest would hide the mismatch from anything reading the JSON.
   A pack that cannot be used is a problem on the row; one that is merely unpinned is a
   note, which is the same division the gate draws.

6. **`packs` is repository-owned content, not a generated field.** Which packs a repository
   uses is its decision, so a re-init must not empty it, and the drift check does not
   compare it. What is compared is the directory's digest against the pin.

## Consequences

- A group of repositories sharing one rule set declares the same pack and vendors the same
  bytes; a policy change is a commit per repository, and the digest is what makes an
  unmerged one visible before a reader follows stale instructions.
- Nothing fetches anything. A pack cannot be pulled by name, cannot be published by this
  tool, and cannot be refreshed by `upgrade`. That is the deliberate half of the answer,
  and it leaves the fetch as a later ruling rather than a missing feature.
- The rule provenance digest does not cover pack bytes, so `projection.simtDevSha` still
  answers "what did the tool render" and the pack digest answers "which bytes were these".
  Two answers to two questions, both in the manifest.

## Rejected

- **Fetching a pack from a remote during projection.** It makes the rendered bytes depend
  on something the receiving repository does not carry, and it puts the network inside a
  command whose defining property is that it is deterministic and offline.
- **Refusing to project a pack whose digest does not match.** The remedy would delete the
  rules it reports, so the tool would cause the damage it exists to report.
- **One flag per pack state**, so a reader could choose what blocks the gate. Three flags
  for one directory's worth of state is a configuration surface nobody will read twice, and
  the division that matters — does the region account for its rules — has one defensible
  answer.
- **A pack carrying the skill registry**, which proposal P4 asked for before ADR-061
  settled where the registry comes from.