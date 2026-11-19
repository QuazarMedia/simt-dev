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
| `test.runner` | repo | how this repository runs a selected set of test files |
| `$comment` | tool | a free note, string or list |

A key that this tool does not know is reported, not silently carried: `simt check` and
`simt doctor` name it as `manifest-unknown-key`, which is a warning rather than a failure. A key
that starts with `x-` is yours on purpose: it is the extension namespace, it is never reported,
and it survives every write `init`, `sync` and `upgrade` make. `simt doctor` prints the manifest
keys this version reads, which is the answer to "why was my setting ignored".

## Scoped gate ids

Two ecosystems in one repository both need a `test`. A gate id carrying `@` names a scope:
`test@go` runs `gates.commands["test@go"]`, while `test` keeps running the Node script. `init`
writes the scoped form when a second ecosystem proposes a name that is already taken, so a
polyglot repository carries `test` and `test@go` and both run. A scoped id with no command of
its own is unrunnable — `check` says so instead of falling back to the unscoped command, which
would report a pass for a suite that never ran. Write the name in `gates.preCommit` or
`gates.prePush` like any other, and `gates.cwd["test@go"]` scopes its directory.

## The focused test runner

`simt gate` asks a package's own manifest which runner it uses. When no detector knows the
stack, or the detector would run the wrong thing, `test.runner` names the command instead:

```json
{
  "test": {
    "runner": {
      "command": ["uv", "run", "pytest", "--junitxml={report}"],
      "report": "junit",
      "reportPath": ".simt/junit.xml",
      "requires": ["uv"]
    }
  }
}
```

- `command` is an argv list, never a shell string. `{files}` expands to the selected files as
  separate arguments; without it they are appended. `{package}` is the package directory
  relative to the repository and `{root}` the worktree, so one declaration serves a monorepo.
- `report` is `none` (the default: stdout is the report), `tap`, `json` or `junit`. A `junit`
  declaration also names `reportPath`, which must stay inside the package; pass it to the
  runner with `{report}` in the flag that runner uses. This tool never invents a flag.
- `requires` lists executables that must be on `PATH`. A missing one is reported as
  `unsupported` before anything spawns, instead of arriving as exit 1 like a failing test.
- `cwd` is an optional directory relative to the package.

An invalid declaration is `manifest-invalid`: `check`, `doctor` and `gate` name the field and
the shape it needs, and the gate exits without running. A repository that omits `test.runner`
keeps the built-in chain (Vitest, Jest, `node --test`, Cargo, Go, pytest, Gradle, Maven).

## When a value is wrong

The schema names a known key with an impossible value as `manifest-invalid`, and that finding
fails `check`, `doctor` and the `check`/`doctor` MCP tools. `hooks run` fails the same way with
a `config` gate rather than reporting "nothing runs", and `status` reports the repository as
not ok. The distinction the loader keeps is the one a reader needs:

| State | `exists` | `manifest` | `problems` |
| --- | --- | --- | --- |
| absent | `false` | `null` | `[]` |
| unreadable (permissions, a directory in its place) | `true` | `null` | names the error |
| malformed (does not parse, is not an object) | `true` | `null` | names the error |
| invalid (parses, a known key has an impossible value) | `true` | the object | names each value |
| a newer schema version | `true` | the object | names the version |

An explicit empty gate list is a valid declaration: `"preCommit": []` says this repository
declares no pre-commit gate, and every command treats it as that rather than as a missing key.
