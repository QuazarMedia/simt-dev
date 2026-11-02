# What it writes

| Path | What |
| --- | --- |
| `AGENTS.md` (and `<package>/AGENTS.md` in monorepos) | the projection, between `<!-- simt:begin -->` and `<!-- simt:end -->`. The old `simt-dev:` markers are still read, and a region migrates on its next write |
| `simt.json` | the manifest: `gates`, `substitutions`, `budget`, `mode`, `shared`, `surfaces`, `plans`, `packs`, `federation`, `local` |
| `simt.lock.json` | the digest of the inputs, the digest of the projection, and locked `variants` winners an earlier selection run recorded; the runner is retired, and a locked entry is still honoured. The old `simt-dev.lock.json` is still read, and a lock migrates on its next write |
| `.cursor/rules/*.mdc`, `.claude/rules/*.md`, `.agents/rules/*.md`, `.github/instructions/*.instructions.md` | one file per rule, and only for a harness that reads that directory |
| `.editorconfig`, `.gitattributes` | baseline regions, maintained for a repository that carries them; `--baselines` writes them into one that does not. Placed first so a later setting still wins |
| `.simt/hooks/` and `core.hooksPath` | the shared dispatcher. It fails closed |
| `docs/decisions/ADR-NNN-<slug>.md` | numbered decision records scaffolded by `simt decide --yes` with `simt-affects` and `simt-supersedes` frontmatter |
| `docs/lessons/NNNN-<slug>.md` | reviewed lessons promoted by `simt lessons review <id> --yes` with `simt-trigger`, `simt-evidence`, and `simt-expires` frontmatter |
| `docs/commands/` | the command reference, rendered by `simt docs commands --yes` from the spec. A stale page is a failing test, not a stale page |

Text outside the markers is left alone. A regeneration does not revert it.

`simt.json` also carries a `federation` block when the repository names external code-graph
servers, each with the command that starts it, and an optional `local` block when the
repository names loopback OpenAI-compatible `chat` or `embed` endpoints. A brief may then
ask a federated server one structural question for a task and cite the answer's source, and
the MCP `federation_query` tool asks one on demand, naming the server it asked. The question
goes to the tool and argument the manifest declared, so no foreign tool is reachable that
the repository did not name. Nothing is started and no socket is opened unless the manifest
declared it, and a server that does not answer costs the packet a sentence, never the
packet.

`simt shared install --yes` writes a user-level copy of the rules a workspace repeats, into
the file that harness documents, and records the ids on each repository's manifest. The next
`sync` drops those rules from the region and names them.

## Caches

These are gitignored, and rebuildable. They are not repository content:

| Path | What |
| --- | --- |
| `.simt/index.sqlite` | files, symbols, import/call/test/governs/cochange edges, FTS5 `fts` tokens across `code`, `docs`, `skills`, `decisions` and `lessons`, and optional `embeddings` vector blobs. One format: a Node too old for `node:sqlite` with FTS5 is refused by name, not given a second file to read |
| `.simt/ledger.jsonl` | one line per gate or test the dispatcher actually ran, against one git tree, plus normalised failure signatures |
| `.simt/lessons.jsonl` | deterministic lesson candidates captured from fail-to-fix pairs, reverts, `BLOCK` reviews, and hook denials |
| `.simt/bench/` | mined tasks (`tasks/`), test patch vault (`vault/`), and benchmark runs (`runs/`) |
| `.simt/proposals/` | non-authoritative skill description proposals with `{model, promptHash, digest}` provenance |
