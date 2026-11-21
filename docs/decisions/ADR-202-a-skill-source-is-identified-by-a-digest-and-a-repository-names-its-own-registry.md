---
simt-affects: ["src/graph/load.mjs", "src/resolve/source.mjs", "src/commands/help.mjs", "graph/skills.graph.json", "test/graph.test.mjs", "test/graph-vendored.test.mjs", "test/workspace.test.mjs", "test/install.test.mjs", "test/pack.test.mjs"]
simt-supersedes: []
---
# ADR-202 — a skill source is identified by a digest, and a repository names its own registry

Status: accepted · 2026-11-21 · filed as review 0005 PR24

## Context

A declared source was identified by its byte count. `graph lint` compared that count and
`locateSource` accepted a candidate whose size matched, so two different bodies of the same
length were the same source: a repo carrying a 5048-byte `slice-commit` satisfied a
declaration for a different 5048-byte `slice-commit`, and the variant logic installed the
wrong body under the right name. ADR-015 already rules that content decides identity; the
implementation had settled for length, which is a weaker claim than the ruling.

Registry discovery also had one tier that only a checkout could use. The package root's
`graph/skills.graph.json` was found first in this repository, and an adopting repository
with no workspace had no repo-owned place to put its own catalogue. The only ways to name
one were `--registry` and an environment variable - configuration a repository cannot
commit.

The workspace answer was memoized per process by flag, environment, config location and
cwd. A `simt.json` or user config edited between two requests in one process kept answering
the value read first, so an editor that changes the workspace and asks again gets a stale
answer with no way to tell.

## Ruling

1. **A source declares its digest when it can, and the digest is its identity.**
   `sources[].sha256` hashes every file's relative path, length and bytes in sorted order, so
   a moved byte, a renamed reference or a same-size substitution all change it.
   `measureSkill` reports it; `graph lint` rejects a mismatch; `locateSource` accepts a
   candidate only on a digest match when one is declared and reports `identity: 'sha256'`.

2. **A byte-only registry is the migration path, and it says so.** A source with no `sha256`
   still resolves by size, and one warning per loaded registry names how many of how many
   sources are byte-only. A malformed `sha256` is an error, not a fallback. This keeps every
   published registry readable while making the weaker identity visible.

3. **A repository names its own registry at `.simt/skills.graph.json`.** The default order is:
   positional path, `--registry`, `SIMT_REGISTRY`, `SIMT_DEV_REGISTRY`, the repository's own
   `.simt/skills.graph.json`, the package root's catalogue (a source-checkout convenience),
   then the one workspace member that holds one. A repository-local registry outranks the
   checkout because the repository the reader named is more specific than the checkout the
   binary happens to live in. A repository is a first-class scope of one (ADR-014), so its
   own registry needs no workspace.

4. **The package still ships no registry (ADR-061).** `graph/` is not in the published
   `files`; an installed consumer gets the honest absence, and now also a repo-local path it
   can create instead of an environment variable.

5. **The workspace cache is keyed by the revisions that decide the answer.** The key carries
   the flag, the environment, the config location, the cwd, and a content digest of the
   manifest and of the first user config a reader would load. The map is bounded; the oldest
   entry is evicted. A config edited between two calls in one process is answered fresh.

## Consequences

- The one packaged source (`skills/simt-commands`) carries a digest, so drift in the body
  that ships is caught by identity as well as size. Workspace-member sources remain byte-only
  until the workspace that holds them can compute a digest.
- `locateSource` callers get an `identity` field; the shape is additive, so a caller that
  reads `path`, `how` and `bytes` is unchanged.
- `simt graph lint` reports one migration warning for a registry that has not adopted
  digests, not one per source.
- A consumer with a single repository can commit `.simt/skills.graph.json` beside its other
  adopted state, and a packed CLI reads it.

## Rejected

- **Make `sha256` mandatory now.** Every workspace-member source would fail to load until a
  registry that can see those bodies is regenerated, which is a migration gate disguised as
  a validation rule. The warning is the gate.
- **Identify a source by its first file's digest.** A skill is a directory; moving a
  reference between files must change its identity, or two different bodies collide.
- **Put the repo-local registry at `graph/skills.graph.json`.** That is the source-checkout
  layout and would make a repository's own catalogue indistinguishable from a vendored
  checkout's. `.simt/` is where adopted state lives.
- **Key the workspace cache on mtime.** Two edits inside one filesystem timestamp tick are
  exactly the case that produced the stale answer; these files are small enough to hash.
