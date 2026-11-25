---
name: harness-records
description: "How to write a harness record for .simt/harnesses/: the facet fields and their views, the invariants, and the vendor-doc process for getting dialect values right."
---

## What a record is

One JSON file per harness: `harnesses/<id>.json` shipped in simt-dev, or
`.simt/harnesses/<id>.json` in the repository. A repository-local record onboards
a harness for one repo; a record in `harnesses/` onboards it for everyone.

- `id` must equal the file stem. A mismatch is a record pointing at the wrong harness.
- Records are sparse: a facet is present only when the vendor documents one. Absence
  is a fact — the views filter, they do not fill. Declare only what the vendor
  documents, and declare every facet it documents.
- Every claim-carrying facet carries `verified`, citing the vendor document and what
  it was read as confirming. A facet without a source is a guess in the table.
- The order fields (`surfaceOrder`, `loaderOrder`, `pointerOrder`, `pluginOrder`)
  set the view iteration order; a new harness takes a number past the current max.

## Local override semantics

`.simt/harnesses/` merges over the shipped set: a same-`id` record is a shallow
merge (arrays replaced whole, omitted keys keep the shipped value), a new `id` is
appended, and a record that does not parse is skipped, never a crash. With a root,
every view reads the merged set — `simt mcp install`, `simt harness detect`,
`simt agent-hooks status`, `simt agents status`, projection and measure.

## Facets — declare only what the vendor documents

| Facet | Drives | Fields |
|---|---|---|
| `surface` | Rule projection: where a rule file lands and how the reader reads it | `label`, `readers`, `primary` (the primary file's name), `kind` (`region` \| `file` \| `pointer`), `rule` (a path template with `{name}`; null when the reader loads the primary file), `readsAgentsMd` (`all` \| `some` \| `none`, with a note when not `all`), `configDirs` (directories whose presence detects the harness), `documentedKeys` (the frontmatter keys the vendor documents), `skills` plus provenance for a documented skill directory, `readLimits` (per-reader byte caps, each with its own `verified`), `verified` |
| `pointer` | A symlink to the primary, for a reader that reads a fixed name | `id`, `surface`, `path` (the symlink name), `to` (usually `AGENTS.md`), `readers`, `verified`, optional `note` |
| `loader` | The reader row: how the rules concatenate, and where MCP and hooks configs live | `label`, `readers`, `start` (array: `scope` (`project`\|`user`), `path` or `dir`+`suffix`, `tree` (`chain`\|`file`), `frontmatter`, `atStart`, `why` per entry), `order`, `cap` (+`capNote`), `skills` (documented skill dirs), `hooks: { path, verified }` (where the hooks file lives), `mcp: { path, key, verified }` (where MCP servers are read; `key` null when the whole file is the server map), `verified` |
| `scopeKey: true` | Only when the vendor documents a scoping frontmatter key for the surface | boolean at record top level |
| `hooks` | The hook dialect: how a decision is shaped for this harness | `event`, `matcher`, `denyExit` (the exit code that denies), `allow`/`deny` decision templates, `prompt`/`post` for prompt events, `verified` |
| `payload` | The extraction contract: how a hook payload names its tool, input and writes | `toolKey`, `inputKey`, `rootKeys` (path segments to the working dir), `shellTools` + `commandKey` for shell commands, `writeTools`/`pathKeys`/`pathOverrides` when writes are keyed, `toolNameKey` only for a nested shape |
| `plugin` | The package `simt plugin build` builds for this harness | `rootVar`, `projectVar`, `hooksPath`, `runtimeDir` |

The shipped records are the canonical examples: `claude.json` carries all seven
facets; `cursor.json` has surface, loader, hooks and plugin; `copilot.json` has
surface and loader only; `deepseek.json` has a reader row and nothing else.
Read one before writing your own.

## The vendor-doc process — four questions

Write the record from the vendor's docs, in this order, and let each answer land
in the facet that carries it, with that facet's own `verified`:

1. **Where does it read MCP servers?** The path, and the JSON `key` under which
   they live → `loader.mcp`.
2. **How does it read the rules?** Does it read AGENTS.md at all? If not, what is
   the per-rule file format — path template and the frontmatter keys it documents
   → `surface` (and `scopeKey: true` only for a key the docs name).
3. **What are its hook events, and what shape is a payload?** Event name, how the
   tool is named, how input and writes are keyed, the decision shape, and which
   exit code denies → `hooks` + `payload`. This is the part that fails silently
   when guessed: a payload whose tool name is extracted under the wrong key is
   mediated by a deny that never fires.
4. **Does it document a skill directory?** → `loader.skills` (and the `surface`'s
   `skills` cell when the surface owns it).

## Verify after writing

Run the views from the repository root, and each declared facet must be named by
one of them:

- `simt harness detect` — the row appears with a channel.
- `simt mcp status` — the `loader.mcp` path is read.
- `simt agent-hooks status` — the hooks dialect is installed and read.
- `simt agents status` — the reader row is present.

A view run without a root sees the shipped set alone: a check that passes without
a root is not reading your record.
