---
simt-affects: ["src/agenthooks/shell.mjs", "src/agenthooks/policy.mjs", "src/agenthooks/decide.mjs"]
simt-supersedes: []
---

# ADR-104 — the pre-tool-use policy reads the command the way a shell reads it

Status: **accepted** · 2026-10-28

## Context

The two command policies — push (ADR-001) and rewrite (ADR-017) — matched the
payload's command string with a regular expression. Review 0003 (Q01) verified
against the shipped binary that an agent routes around both of them: `git -C .
push`, `git --no-pager push`, `sh -c 'git push'`, `$(git push)`, `(git push)`,
`git push;echo ok`, the alias `git p`, `git send-pack`, `git commit -n`,
`--amen`, `--no-verif`, `git reset --har`, `git -C . commit --amend`,
`git pull --rebase`, and with `SIMT_ALLOW=push`, `git push -fu` and
`git push origin +main`. Three acts no policy named at all: `git -c
core.hooksPath=/dev/null commit`, `git config core.hooksPath …` and
`rm -rf .simt-hooks` — the repository's gates going away without a policy ever
seeing them. And two false positives: `echo --no-verify` and `grep -r "git
rebase" docs` were denied because a flag or a phrase sat in a command that was
not git.

Every bypass is the same act spelled another way, and a policy that reads text
cannot tell them apart. The decision is made on the act.

## Ruling

1. **The command is normalised before a policy matches it.**
   `src/agenthooks/shell.mjs` tokenises the command the way POSIX sh tokenises
   it — quotes, escapes, `; && || | &`, newlines, subshells, `$()` and
   backticks — descends into the wrappers a shell executes for you (`sh|bash|
   zsh|dash -c`, `eval`, `env`, `command`, `exec`, `xargs`, `nice`, `time`,
   `sudo`), and reduces every git invocation to the fact a policy can read:
   which subcommand, with which options, in which repository. Long options are
   resolved by git's unique-prefix rule (`--amen` is `--amend`), short clusters
   are expanded (`-fu` is `-f -u`), and a leading `+` on a refspec is force.
   The policies match that fact, not the text.
2. **A command the tokenizer cannot read is judged by the row's regex, never by
   nothing.** Unbalanced quotes and an unclosed `$()` mark the command as
   unparseable, and the pre-normaliser regex runs on it, so a parse failure
   weakens nothing. Facts that were never normalised — a test that hands
   `decide` a bare command string — take the same path. The push and rewrite
   ids and messages are unchanged, so an adopted repository reads the same
   denial it read before.
3. **A third command policy, `hooks-disable`, names the act the other two
   cannot:** removing or rerouting the git hooks a repository's gates run in —
   `git -c core.hooksPath=…`, `git config … core.hooksPath`, and `rm` of the
   hooks directory. It carries no regex fallback because it did not exist
   before this ruling: a command that cannot be tokenised is judged exactly as
   it was judged before the row was written.
4. **The author's aliases are resolved with one `git config --get-regexp
   '^alias\.'` per command, and only when a fact's subcommand is not one git
   ships.** A value that starts with `!` is a shell command and is read the
   way any other command string is; an alias that resolves to nothing the
   table can read is left as-is, which is the same position the pre-lookup
   policy found it in. A git that is missing or cannot answer yields no
   aliases, and the facts stand where the pre-lookup policy would have left
   them.

## Consequences

- The false positives go with the text: `echo --no-verify` and `grep -r "git
  rebase" docs` carry no git fact, so the rewrite policy does not fire on
  them.
- Every force spelling — `--force`, `-f` in a cluster, `+refspec` — is both a
  push and a rewrite, so lifting `push` no longer carries a force-push
  through, in any of the spellings the regex let past.
- The decision stays pure and fast: normalisation is a fact-gathering step in
  `factsFor`, and `decide` reads facts. The latency test, which measures
  `decide` over prebuilt facts, is unchanged.
- A command that names only builtin subcommands pays nothing for the lookup;
  one that names an alias pays a single `git config` spawn with a one-second
  ceiling.
