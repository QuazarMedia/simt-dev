---
simt-affects: ["src/commands/init.mjs", "src/commands/map.mjs", "test/init.test.mjs", "test/map.test.mjs"]
simt-supersedes: []
---

# ADR-108 — an adoption builds the index, and a command that reads it refreshes it on read

Status: **accepted** · 2026-10-30

## Context

The index is a cache of git blobs (ADR-089): gitignored, rebuildable from
`git ls-files -s`, and the data source for `simt map`, `simt brief` and
`simt slice`. Two states of that cache were wrong for an adopted repository.

First, `simt init` adopted a repository and left the index unbuilt. The
first `simt map` in a fresh adoption paid for a walk of the whole tree, and
the prompt-submit hook delivered a cold index — "the index is empty" — until
somebody happened to run `simt index`. An adoption that promises the tool
works in that repository should leave it able to answer.

Second, once built, the cache went stale silently. `loadGraph` rebuilt only
when the index was *empty*, so a file added after the build was invisible to
every command that reads the index, with no way to tell from their output
that they were answering from an old tree.

## Ruling

1. **`init` builds the index in the apply phase**, after the manifest is
   written — `reindex` reads it for the declared parsers, so the manifest has
   to exist first. The plan names the file it will build, and the JSON
   document carries the result. A failure is a *note*, not a failed adoption:
   the index is a cache, and an adopted repository whose index build failed
   is better than one that refused to be adopted for it. The next read
   rebuilds what the apply could not.
2. **A command that reads the index refreshes it on read.** `loadGraph` with
   `build` (the default) reindexes from the git index before it reads. The
   refresh is incremental — a blob that has not changed is not re-read — so
   the cost of a current repository is one `git ls-files -s`, not a walk of
   the tree. The callers that build are commands a person typed: `map`,
   `brief`, `slice`.
3. **The `build: false` callers are unchanged.** The prompt-submit hook (R29)
   and the MCP surface report a cold index rather than build one: a delivered
   packet that walked the whole repository would make a person's first prompt
   in a fresh clone wait, and a prompt that takes a minute to appear is how a
   hook gets uninstalled.

## Consequences

- Amends ADR-091's consequence that "`simt map` reads the index and rebuilds
  it when the cache is empty": the refresh now happens on every read, not
  only on an empty one.
- In an adopted repository the prompt hook can deliver a packet from the
  *first* prompt: `init` has already built the index, so R29's "the first
  prompt gets nothing, the second gets the packet" no longer applies to a
  repository that was adopted rather than cloned.
- `simt why` is unchanged: it deliberately does not write the cache to answer
  a question, because writing a cache to answer a question would change the
  tree.
