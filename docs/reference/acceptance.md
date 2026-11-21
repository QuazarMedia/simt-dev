# Release acceptance

What a release must prove, and from where, before it is called production-ready. The table
is data in `src/distribute/acceptance.mjs`, ruled on by ADR-214; `test/acceptance.test.mjs`
fails when this page and that module disagree, so the two cannot drift the way four
hand-written paragraphs did.

A green source suite establishes nothing about a receiving repository: it cannot show that
the tool installs, upgrades, configures itself, or enforces its gates where a reader runs it.
So the matrix below is qualified **from installed artefacts only, against independently staged
fixtures** — never from this checkout. Every command in it is one a release engineer runs
against the installed copy, and every unsupported combination names the exit the tool reports
and a command the reader can run.

## The fixtures

Each row is a repository the tool must handle, staged as its own installed copy. A fixture is
independent of this checkout: it carries no sibling repositories, no workspace the author has
configured, and no path that resolves only here (ADR-031).

| Fixture | What it is |
| --- | --- |
| `docs-only` | a docs-only repository: a README and nothing else — no code, no package.json |
| `custom-ecosystem` | a custom ecosystem: a manifest the tool detects through a profile, not a built-in stack |
| `non-node` | a non-Node codebase: one build.gradle and nothing else; the binary channel runs it with no Node on PATH |
| `node-installer` | Node with each supported installer: the same repository installed by npm, pip, brew and the one-line binary download |
| `nested` | mixed and nested projects: a package inside a repository, and a subdirectory that is its own git root |
| `worktree-submodule` | git worktrees and submodules: a worktree and a submodule, each carrying its own head |
| `mono-multi-repo` | a monorepo and a multi-repo: one repository with many packages, and a workspace of several repositories |
| `shallow-clone` | a shallow clone: `git clone --depth 1`; the history the index cannot walk is absent by construction |
| `dirty-checkout` | a dirty checkout: uncommitted changes and untracked files beside the adopted region |
| `prior-formats` | prior published formats: simt-dev.json, simt-dev.lock.json and the simt-dev: region prefix, each read by its owner |

## The proofs

For every applicable channel, a release proves each of these in order. The command is the
reproducible form; the preview runs first and must write nothing, and the `--yes` form is what
applies. A capability that cannot be run on a channel is recorded as not-applicable, not
skipped silently.

| Proof | Command |
| --- | --- |
| `preview` — a preview writes nothing | `simt init --root .` |
| `adoption` — adoption lands the region and the manifest | `simt init --root . --yes` |
| `projection` — projection renders the region, and check reports it current | `simt sync --yes && simt check` |
| `frozen-check` — the frozen check passes against the pinned digests | `simt check --frozen` |
| `gates-evidence` — the declared gates run, and evidence records them | `simt hooks run pre-commit && simt evidence` |
| `undo` — undo reverts the tool’s writes, and nothing else | `simt undo --yes` |
| `upgrade` — an upgrade preview writes nothing; --yes moves the pin | `simt upgrade && simt upgrade --yes` |
| `clean-packaging` — the pack carries the shipped file set, and no checkout path | `npm pack --dry-run` |

## The surfaces

Beyond the plain CLI, each surface is exercised against the installed copy. A surface that
installs and cannot be invoked is a door the tarball left unbuilt; the command is how a
release proves the door opens from the artefact.

| Surface | Command |
| --- | --- |
| `cli` — the plain CLI | `simt --version` |
| `library` — the library export | `node -e "import('simt-dev')"` |
| `mcp` — the MCP surface over stdio | `simt mcp --list` |
| `harness` — the agent hooks | `simt agent-hook pre-tool-use --harness cursor` |

Interruption and retry, an optional tool absent, and an explicit CI opt-in are exercised within
these surfaces: a command that is interrupted and retried must converge, an optional dependency
the fixture does not install must be named in the refusal, and a gate that is opted into
explicitly must run where it is declared.

## The limits

Performance is bounded **before** data is collected. Each limit names what is measured, in
which unit, against which direction; the numbers are bounds a release must meet, and collecting
the data that proves it is a separate, named qualification job. A bar declared after the numbers
is not a bar (ADR-183).

| Limit | Measured | Bound |
| --- | --- | --- |
| `startup` | a cold `simt --version`, from process start to exit | ≤ 500 ms |
| `index` | an incremental index over a bounded work-set | ≤ 300 ms |
| `hook` | one pre-tool-use hook invocation, policy decision included | ≤ 200 ms |

## The channels and targets

The matrix is qualified against the four install channels and the release targets named in the
support inventory ([support.md](support.md)): `npm`, `PyPI`, `Homebrew`, and the `release binary`
for `darwin-arm64`, `darwin-x64` and `linux-x64`. The acceptance matrix reuses those lists
rather than restating them, so a channel or a target added in one place reaches this page by
the same test.

## Unsupported combinations

Each combination the release does not cover, with the reason it is out of scope and the
supported exit or remedy. The exit is the name in the exit-code table the tool reports for this
class (`UNSUPPORTED`: the request cannot be satisfied on this platform), and the remedy is a
command a reader runs, never a place they read.

| Combination | Reason | Exit | Remedy |
| --- | --- | --- | --- |
| the release binary on linux-arm64 | no native arm64 runner in the publish matrix; a binary for it would need an arm64 build job and a fourth formula pair carrying a real checksum | `UNSUPPORTED` | `npm i -D simt-dev`, or `pip install simt-dev` with Node ≥ 22.20.0 |
| a native Windows build | a different executable format, and none is planned | `UNSUPPORTED` | run the tool under WSL2 with npm, pip or the binary |
