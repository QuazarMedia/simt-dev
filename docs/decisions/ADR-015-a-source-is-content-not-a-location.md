# ADR-015 — A source is identified by its content; the repository is a location, not a precondition

Status: **accepted** · 2026-10-05
Affects: `resolve/source.mjs`, `skills install`, `skills show`, `skills brief`

## Context

[ADR-014](../decisions/ADR-014-workspace-is-configuration.md) made the workspace optional and
single-repo use first class. It fixed resolution, not lookup, and the next defect was found
immediately by the user who asked for the previous one.

Someone who cloned **only `simt-social`** has the `simt-social` body of `slice-commit` on disk at
`.agents/skills/slice-commit`. They have no workspace. The registry entry
`simt-social/.agents/skills/slice-commit` is satisfied by that file. Both commands refused:

```
$ simt-dev skills install slice-commit
ERROR 2 slice-commit has 2 variants and none matches this repo (node)

$ simt-dev skills show slice-commit
(body unavailable: this installation has no workspace, so slice-commit has no body to fetch; …)
```

The body was in the current directory for both.

The root cause is a definition that was never written down. `sources: [{repo, path, bytes, role}]`
resolves at exactly one place — `join(workspaceRoot, repo, path)`. There is a second place, and it is
not even exotic: **`<root>/<path>`**, because the repository being operated on is itself a location
for a declared source when the registry entry's `repo` is that repository.

The refusal was also wrong for a reason that had nothing to do with the workspace. `slice-commit`
has two variants, `web` and `api`, discriminated by stack tag. That clone's `package.json` emitted
`node`, which matches neither, so variant selection failed — while the clone's own 5048 bytes were
an exact answer sitting in the working tree. **The tool asked the manifest a question the manifest
could not answer, and ignored the evidence in front of it.**

## Ruling

### 1. A declared source is found by content, at every legal location

`resolve/source.mjs` exports `candidateLocations(source, {workspaceRoot, root})` — the workspace
location first, then the repo-relative location — and `locateSource(source, options)`, which accepts
a candidate **only when the measured size equals the declared size**.

Bytes are what make this safe rather than hopeful. Every source declares its size, and `graph lint`
already verifies every declared size against the file on disk. A candidate that exists at the right
path with the wrong size is not a degraded match; it is a different file, and it is rejected.

Two rules keep this from becoming a way to install the wrong body:

- **A workspace location wins over a repo location.** The canonical body beats the incidental copy.
- **Content decides identity, never location.**

### 2. What the repo already holds is a resolution signal, not a fallback

`sourceHeldLocally(skill, root)` is a first-class input to source selection, placed after explicit
flags and after the repo's stack signals, and ahead of refusing. `chooseSource`'s precedence is now:

1. `--from` — explicit. Obeyed even when it contradicts the repo's contents; the disagreement is a
   note, because the author is answering a question the tool cannot.
2. `--variant` — explicit, same treatment.
3. **The repo's signals name exactly one variant.** The normal path.
4. **The repo already holds exactly one declared source.** Its bytes are an exact answer, so this
   settles both an unmatched repo (step 3 found nothing) and an ambiguous one (step 3 found several).
5. Refuse — with the reason named.

Content beats taxonomy because a byte count cannot be a coincidence. A stack tag can.

### 3. A contradiction is a refusal; an ambiguity is a decision

Two rules that look similar and are not:

- **Signals name one variant and the repo holds another** → **refuse.** One of two inputs is wrong
  and the reader needs to know which; installing either silently picks a side.
- **Signals name several variants and the repo holds one of them** → **install that one**, because
  the repo's bytes are not a guess. Reported as `the repo's own copy decides`.

### 4. A file of the right shape and the wrong body gets its own message

`simt-dev skills install` reports `<path> exists but is not the declared body (5048 bytes declared)`.
The alternative message — "none of the variants matches this repo" — is true and useless: it sends
the reader to inspect their stack tags when the actual problem is the file in front of them.

### 5. `skills show` and `skills brief` read a repo-local body, and say which

`sourcePath` tries the canonical source first and falls back to what the repo holds.
`skills show` gained a `body <workspace|repo> <path>` line, because a reader who has two candidate
locations needs to know which one answered. `skills install` gained a matching `read` line.

An install that cannot read a body **fails**. `skills show` that cannot read one still answers,
because a catalogue plus a pointer is useful with no workspace at all. The asymmetry is deliberate
and is the same asymmetry as ADR-014's: degrade the read, never the write.

## Consequences

- A clone of any single repository is fully self-sufficient for `skills show`, `skills brief` and
  `skills install`, with no configuration at all.
- A repo holding two declared sources at once (`{ambiguous: true}`) is refused: the registry and the
  repo disagree, and neither is authoritative enough to break the tie.
- `graph lint` remains the thing that proves the registry still matches the world. It is unchanged,
  and it is the reason a byte comparison is trustworthy rather than optimistic.
- The `--from` and `--variant` escapes are load-bearing: they are now the only ways to override the
  repo's own contents, which is correct, because overriding the evidence should be deliberate.

## Rejected

- **Treat any existing path as a match.** A near-miss body would install silently, which is worse
  than refusing: the tool would have written a file it had not verified.
- **Ask for a workspace when the repo holds the body.** The workspace would then be required for the
  one case where it is provably unnecessary.
- **Select the variant from the repo's directory name.** `<root>/.agents/skills/slice-commit` says
  which skill it is, not which variant it is; only its bytes do.
- **Prefer the repo's copy over the workspace's.** A workspace checkout is the canonical body, and a
  symlink fan-out can make them the same file; preferring either silently would hide a divergence.
- **Make variant selection advisory everywhere.** "Signals say api, the repo holds web" would
  install one of them and print nothing, which is exactly the silent divergence variants exist to
  prevent.
