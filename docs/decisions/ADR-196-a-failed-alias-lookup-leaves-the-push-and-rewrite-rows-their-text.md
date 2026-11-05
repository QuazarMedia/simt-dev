---
simt-affects: ["src/agenthooks/decide.mjs", "test/agenthooks-audit.test.mjs"]
simt-supersedes: []
---

# ADR-196 — a failed alias lookup leaves the push and rewrite rows their text

Status: **accepted** · 2026-11-05

## Context

ADR-104 ruling 4 resolves an author's git aliases with one `git config --get-regexp
'^alias\.'` per command and treats a git that is missing or cannot answer as
yielding no aliases. Review 0004 (A24) measured what that means for a command
the tokenizer cannot finish expanding: `git p` with `alias.p=push` is read as
the subcommand `p`, matches no policy, and a push runs. The failure is silent,
and it fails open.

## Rulings

1. **A partial answer is still an answer.** `git config` writes as it reads, so
   a lookup killed by its one-second ceiling leaves the aliases it had already
   printed. Those are applied; the rest are not invented.
2. **A failed lookup is recorded on the facts.** `normalizeCommand` marks the
   shell facts `aliasLookupFailed` when the spawn could not complete. The push
   and rewrite rows then fall back to their existing regex, the same evidence a
   parse failure gives them (ADR-104 ruling 2).
3. **The fallback is not a ban on unknown subcommands.** A command whose text
   does not match the push or rewrite pattern is still allowed; a failed lookup
   is evidence that the expansion is incomplete, not that every command is a
   push.

## Consequences

- A `git p` whose alias was in the partial output is still denied as the push
  it is; one whose alias was not printed is indistinguishable from any other
  unknown subcommand and stays allowed, which is the pre-lookup position.
- `git status` and other builtins are unchanged: they never needed the lookup,
  and the fallback's regex does not name them.
- The lookup keeps its one-second ceiling and its one spawn per command.

## Rejected

- **Deny every command when the lookup fails.** Rejected: it turns a missing
  `git` into a blanket denial of ordinary work, and review 0004 explicitly asks
  that unknown subcommands stay allowed.
- **Treat a timeout as "no aliases" as before.** Rejected: that is the defect
  this record answers - the push was read as an unknown word and allowed.
