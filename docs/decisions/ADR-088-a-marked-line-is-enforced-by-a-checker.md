# ADR-088 — A marked line is enforced by a checker

Status: **accepted** · 2026-10-18 · filed as R19 (plan 0003) · ruling 3 narrowed by ADR-090

**Affects:** `src/kernel/checks.mjs`, `rules/core.md`, `src/commands/sync.mjs`,
`test/checks.test.mjs`

## Context

A line an agent is trusted to follow is a line the next agent can skip. The file-length
rule is already two numbers with two meanings, and the check that was supposed to apply
them was never run. The plan asks for a line to name a checker, for the projection to
keep the name, and for the checker to be what actually decides.

One of the named checkers, `import-direction`, needs a module graph this tool does not
have yet. Removing that instruction now would leave a name and no check.

## Rulings

1. **A list item may name one checker.** The marker is `simt-check`, on the item,
   including the lines wrapped under it. The checkers are `max-file-lines`,
   `forbid-regex`, `forbidden-path-edit`, `required-file`, and `import-direction`.
   Anything else is a broken rule. A marker inside a fenced sample is not a checker.

2. **A checker that can run replaces the item with its name.** The projection says
   `Enforced:` and the checker. The prose does not. `simt check` runs the checker
   against the rule as written, so the line that left the prompt is the line that
   still decides. `max-file-lines` reads `limits.fileLines`: over the trigger warns,
   over the ceiling fails. A path is exempt when `limits.fileLines.generated` names
   it, or when the file carries the generated-region marker this tool writes, which
   is this tool naming itself as the generator. The numbers stay 400 and 1000 where
   a repository has not named its own.

3. **`import-direction` does not replace its item.** The module graph it reads is not
   built. The instruction stays, the marker does not reach the reader, and `simt check`
   says the checker is not built. It does not fail the repository for that.

4. **A diff checker reads the change.** `forbid-regex` and `forbidden-path-edit` look
   at added lines and changed paths, including untracked files. A match already in the
   last commit is not a new match. A directory that is not a git repository is not a
   failure of these checkers: there is no tree to name.

## Consequences

The file-length sentence no longer occupies the region. The bytes it occupied are
smaller by the length of that sentence. Whether agents still comply with the rule is
unmeasured: the probes were not run.

`simt check` now fails a tracked file past the ceiling in every repository that
selects the core rules, which is every repository.

## Rejected

- **Dropping `import-direction` before it can run.** The name would say the line is
  enforced. Nothing would be enforcing it.
- **Failing `simt check` outside a git repository.** There is no tracked tree to count
  and no diff to read. A missing repository is not a long file.
- **Exempting a file because it looks generated.** The repository names the generator.
  A guess would hide the ceiling from the file that most needs it.
