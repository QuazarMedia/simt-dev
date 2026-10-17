# ADR-086 — The stable prefix comes first, and the lock records both digests

Status: **accepted** · 2026-10-18 · filed as R13 (plan 0003)

**Affects:** `src/projection/rules.mjs`, `src/projection/lock.mjs`, `src/commands/sync.mjs`,
`src/argv.mjs`, `test/lock.test.mjs`, `test/card.test.mjs`

## Context

A reader caches the instruction file. A change in the first bytes throws the rest away,
including the rules that did not change. The plan asks for the stable content first —
core, then stack, then what this repository added — and for a lock that fails when the
output moves and the input did not.

The command card was the first bytes of the region (ADR-077 ruling 1), because the
commands are what a reader cannot infer. They are also the bytes a repository edit is
most likely to move: a script change would then invalidate the core that follows them.

The content digest stays in the generated header. It is a digest of what this package
ships (ADR-032), so a repository edit does not move it, and `check` uses it to tell a
hand-edit from a version mismatch. Taking it out of the file would make those two
failures look the same. No date and no absolute path is written into the region.

## Rulings

1. **Shipped rules, then this repository's own bytes.** Core first, then the other
   profiles this package ships, by id. Then the command card, then profiles the
   repository added, then the index of what the region does not carry. This narrows
   ADR-077 ruling 1: the card still leads the repository's own bytes, and it no longer
   leads the region. The rest of that record stands, including that the card is derived
   from committed evidence only.

2. **The order inside the shipped prefix is by id, not by directory order.** A directory
   listing is not a fact about the rules. Two machines rendering one repository produce
   the same bytes; the test renders one repository twice, which is the half a single
   process can see. The other half is the same argument ADR-073 ruling 7 makes: the
   inputs are the files, and nothing in the render reads the clock, the home directory
   or the network.

3. **`simt-dev.lock.json` records an input digest and an output digest.** The input is
   the package digest, the detected signals, the manifest keys that change the region,
   the repository's own profiles and its `package.json` scripts. The output is the
   region body. `sync --yes` rewrites the lock when it differs. `check` without
   `--frozen` does not require one, because every repository adopted before this record
   would otherwise fail a gate it had not been asked to keep.

4. **`check --frozen` fails in two ways, and names which.** No lock, or a lock whose
   input digest differs, is a stale lock: rewrite it with `sync --yes`. A lock whose
   input matches and whose output does not is unexplained: the projection changed and
   nothing it read did. An output change that an input change explains is the stale
   case, not the unexplained one.

## Consequences

Editing a repository profile leaves the bytes before that profile identical. A frozen
check on a matching lock passes, a tampered output fails as unexplained, and a changed
profile fails as a stale lock.

## Rejected

- **Removing the content digest from the header.** The digest does not move when the
  repository edits a line, and without it a hand-edit and a version mismatch are one
  finding.
- **Hashing the whole manifest, or the whole `package.json`.** A comment, or a
  dependency bump that the projection does not read, would fail the lock for a region
  that had not changed.
- **Failing an ordinary `check` when the lock is absent.** The lock is new. The
  repositories this package already adopted do not have one, and a gate that turned red
  for that absence would be red everywhere until someone ran `sync`.
