---
simt-affects: ["src/commands/index.mjs", "src/commands/spec.mjs", "test/argv-repeat.test.mjs"]
simt-supersedes: []
---

# ADR-123 — a surplus positional is not refused, because a command's arity is not in its source

Status: **accepted** · 2026-10-31

## Context

Review 0003 Q62 asked dispatch to validate a command's positionals the way it validates
its flags, and the cheapest place to read the maximum looked like the module that
receives `args`: a command that reads `args[0]` takes one, a command that reads nothing
takes none, and a command that joins or spreads `args` has no maximum at all.

Measured against the tree, that rule is wrong for five of the 76 rows. `init`, `tokens`,
`explain`, `graph lint` and `bench report` all accept a positional that their own module
does not index — it is forwarded to a helper in another module, or deliberately ignored.
Enforcing the derived maximum failed 27 tests, 11 of them on `init` alone (`init` a path
is the command's most ordinary call). The source tells you where an argument is *read*;
it does not tell you what the command *accepts*, and for the five commands whose reading
happens elsewhere the two answers differ.

## Ruling

### 1. Dispatch does not enforce a maximum number of positionals

Dispatch enforces what a spec row can state truthfully: the flags a command reads, the values a closed set accepts, and that a single-valued flag is given once. It does not enforce a positional maximum, and a surplus positional is accepted exactly as it was before the rule was attempted.

### 2. A command that refuses a surplus positional says so itself, in its own words



### 3. The withdrawn arity is recorded here rather than carried as a spec field



## Consequences

- Q62's surplus-positional clause is withdrawn. The arity it would have needed (29 rows
  with a maximum, 47 unbounded) is not shipped, and no row carries an `args` field.
- `test/argv-repeat.test.mjs` keeps the refusal of a repeated flag and the closed set;
  the surplus-positional test is gone with the rule that would have made it pass.
- The source-reading heuristic is recorded here rather than kept in a comment, because
  the next agent to read Q62 will propose it again, and it will fail the same 27 tests.

## Rejected

- **Reading arity from the module, as written.** A command's accepted positionals are a
  contract, and the source is an implementation of it; `init` proves they diverge. A
  check that refuses `init <path>` is worse than the silence it replaces.
- **Declaring arity by hand for all 76 rows.** A number nobody derives and no caller
  checks drifts silently, and a wrong maximum refuses a real call — the same failure,
  arriving a release later and without a test to find it.
- **Making every surplus positional an error.** The forwarding commands would need a
  per-command exception list, which is the manual declaration above with extra steps.
