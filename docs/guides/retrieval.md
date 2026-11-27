# Inspect retrieval, impact and repository policy

Run these commands from the receiving repository. Use paths and export names
from that repository. Prepare the local index before using retrieval v2 or v3 in
a prompt hook or MCP brief.

```sh
simt index
```

`simt index` builds the local v7 SQLite cache (`v3` is the default query mode;
`--retrieval v1`, `--retrieval v2`, and `--retrieval v3` all run on the same
index with no rebuild required).

## Brief a prompt with several tasks

Write a clause for each intended change. Include a path or symbol when you
know it, and state which files the change must leave alone. The following
example uses `source_path` for a file already tracked in the repository.

```sh
simt brief "Fix the calculation in $source_path and add a regression test for it"
simt brief "Fix the calculation in $source_path and add a regression test for it" --subtask 2
simt map --task "Find the calculation that applies the current rate" --explain
```

Use the numbered subtasks in the first packet to select a detailed brief.
Default retrieval (`v3`) combines commit-history FTS, repository-mined concept
expansion, post-retrieval QPP channel weighting, construct SDM (`invocations` and
`string_literals`), HITS authority walks, and bound symbol-scope line spans
(`path:L1-L2 sym`) on files longer than 200 lines. `map --explain` prints the
ranking channels, feedback expansion terms, and QPP diagnostics.

Optional `simt brief` flags work across modes:

- `--scopes`: emit bound symbol-scope line spans (`path:L1-L2 sym`) for files
  over 200 lines (enabled automatically by default under `v3`).
- `--nash`: enable Nash Social Welfare fair packing across subtasks and facets.
- `--seen <paths|ledger>`: down-weight unchanged items already delivered in a
  prior turn; edited files reset to full weight automatically.

Use `--retrieval v2` or `--retrieval v1` to restore v2 or legacy v1 ranking on
the same index. Prompt hooks default to `v3` when `"brief": {}` is configured
in `simt.json`, and honour `"brief": { "retrieval": "v2" | "v1" }` for rollback
(plus `"brief": { "seen": true }` for session anti-redundancy). MCP `brief`
accepts `retrieval`, `scopes`, `nash`, and `seen` without mutating any session
ledger on disk.

## Trace a source edit and select tests

Use a qualified export to distinguish it from another export of the same
name. Set `source_path` to a tracked file and `export_name` to one of its exports.

```sh
simt impact "$source_path#$export_name" --json
simt impact --changed --json
simt gate --changed --precise
```

The impact report distinguishes observed callers, tests, historical co-change
and conceptual similarity. Its fallback field indicates where the query
needed file-level evidence. Gate precision is opt-in. Use
`simt gate --changed --conservative` to select the full file import closure.

## Read why a file is governed

```sh
simt why "$source_path" --json
simt why --changed
```

Read the current items and their witnesses before applying a ruling.
Historical items carry the commit that mentioned the decision.
`simt why "$source_path" --retrieval v1` returns the legacy path answer.

## Enforce an import direction

Add a local profile at `.simt/profiles/architecture.md` with this content.

```markdown
---
simt-id: architecture
simt-title: Architecture
simt-applies: always
simt-priority: hard
---

- Follow the dependency direction declared in simt.json. <!-- simt-check: import-direction -->
```

In `simt.json`, add an `architecture` declaration. The example below uses
application and storage paths. Substitute globs matching the receiving
repository's modules.

```json
{
  "architecture": {
    "layers": [
      { "id": "application", "paths": ["src/application/**"], "mayImport": ["storage"] },
      { "id": "storage", "paths": ["src/storage/**"], "mayImport": [] }
    ],
    "forbid": [
      {
        "from": "src/storage/**",
        "to": "src/application/**",
        "transitive": true,
        "reason": "Storage must work without the application"
      }
    ]
  }
}
```

```sh
simt sync --yes
simt check
simt check --changed
simt explain import-direction-violation
```

Run the full check after changing the policy. For code edits, `--changed`
limits source and graph findings to changed paths and direct import neighbors
while still validating the manifest and projected regions. A violation shows
the shortest dependency witness and includes the originating import location
when available.

Optional settings under `limits.graph` enable cycles, broken relative imports,
dead-export review, and fan-in or fan-out warnings. Use `cycles: true` or
`cycles: { "exclude": [...] }`, `brokenImports: true`, `deadExports: true`,
`maxFanIn` and `maxFanOut`. Dead-export review needs entrypoints in
`limits.graph.entrypoints` or package exports, plus sufficient language
binding coverage. Remove the policy or an individual setting to disable its
check. Run `simt explain <code>` with a code from the report to see the remedy.
