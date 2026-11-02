# `simt.json` — the manifest

One file per repository, owned by the repository. `simt init` writes the first one; `sync`
and `upgrade` keep the generated keys current and never touch a key the repository owns.
`src/manifest/schema.mjs` is the authority: it holds the key list, each key's owner, and the
check that decides whether a value is valid.

| Key | Owner | What it decides |
| --- | --- | --- |
| `id` | tool | the repository's name in a workspace |
| `version` | tool | the manifest schema version |
| `stack` | tool | the profiles selected by detection |
| `surfaces` | repo | which harnesses get per-rule files (`[]` folds everything into the region) |
| `projection` | repo | where the region goes (`place: "top"`), and the read cap it must fit |
| `limits.fileLines` | repo | the `{warn, error}` pair a rule line enforces |
| `limits.coverage` | repo | the coverage percentage a rule line enforces, or `null` |
| `gates` | repo | the commands the dispatcher runs at each git and agent event |
| `budget.bytes` | repo | the ceiling the always-on projection is measured against |
| `mode` | repo | `full`, or `kernel` to defer convention and style rules |
| `plans` | repo | the tracker-template overlay `plan` compiles |
| `substitutions` | repo | per-rule placeholders, keyed by rule id |
| `profiles` | repo | local profile ids under `.simt/profiles/` |
| `localSkills` | repo | skills installed from this repository |
| `packs` | repo | vendored rule packs, pinned by digest |
| `workspace` | repo | the workspace root, when this repository declares one |
| `shared` | repo | rules carried at user level, recorded by `shared install` |
| `decisions` | repo | the decision-corpus settings |
| `federation` | repo | external code-graph MCP servers, each with its `command`, `args`, `tool`, `argument` |
| `local` | repo | loopback `chat`/`embed` endpoints, off until named |
| `$comment` | tool | a free note, string or list |

A key that this tool does not know is reported, not silently carried: `simt check` names it.
`simt doctor` prints the manifest keys this version reads, which is the answer to "why was my
setting ignored".
