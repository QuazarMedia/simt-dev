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
| `projection` | repo | where the region goes (`place: "top"`), and whether the install follows a source checkout (`follows: "source"`) |
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
| `trust` | repo | the module specifiers this repository lets the tool execute (`trust.execute`) |
| `work` | repo | what this repository produces, which directories own it, and how each part is validated |
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

## Following a source checkout

A repository that runs simt-dev from a live source checkout — a sibling clone, or
`SIMT_DEV_BIN` pointing at one — has no released copy to pin: the bytes that run are the
bytes a pin would name. `simt init --follow-source` records that fact once:

```json
{ "projection": { "follows": "source" } }
```

With the declaration, `projection.version` and `projection.simtDevSha` are neither written
nor compared: `check`, the hook dispatcher, `sync` and `upgrade` all read it, so a commit
to the checkout that leaves the rule text alone no longer makes every adopting repository
stale. The generated region is still checked and re-rendered by `simt sync --yes` when the
rule text changes, because that is a real change to the projected bytes, not a pin to
rewrite. `simt init --no-follow-source` returns the repository to a release pin, and
`init --yes` keeps the declaration it finds.

## Code the repository asks this tool to run

`index.parsers` names a module that the index imports, which runs whatever that module
does when it loads. A manifest is data a clone can carry, so the tool asks for a second
declaration before it runs the repository's code:

```json
{
  "index": { "parsers": "./tools/parser.mjs" },
  "trust": { "execute": ["./tools/parser.mjs"] }
}
```

`trust.execute` lists module specifiers, compared literally with `index.parsers`. The
list missing, the block malformed, or an unrecognised key inside it all mean the module is
not loaded: the built-in extractors run, `simt repo index` prints a `note` saying the
policy refused it, `simt check` names the reason, and the refusal is part of the index's
input digest, so adding the entry rebuilds. The
same rule is why `check` names a misshaped `trust` block rather than ignoring it. The
other declarations this tool runs (`gates.commands`, `federation.servers`) are commands an
operator asked it to run; a parser is loaded by an ordinary index read, which is why only
that one needs the second key.

## The `work` declaration

`work` says what this repository produces and which directory owns each part of it. It is the
declaration `simt work inspect` reads and `simt work setup` writes; nothing in it is inferred
from a directory name at read time, so a scope that is missing is reported as missing rather
than guessed.

```json
{
  "work": {
    "version": 2,
    "scopes": [
      {
        "id": "handbook",
        "paths": ["handbook"],
        "kind": "document",
        "validators": ["node scripts/check-handbook.mjs"],
        "ignore": ["drafts"]
      }
    ],
    "targets": [{ "namespace": "publish", "type": "page" }],
    "adapters": ["publish-pages"]
  }
}
```

| Field | What it decides |
| --- | --- |
| `work.version` | the shape of the declaration: `1`, or `2` once it uses a field version 1 does not have |
| `work.scopes[].id` | the name artifacts are referenced by; unique within the repository |
| `work.scopes[].paths` | the directories this scope owns, relative to the repository root; `.` is the root |
| `work.scopes[].kind` | `source`, `document`, `dataset`, `recipe` or `remote-object`; omit it to let the artifact contract decide |
| `work.scopes[].validators` | commands that validate this scope; a validator counts as installed only when the file it names is present, and this tool never runs it |
| `work.scopes[].targets` | the ids of the targets this scope produces |
| `work.scopes[].ignore` | the paths or segments this scope never ingests (version 2) |
| `work.targets[]` | `{namespace, type, name?}`: an output that lives outside the repository, identified by `namespace:type` plus the optional `name` |
| `work.adapters[]` | the ids of adapters installed separately; list only the ones this repository intends to use |

A path is repository-relative and stored in one spelling: `./docs/`, `docs/` and `docs` are one
claim, and the spelling `work setup` writes is the normalised one. An absolute path, a `..`
segment or a padded path is refused by name rather than trimmed into a declaration the
repository did not make. Two scopes may not claim one path: `check` reports both.

A validator is a command, and this tool reads it as one without running it: a declaration is
`installed` when a file it names exists, `false` when a named file is missing or outside the
repository, and unproven
when it names no file at all - so `npm test` is never reported as available just because npm
is. A scope with no validator, or one whose file is missing, is the next thing `simt work
inspect` asks for.

An `ignore` pattern is a path prefix relative to the repository root, or a single segment
matched anywhere (`draft.md` refuses every draft, `*.tmp.md` the ones a generator leaves).
It applies inside the owning scope's paths and nowhere else.

The version is the repository's, not the tool's. A declaration that uses no version-2 field
stays at `1` and is read as written; a version-2 field under `1` is refused by name, with the
version that would accept it. An unknown version is refused rather than guessed.

`simt work setup --scope <id> --path <dir> --kind <kind>` adds one scope and previews it
first: the manifest it would produce is printed, `--yes` writes it through the journal so
`simt undo` restores what it replaced, and a second run over a scope it already declared
changes nothing. It never rewrites a scope the repository wrote, never invents a runner or a
gate, and leaves every other key - including `work.version` - as it found it.

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
