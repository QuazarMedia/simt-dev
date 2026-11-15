# Finding codes

Rendered from `src/explain.mjs` by `simt docs commands --yes`; do not edit by hand.
`simt explain <CODE>` prints the full record for each: the defect, the ruling behind it,
the command that fixes it, and what a reader sees.

| Code | What it means |
| --- | --- |
| `ABSENT` | The file the gate reads does not exist: no AGENTS.md at the repository root, so there is no region to compare. |
| `BEYOND-READ-LIMIT` | The generated region ends past a reader’s documented read limit, so that reader stops mid-region and never sees the rules below the cut. |
| `BUDGET` | The always-on projection carries more bytes than this repository agreed to carry in budget.bytes — and nothing was cut. |
| `BUDGET-CUT` | The projection was cut to fit budget.bytes: kernel mode packed least-valuable-first and named every cut rule under "Deferred rules". |
| `CHECK-UNBUILT` | A selected rule declares a checker this tool does not know, so the gate has no direction to enforce and refuses to pretend otherwise. |
| `CURRENT` | Not a defect: the file on disk is byte-for-byte what the tool would write. This is the gate’s passing state for that file. |
| `DRIFT` | The file on disk differs from what the tool would write: someone edited the generated region, or the rules changed underneath it. |
| `DUPLICATE-DECISION-ID` | Two decision records claim one number: the index only sees the first, so the second is a record no provenance answer can reach. |
| `FILE-LINES` | A file exceeds the 1000-line hard ceiling: it fails the gate. |
| `FILE-LINES-WARN` | A file passed the 400-line review trigger but is under the ceiling: reported, and the gate stays green. |
| `FORBID-REGEX` | A rule forbids a pattern and the pattern occurs: the file contains text the repository’s own rules refuse. |
| `FORBIDDEN-PATH` | A path the repository forbids was touched: the change reaches a file the rules say is out of bounds. |
| `GATE-CWD-MISSING` | gates.cwd names a directory that is not a directory in this repository: the gate would run somewhere that does not exist. |
| `GATE-CWD-OUTSIDE` | gates.cwd resolves outside the repository: the gate would run outside the tree it is supposed to guard. |
| `GENERATED` | The path carries bytes this tool generates, so a write there is discarded by the next sync instead of applied. |
| `HOOKS-DISABLE` | The command removes or reroutes the git hooks the gates run in: core.hooksPath is unset or repointed, or the hooks directory is deleted. |
| `INCONSISTENT` | The project’s tsconfig spells `moduleResolution` in a form the TypeScript parser accepts but the documentation does not, so it compiles and quietly disagrees with every repository that spells it the documented way. |
| `INERT` | The TypeScript base config is present but inert: nothing in the repository reads it, so it constrains no file. |
| `INVALID` | A file the tool reads declares something it cannot use: a rule with unparseable frontmatter, a manifest surface no editor documents, or a checker error the compiler reports. |
| `INVALID-DECISION-FRONTMATTER` | An ADR’s structured frontmatter does not parse: simt-supersedes names a record or ruling that does not exist, or the shape is not [{ adr, ruling }]. |
| `LEASE` | The path is leased by another session, so a write here collides with work happening right now. |
| `LOCK-ABSENT` | No lock is recorded: the projection was never locked, so there is nothing `--frozen` can compare against. |
| `LOCK-STALE` | The inputs changed and the lock was not rewritten: something the projection is computed from moved without re-locking. |
| `LOCK-UNEXPLAINED` | The projection changed and the inputs did not: the outputs moved with no input change to explain them. |
| `LOCK-UNREADABLE` | The lock file cannot be read or parsed: --frozen has a lock it cannot verify. |
| `MALFORMED` | The generated region’s markers do not parse: the begin/end lines are damaged, duplicated, or in the wrong order. |
| `MISPLACED` | The region is intact but not at the top of the file, so it overrides the settings below it — and in this format the last matching definition wins, so the repository’s own settings silently stop applying. |
| `OPTIONAL` | The repo runs GitHub Actions but lacks one of the two .github files `init` writes at adoption (“simt-dev-check.yml”, “dependabot.yml”): the file is offered, not present. |
| `ORPHANED` | A managed rule file this run would not write: narrowing a surface’s output left a file the tool once generated and now ignores. |
| `PACK-DECLARED-TWICE` | The manifest declares the same pack twice: the second declaration is read as the first, so one of them is dead text. |
| `PACK-DIGEST-MISMATCH` | The pack’s bytes no longer match the digest the manifest pins: someone edited the vendored copy, or vendored different bytes than the pin records. |
| `PACK-MISSING` | The manifest declares a pack with no directory: every rule the pack carries is missing from this repository’s projection. |
| `PACK-NAME-INVALID` | The manifest names a pack that cannot be a directory name: it escapes the pack directory or uses characters a path cannot hold. |
| `PACK-UNPINNED` | The pack has no digest: nothing records which bytes it was declared at. Its rules still render, and the gate stays green. |
| `POINTER-BLOCKED` | The pointer file cannot be written where it belongs: something the tool does not own blocks the path. |
| `POINTER-UNREAD` | The pointer aims at a file the reader will not read: it names a path no adopted surface documents. |
| `PROSE-PARTIAL-SUPERSESSION` | An ADR states a partial supersession only in prose: "ruling N superseded by ADR-MMM" with no matching simt-supersedes frontmatter entry, so tooling cannot see the move. |
| `PUSH` | The command pushes: a remote mutation, which needs explicit approval before it runs. |
| `REFORMATTED` | The manifest’s content is what simt-dev would write, but the bytes differ: another formatter owns this file’s shape. |
| `REQUIRED-FILE` | A rule requires a file the repository does not have: the project is missing something its own rules demand. |
| `REWRITE` | The command amends, rebases, resets --hard, force-pushes or passes --no-verify: each one rewrites history or skips a declared gate. |
| `STALE-GENERATED-FIELD` | Generated manifest fields do not match what simt-dev writes: the projection SHA, the stack, or the version pin drifted without a re-run. |
| `UNKNOWN-GATE-CWD` | gates.cwd names a gate the manifest never declares: the working-directory override points at nothing. |
| `UNMANAGED` | The file exists but carries no generated region: the repository was never adopted, or the region was deleted by hand. |
| `UNREADABLE` | The gate could not read a file it must verify: permissions, a broken symlink, or an I/O error — anything but a clean absence. |
| `UNRESOLVABLE` | The checked-in gate workflow cannot resolve simt-dev by any path its locator tries: no pinned devDependency, no release binary, no simt on PATH. |
| `UNRUNNABLE` | A declared gate cannot run here: the command it needs is not on PATH, or its runner is missing. |
| `VERSION-MISMATCH` | The binary running the gate is not the version the manifest pins: the gate that runs is not the gate CI runs. |
