# Plan 0009 — MCP servers declared like skills: registry, brief, status and install

Status: **in progress** · 2026-11-23

## Scope

External MCP servers get the treatment skills already have: declared as data, selected
deterministically per task, named in the brief packet — and the config that connects them
is checked and written per harness with the same machinery agent-hooks use.

1. **A registry, like `graph/skills.graph.json`.** `graph/mcp.json` declares the servers
   simt-dev knows: name, summary (when to connect), transport (stdio command or http url),
   capabilities. Hand-authored, reviewable, deterministic — the registry is data; the
   engine never infers structure.
2. **The brief names what a task needs.** A new `MCP` packet section selects servers by
   capability against the same inputs skill ranking consumes, and states the `simt mcp
   status` / `simt mcp install --yes` remedies. A server the task does not name is not
   offered; the section is absent, not empty.
3. **`simt mcp status` reports *configured*, entry-level.** Per selected harness it reads
   the project-scoped config at the `loader.mcp` facet path and compares each entry against
   what install renders (plan 0008 F03 pattern): `present/absent/drift/unreadable`, exit 0,
   remedy names `simt mcp install --yes`. It reports file facts only — never a runtime
   *enabled* claim; the vendor's own verify command is named instead (Claude: `claude mcp
   list`). A harness whose facet documents no project file (DeepSeek's plugin row) is
   reported, not written — the agent-hooks `other` state.
4. **`simt mcp install` writes project-scoped config.** It merges entries into each
   harness's own file, preserving repo-owned keys and their order; preview → `--yes`;
   `--harness` narrowing names the skipped ones (ADR-107 pattern). Codex's `config.toml`
   is handled by a zero-dependency TOML subset: tables this tool owns are read and written
   as structured data, every other line is preserved raw.

Genericity constraints — one fact, one home:

- The `loader.mcp` facet stays the sole source of config *location*. `src/mcpconfig/`
  adds only what the facet lacks: container key, entry shape, format.
- One entry-shape table serves both the status comparison and the install write — the
  `group()` pattern agent-hooks already use. A second copy of a vendor shape is a defect.
- Brief selection reuses `tokenize` and the rankSkills context shape; there is no second
  idea of what a task matches.
- The TOML subset lives in one module used by both the status read and the install write.

User-scope config (`~/.claude.json`, `~/.codex/config.toml`) is never written from a repo
context: status names it as configure-by-hand with the vendor command, because a repo
commit must not claim a mutation in a home directory.

## Tracker

| id | state | slice | evidence |
| --- | --- | --- | --- |
| M01 | queued | `graph/mcp.json` registry + loader + test | — |
| M02 | queued | brief `MCP` section (packet + assemble) + test | — |
| M03 | queued | `simt mcp status` (dialect table, TOML read, entry-level compare) + test | — |
| M04 | queued | `simt mcp install` (merge, TOML write, `--harness`) + test | — |
| M05 | queued | ADR + surface spec rows + docs; `simt check` clean | — |

## M01 — registry (`graph/mcp.json` + `src/mcpconfig/registry.mjs`)

`graph/mcp.json` carries `version`, `description` and a `servers` list: each entry has
`id`, `name`, `summary`, `transport` (`{ type: 'stdio', command, args }` or
`{ type: 'http', url }`) and `capabilities` (free tags the matcher scores against). The
first entry is simt-dev's own server — `node bin/simt.mjs mcp` over stdio — the one server
this estate knows end to end. `src/mcpconfig/registry.mjs` loads and validates it: a
shape violation is a named error with the offending entry, not a silent skip. Selection
helper in the same module: a server is offered when its capabilities intersect the task
tokens or the repo stack; a server with no capabilities is never auto-offered — it shows
in `simt mcp list`, not in every packet.

Acceptance: `node --test test/mcpconfig.test.mjs` green — the registry loads with the
`simt` entry, a capability match selects it, a task without overlap selects nothing, and
a broken shape names its error.

## M02 — brief `MCP` section

`SECTIONS` in `src/brief/packet.mjs` gains `MCP`, weighted below skills (a server pointer
is one command, like a skill pointer). `src/brief/assemble.mjs` gains the section: it
loads the registry through M01's loader, selects with its matcher on the same context
shape rankSkills receives (`repoStack`, `taskTokens`, `paths`), and adds one line per
offered server — name, summary, and the status/install remedies. A registry that fails to
load is a `CAUTIONS` line, not a failure, the way the skills section already treats it.
The MCP `briefPayload` tool validates `only` against `SECTIONS`, so the section is
reachable over the wire with no server change.

Acceptance: the brief suite green, including a new test — a task naming a capability
carries the `MCP` section with the remedy commands, and a task without overlap carries no
`MCP` lines.

## M03 — `simt mcp status`

`src/commands/mcp.mjs` dispatches `status` and `install` subcommands; bare `simt mcp`
still serves, so an existing editor config keeps working. `src/mcpconfig/dialects.mjs`
is the one table: per harness id, the container key (the facet's `key` where it carries
one, else the vendor default), the entry shape a transport renders to, and the format
(`json` or `toml`). `src/mcpconfig/toml.mjs` is the subset parser: table headers,
string/bool values and string arrays — enough to read the tables this tool owns, with
every other line preserved raw. Status walks the selected harnesses (the ADR-141 scope),
reads each facet path, and compares installed entries against the dialect render —
entry-level, F03 pattern. `problems` collects unreadable files only; drift and absence
are states, exit 0.

Acceptance: `node --test test/mcpconfig.test.mjs` green — a fresh repo reports every
selected harness absent with the install remedy; a current-shape entry reports present;
a stale-shape entry reports drift with the `simt mcp install --yes` remedy; a repo-owned
key beside ours is not drift; codex TOML round-trips.

## M04 — `simt mcp install`

Writes the registry's servers into each selected harness's project-scoped config: JSON
files merge with repo-owned keys and order preserved (the agenthooks `withHook` pattern);
codex TOML writes its tables through the M03 subset and leaves foreign lines raw.
Preview without `--yes`; `--harness` narrows and names the skipped readers; a config that
cannot be parsed is refused and named, and no other harness is written (the agenthooks
refusal behaviour). What it never touches: user-scope files, and the DeepSeek plugin row,
which is reported with its vendor command.

Acceptance: `node --test test/mcpconfig.test.mjs` green — install writes the `simt`
server into each selected harness's file; a second install is unchanged; a repo-owned key
survives with its order; `--harness` writes one and names the rest skipped; a broken
config is refused without writing another harness.

## M05 — ADR, surface rows, docs

The ADR records the rulings: project-scope-only writes; configured-vs-enabled honesty
(status claims file facts and names the vendor verify command); the registry's shape
contract; the TOML subset's boundary (tables owned, lines preserved). `src/surface.mjs`
gains the `mcp status` / `mcp install` rows so the spec names them; `simt sync --yes`
re-renders `docs/commands/`; the simt-commands skill maps the scenario.

Acceptance: `simt check` clean; `docs/commands/mcp.md` renders the new subcommands; the
ADR carries a Status line.
