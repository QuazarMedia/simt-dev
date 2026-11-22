# Inspect retrieval, impact and repository policy

Run these commands from the receiving repository. Use paths and export names
from that repository. Prepare the local index before using v2 in a prompt
hook or MCP brief.

```sh
simt index --retrieval v2
```

## Brief a prompt with several tasks

Write a clause for each intended change. Include a path or symbol when you
know it, and state which files the change must leave alone. The following
example uses `source_path` for a file already tracked in the repository.

```sh
simt brief "Fix the calculation in $source_path and add a regression test for it" --retrieval v2
simt brief "Fix the calculation in $source_path and add a regression test for it" --retrieval v2 --subtask 2
simt map --task "Find the calculation that applies the current rate" --retrieval v2 --explain
```

Use the numbered subtasks in the first packet to select a detailed brief.
`map --explain` shows the ranking channels and any added feedback terms.
Use `--retrieval v1` to return to legacy ranking or packet selection with the
same index. Prompt hooks use v2 only when the repository sets
`brief.retrieval` to `"v2"` in `simt.json`.

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
