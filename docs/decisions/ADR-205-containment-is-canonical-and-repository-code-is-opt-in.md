---
simt-affects: ["src/trust/paths.mjs", "src/trust/policy.mjs", "src/journal.mjs", "src/resolve/source.mjs", "src/index/store.mjs", "src/federation/config.mjs", "src/manifest/schema.mjs", "src/commands/repoindex.mjs", "test/trust-paths.test.mjs", "docs/reference/agent-hooks.md", "docs/reference/manifest.md"]
simt-supersedes: []
---
# ADR-205 — containment is canonical, and a repository's code is opt-in twice

Status: accepted · 2026-11-21 · filed as review 0005 PR26

## Context

Four boundaries accepted a path or a module name that a repository (or a registry it
carried) supplied, and each answered "is this ours?" by comparing strings:

- `src/journal.mjs` refused any path where `relative(root, path).startsWith('..')` — five
  times, once per operation. That is a statement about spelling. `repo/link -> /etc` is
  inside the repository by that check, and the undo journal would write through it.
- `src/resolve/source.mjs` joined `workspaceRoot/repo/path` and `root/path` and measured
  whatever it found. A registry entry's `../` or a symlinked skill directory escaped the
  workspace without anyone deciding it should.
- `src/federation/config.mjs` gated a requested root against the server's cwd/workspace
  roots the same lexical way. A linked directory inside the ground passed, and the
  manifest found there named commands this tool would spawn.
- `src/index/store.mjs` loaded `manifest.index.parsers` with `createRequire(...)(name)`.
  That is arbitrary code execution requested by a checked-in JSON file, and the only
  thing standing between a clone and the `require` was that someone wrote the key.

Each boundary also had its own idea of what to do when the answer could not be computed,
and the answers differed. Meanwhile the agent-hook surface had no published statement of
what it enforces: a reader could not tell a policy that the hook blocks from one the
harness is free to ignore.

## Ruling

1. **Containment is answered by the filesystem.** `src/trust/paths.mjs` resolves a root
   and a target through `realpath`, and resolves a target that does not exist yet through
   its nearest existing ancestor — the part a link can redirect. Containment is
   `relative(resolvedRoot, resolvedTarget)` being empty or neither `..`-prefixed nor
   absolute. There is exactly one implementation; the journal, the skill lookup and
   federation call it. A path that cannot be resolved (EACCES, ELOOP) is **not** inside.

2. **The journal keeps its refusal wording and changes its question.** Every check is
   now `assertWithin`; the messages still read "... outside the repository", and the
   reason is appended when a link is what left. A refused operation records nothing, so
   a retry produces the same refusal and no half-entry.

3. **A registry source is measured only inside the base it was declared against.** A
   workspace source is checked against the workspace root, a repository source against the
   repository root. A candidate that escapes is not read at all; when every candidate is
   refused, the reason names the escaped path rather than claiming no file exists.

4. **Executable extensions are declared twice.** `index.parsers` names the module and
   `trust.execute` lists the specifiers the repository permits this tool to run, compared
   literally. `src/trust/policy.mjs` owns the shape; the adapter state is `refused` when
   the second declaration is missing or invalid, and the built-in extractors run instead.
   `simt repo index` prints why, and the refusal is part of the index's input digest, so
   changing the policy rebuilds.

5. **An unreadable policy is closed.** A `trust` block that is not an object, an
   `execute` that is not a list of non-empty strings, or an unknown key inside `trust` is
   a finding that refuses execution. Half a valid policy is not permission; a config the
   tool cannot read must not become consent.

6. **The federation ground is canonical too**, because its consequence is spawning the
   commands of a manifest that a link made appear inside the server's workspace. The
   user-level allowlist still decides which servers may be called; that is a person's
   decision, not a path's.

7. **The agent-hook assurance boundary is published, not implied**
   (`docs/reference/agent-hooks.md`): which harnesses and events are wired, which events
   decide and which only deliver, what a denial exits with per dialect, and what is not
   covered — a real harness binary is not driven by this suite, so vendor dialog
   behaviour is described from the adapter contracts rather than observed.

## Consequences

- A repository with `index.parsers` and no `trust.execute` loses its custom extractor
  until it opts in. That is the intended upgrade cost: the previous behaviour ran code a
  clone could add. `simt repo index` and `check` name the refusal and the fix.
- `trust` is a new repository-owned manifest key; `unknownKeys` now knows it, and the
  manifest reference lists it.
- The journal's check reads the filesystem, so a write into a directory that is being
  concurrently replaced by a link is still a TOCTOU race. The check closes the static
  case (a link committed in the tree, a registry entry that escapes), not a local attacker
  racing the tool; that attacker already has the repository.
- `federationAccess` is no longer pure in the "reads nothing" sense — it resolves paths.
  Its signature and decision table are unchanged.
- `withinSync` exists for callers whose signature is synchronous (`recordCreatedFile`,
  the federation gate); a caller with no such constraint uses the async form.

## Alternatives

- **Keep lexical checks and reject every symlink in a path.** Refuses legitimate
  workspace links (a worktree checked out elsewhere, a skill directory linked into a
  workspace) and still misses `..` combined with links. Canonical resolution answers the
  actual question instead of banning a mechanism.
- **A repository-level path allowlist.** Names the paths someone already thought of;
  a crafted registry entry names a new one. The base the declaration was made against is
  the boundary that exists without configuration.
- **Turn `index.parsers` off entirely.** Removes a supported extension point to avoid
  asking a repository to confirm it. The double declaration keeps the extension point and
  makes the confirmation auditable in the manifest diff.
- **Treat a missing `trust` block as "the repository already trusted its own parser".**
  That is the current implicit behaviour with extra steps; it does not survive a clone.
