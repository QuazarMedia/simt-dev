---
simt-affects: ["src/agenthooks/policy.mjs", "test/agenthooks-audit.test.mjs"]
simt-supersedes: []
---

# ADR-195 — the hooks-disable policy reads its own text when the shell cannot

Status: **accepted** · 2026-11-05

## Context

ADR-104 ruling 3 gave `hooks-disable` no regex fallback, because the row did not
exist before that ruling and an unparseable command was to be judged exactly as
it had been judged before. Review 0004 (A23) measured the consequence: an
unbalanced quote wrapped around `git config core.hooksPath` makes the tokenizer
fail, no git fact is produced, and the row never sees the act. The other two
command rows kept a regex on that path, so the one act that removes the gates
was the one act a parse failure could hide.

## Rulings

1. **The row carries a conservative fallback.** When the command cannot be
   tokenised, `hooks-disable` matches its own text for the two spellings of the
   act: the config key `core.hooksPath` (case-insensitive, as git reads it) and
   the hooks directory this tool writes, `.simt/hooks`.
2. **Nothing else is added to the fallback.** An unparseable command that names
   neither stays allowed, which is the position ADR-104 left it in. The fallback
   is evidence for this row, not a general licence to pattern-match shell text.

## Consequences

- A command that removes or reroutes the hooks no longer escapes by failing to
  parse; the denial carries the same `hooks-disable` id and message as the
  parsed path.
- Ruling 3 of ADR-104 is narrowed for this row and remains in force for the
  rest: a text that names neither the key nor the directory is not denied.
- The fallback is case-insensitive but literal; it does not attempt to read
  quotes, flags or shells, because the tokenizer already owns that job when it
  succeeds.

## Rejected

- **No fallback at all.** Rejected: it leaves the one act the tokenizer cannot
  reach unguarded, which is the defect this record answers.
- **A broad `git config` regex.** Rejected: it would deny every config command
  on a parse failure, including ones that never touch the hooks.
