# Architecture overview

One process, no runtime dependencies, and a projection that a pull request can diff: that is
the shape everything below serves.

| Directory | What lives there |
| --- | --- |
| `src/commands/` | one module per command, the spec that declares every path, and the dispatch table |
| `src/projection/` | the generated-region markers, rule selection, the manifest, baselines, conflict scanning |
| `src/resolve/` | the scoring that selects rules from facts, with no model and no network |
| `src/manifest/` | the `simt.json` schema: keys, owners, checks |
| `src/gates/`, `src/hooks/`, `src/agenthooks/` | the two gates: the git-time dispatcher and the before-a-tool-call policy |
| `src/index/` | the local code graph: git blobs, symbols, edges, FTS5, optional vectors |
| `src/brief/`, `src/knowledge/`, `src/skills` (`graph/`) | the packet: what an agent reads before it explores |
| `src/plan/`, `src/write/`, `src/journal.mjs` | trackers, the one write decision, and the undo journal |
| `src/mcp/` | the read-only JSON-RPC surface over the same functions |
| `src/measure/`, `src/compare/`, `src/bench` (`testing/`) | the instruments: tokens, contexts, recall, benches |
| `src/memory/`, `src/state/` | lessons, the ledger, events and the local state directory |
| `src/packs/`, `src/distribute/`, `src/federation/`, `src/local/` | vendored packs, workspace distribution, external graphs, loopback models |
| `src/output/` | exit codes, JSON and text presentation, remedies |

Three rules keep it that shape:

- **Content is data; the engine is code.** An ecosystem or a stack arrives as a record and,
  where detection cannot see it, a `has-*` fact — never as a branch in the projection
  (ADR-013).
- **One write decision.** A writer states what a path will hold, what it holds now, who owns
  it and why; `applyPlan` journals and applies it, and `undo` reverses it.
- **Determinism is a feature.** The default path opens no socket and loads no model, so a pull
  request can diff the resolved rules rather than trust a summary.

See [pipeline.md](pipeline.md) for detection → selection → projection → gates,
[storage.md](storage.md) for what is written where, [testing.md](testing.md) for the suite,
and [release.md](release.md) for the channels.
