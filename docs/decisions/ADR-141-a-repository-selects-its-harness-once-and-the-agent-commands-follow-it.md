---
simt-affects: ["src/agents/scope.mjs", "src/agents/render.mjs", "src/commands/agent.mjs", "src/commands/agenthook.mjs", "src/commands/init.mjs", "test/agents.test.mjs", "test/agenthooks.test.mjs", "test/init-harness.test.mjs"]
simt-supersedes: []
---
# ADR-141 — a repository selects its harness once, and the agent commands follow it

Status: accepted · 2026-11-02

## Context

`init` wrote the agent file and the hooks entry into every harness this tool renders, and
so did `agents install` and `agent-hooks install`. Six files landed in every adopted
repository, four of them never opened, and each install compared all six so that four could
report "unchanged". A repository that adopted the tool for one editor got the other five as
a side effect of adopting anything at all.

`--harness` already existed on each of those commands, but it was a per-run filter: the
repository had no way to say which harness it is, so every run without the flag reverted to
"all of them".

## Rulings

1. **Adoption is where the harness is chosen.** `init --harness <id>` projects the rules to
   that surface, writes that reader's agent file and hooks entry, and records the id in the
   manifest's `surfaces`. `--harness cursor` and `--surfaces cursor` are the same statement
   about the adoption, and the manifest carries one list.

2. **An adoption that names no harness selects none.** No agent file, no hooks entry, and no
   `surfaces` key in the manifest — the rules still project to the global standard, and the
   plan prints the flag and the ids it accepts. Writing every harness was the default this
   record removes.

3. **The agent commands read the declaration.** Without `--harness`, `agents install`,
   `agents status`, `agent-hooks install` and `agent-hooks status` take the harness set from
   the manifest's `surfaces`. `--harness` overrides it for that run and is not persisted.

4. **Nothing selected is a no-op with two remedies, not an error.** A repository with an
   empty or absent `surfaces` is doing nothing wrong; the command writes nothing, exits 0,
   and says how to fix it: declare a surface, or pass the flag. The status output reports
   the scope it read, so a reader cannot mistake "not selected" for "not installed".

5. **A declared surface with no agent file is filtered, not refused.** Some readers document
   no agents directory. Declaring one is a statement about the rules, not a demand that the
   agent be written somewhere it has no home.

## Consequences

- A fresh adoption writes one agent file and one hooks entry instead of six of each, and
  every later install compares one file rather than six.
- The manifest gains a key that is a choice rather than a derived fact, so a re-init keeps
  it: the surfaces condition already preserves an existing array.
- A repository adopted before this record keeps its files; the next install without a flag
  has nothing selected, so it reports the remedy rather than rewriting them. Adding the
  `surfaces` key restores the old behaviour deliberately.
