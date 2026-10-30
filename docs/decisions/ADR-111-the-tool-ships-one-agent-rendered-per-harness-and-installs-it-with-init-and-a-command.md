---
simt-affects: ["agents/simt-agent.md", "src/agents/render.mjs", "src/commands/agent.mjs", "src/commands/init.mjs", "src/projection/loaders.mjs", "src/toolwords.mjs", "test/agents.test.mjs"]
simt-supersedes: []
---

# ADR-111 — the tool ships one agent, rendered per harness, and installs it with init and a command

Status: **accepted** · 2026-10-30

## Context

The rules this tool projects tell an agent *what* to obey; nothing told it
*how to act* through the tool. The plan for that was two agents — a planner
and a builder — but the two jobs are one job in practice: read the tracker,
take the next slice, build it, test it, commit it. Two files that both say
"run the simt commands" are two copies of the same logic, and the second copy
is where the next divergence grows.

Six harnesses read a subagent and no two agree on the file. Five write a
markdown file with YAML frontmatter and a body that becomes the system
prompt; Codex writes a TOML file whose `developer_instructions` holds the
same body. The path, the extension, the frontmatter keys and the document
shape are all different, and none of them is the same fact.

A hooks entry is a config key the tool merges into a file it does not own.
An agent is a file the tool owns whole: there is nothing to merge, and the
only question is whether the bytes on disk are the bytes the tool would write
now.

## Ruling

1. **The tool ships one agent, `Simt-Agent`.** Its body is the system prompt
   and it encodes how to act with simt-dev across the whole slice lifecycle —
   orient (`simt brief`, `simt why`), plan (`simt plan status`, `simt plan
   next`), build (`simt slice start`, the focused test, `simt slice finish`,
   `simt plan done`) and the boundaries that hold everywhere. Planning and
   building are one agent because they are one job.
2. **The source of truth is one file, `agents/simt-agent.md`.** Neutral
   frontmatter (`name`, `description`) plus a harness-agnostic body. The
   renderer strips that frontmatter and re-emits the keys each harness
   documents, so the body — the part that says how to act — is written once
   and cannot drift between harnesses. The `simt-agent` stem is a name this
   tool owns, and it is derived into the tool-word set from the module that
   owns it, the way the other prefixed names are.
3. **An agent is a file the tool owns whole, so the install is a byte
   comparison.** `rendered` produces the text and reports `created`,
   `unchanged` or `updated`. There is no parse that can fail and no partial
   state, which is what makes the command shorter than `agent-hooks install`.
4. **It is installed per harness, and the readers it does not write are
   named.** Six harnesses document an agents file and receive one; the two
   that document none are reported `NO FILE` with the reason, the way
   ADR-079 ruling 11 requires. `--harness <id>` narrows the install to one
   reader and names the skipped ones (ADR-107), and `status` reports
   present, absent, drift, and the readers with no file.
5. **It is written by `simt init` and by a separate `simt agents install`.**
   `init` plans the agent files with the rest of the adoption and writes them
   in the apply path, journaled the same way, so `undo` restores them with the
   rest. The separate command exists for a repository that is already adopted
   and wants only the agent, and for a narrowed install. Both call the same
   `planAgents` and `writeAgentPlan`, so a dry run and a run describe the same
   set of files.

## Consequences

- A repository that is adopted and later upgrades the tool's agent body runs
  `simt agents install --yes` (or re-runs `init`) and the files come back
  `updated` with the new body; the frontmatter each harness documents is
  re-emitted from the same source, so it cannot drift.
- The agent body names only commands a consumer repository runs — `simt
  brief`, `simt why`, `simt plan`, `simt slice` — so every byte in it is
  actionable in the receiving repository, the rule this repository exists to
  enforce.
- `agents/` is published with the package: the tool reads its own agent body
  from the installed copy, and a tarball without it would install cleanly and
  then fail on the one command that writes the agent.
