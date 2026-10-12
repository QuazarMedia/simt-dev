# Changelog

All notable changes to this package are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### No published file may name a repository from this estate

The decision records ship in all three channels — npm, the wheel and the sdist — so a
private repository name written into one is published to three registries. That happened:
the records were pseudonymised once, across 28 files, and nothing stopped the next one. The
sweep's own commit says why, and it is the right reason: the redaction it used runs on the
way *out*, at print time, and the bytes on disk are what get published.

`test/shipped.test.mjs` now fails on an estate name anywhere in a published file, and
asserts its own scope against `package.json` in **both** directions — a directory added to
`files` without being guarded fails, and so does one guarded that nothing publishes, because
a guard nobody can fail is one somebody eventually deletes. It is scoped to the published
set rather than a hand-written list for the same reason: the sweep took 28 files to undo by
hand, and the guard should not need undoing at all.

Names are not removed, they are described. The records that use a repository as *evidence* —
a table of how three repositories answer the same question — carry stable `repo-NN` labels,
so the comparison survives. Everything else is better off naming what the repository *is*:
"a Gradle module with no wrapper", "a repository with no package.json". That reads to
someone outside the estate without a lookup table they do not have.

The one place estate names remain is `docs/reviews/`, which is not published by either
channel. A review whose subject is fourteen repositories cannot pseudonymise them without
becoming a document about `repo-01` that never existed.

### Four shipped strings named a command this package does not install

`0.2.0` installs one binary, `simt`, and `package.json`'s `bin` map says so. Four
places still said `simt-dev`, which a reader types and is met with `unknown command`:

- the default remedy on every bad invocation, `run: simt-dev --help` — so the advice
  printed after a bad command could not be followed
- the usage line, `usage: simt-dev <command>`, sitting above a command list that spelled
  the same tool `simt`
- `.github/dependabot.yml`'s header, which said `Yours from here: simt-dev` while the
  gate beside it said `Yours from here: simt`
- the hook shim, whose own resolution list said `simt-dev on PATH` directly above the
  `command -v simt` that does the looking

`test/naming.test.mjs` was supposed to prevent this and did not: its rule required a
verb after the project name, and none of the four is followed by one. It now also
catches a flag, a `<placeholder>`, the end of a line, and a program name in a
resolution list — while still accepting the sentences where the project is the
subject, which is the spelling that is correct. The two `.github` templates get their
own assertion, because the fourth of these was not a wrong word in a sentence; it was
two templates disagreeing with each other in the same position.

### Fixed
- `hooks install` removes a shim whose gate was dropped from the manifest instead of leaving it to run nothing. A repository that removed its last gate was refused outright, with a remedy telling it to put the gate back; only un-routing git was left to the reader. install also no longer chains a hook to itself.

- **Dead exports and duplicated frontmatter, with a test that stops them returning (S21).**
  Eight functions were exported and called by nothing (`gateKind`, `gateWhy`, `gateAdr`,
  `resetWorkspace`, `tracksIdentity`, `isTty`, `surfaceFrontmatter`, `workspaceOrNull`),
  three `__internals` testing seams had no importer, and thirteen more bindings were
  exported while being used only inside their own file — `isExecutable` among them, which
  a first pass through this list wrongly recorded as dead and which its own callers
  proved otherwise. `KNOWN_SUBS` was a hand-kept second copy of the dispatch table, and
  had already drifted: it carried `doctor`, a bare command the group lookup can never
  reach. `mdcFrontmatter` was a second construction of frontmatter the writer now derives
  itself, with a test asserting the copy rather than the behaviour.

- **"Did you mean" offered the shortest fragment first, and a misspelt skill was
  suggested for a correctly spelled one (S22).** `nearMatches` had no test at all.
  Both directions of substring scored 0 — the same score as an exact match — so the
  alphabetical tiebreak decided the order, and `skills graphs` suggested `graph`
  before `graphs`. Worse, the containment test had no length floor, so `test` matched
  the candidate `e` and the message read `did you mean e, test-writer?`, which an
  agent has every reason to install. A prefix now scores 1 rather than 0, a fragment
  counts only when it is at least half the query, and the edit bound scales with the
  query's length — three edits is a typo in `slice-commmit` and is most of a
  four-character query.

- **The conflict scanner skipped two of the five rule surfaces, and one pointer file
  (S22).** `rulePaths` enumerated filenames by hand, so `.claude/rules/` and
  `.agents/rules/` — added to the surface table after the list was written — were
  never scanned, and a hand-written rule contradicting a generated one there was
  invisible. A conflict detector that only looks where it was pointed looks nowhere
  new. The scan list is now derived from the surface table and the pointer table.

## [0.2.0] — 2026-10-11

### Publishable from PyPI and Homebrew as well as npm

simt-dev is a *repository* tool, and the people who adopt a repository are not
all Node developers. Somebody running `simt init` inside a repository with no
`package.json` has no reason to install a package manager, and a Homebrew user
has no reason to install Node to install a tool that needs Node.

So it now publishes to three channels, from one version number:

```sh
npm i -D simt-dev        # a tarball of .mjs files
pip install simt-dev      # a wheel carrying those same bytes
brew install QuazarMedia/tap/simt-dev
```

The wheel is not a wrapper around `npm install`. It carries the tool's own
source, and `scripts/verify-wheel.mjs` builds both artefacts and hashes every
file in both — a release fails when a single byte differs between them. That
check exists because the obvious defect in this arrangement is the wheel and the
tarball quietly shipping different code.

`simt` is the one command, on every channel. Where node comes from is
`SIMT_DEV_NODE`, then the bundled node from `pip install "simt-dev[node]"`,
then `node` on `PATH` — and if none of those resolve you get the remedy rather
than a placeholder path. There are no required dependencies on any channel.
*(ADR-058)*

The channels are published in a fixed order rather than in parallel, and the
reason is not taste: the Homebrew formula downloads the npm tarball at install
time, so a formula naming a version still sitting in npm's staging area
installs a 404. Both jobs fail with that stated, and are run again after
`npm stage approve`.

## [0.1.1] — 2026-10-11

### A foreign hook on an event this repo does not gate is chained

`0.1.0` chained the wrong set of hooks and is worth replacing rather than
recommending. It chained on the event *vocabulary* — anything that was not
`pre-commit` or `pre-push` — when the question worth asking is whether **this
repository** declares a gate for that event.

The difference is a repository whose `pre-push` is `git-lfs`. `pre-push` is an
event this tool gates in general, so `0.1.0` displaced that hook; and because
that repository declares no `pre-push` gate there was no shim for the event
either, so git would have found no `pre-push` hook at all. LFS objects would have
stopped being uploaded, with nothing to notice it — the exact silent failure
chaining exists to prevent, reached by fixing the wrong half of it.

`0.1.1` asks the manifest. An event the repo declares a gate for is left to
`gates.commands`, where the hook runs as a gate and its verdict appears in the
report; every other foreign hook is chained. That also picks up a static
site's Lighthouse pre-push, which declares no gates at all.
*(ADR-018, as amended)*

Upgrade with `npm i -D simt-dev@0.1.1`, then `simt hooks install --yes`. Any
repository already routed with `0.1.0` should re-run it: the shims it writes
will differ where a gated event was previously displaced.

## [0.1.0] — 2026-10-11

The first release with real contents in it. `1.0.0` was an empty reservation of the name
and `0.0.0-stage` was its rehearsal; neither shipped a byte anyone could run, so this entry
is the whole history. The decisions behind it are readable in the package under
`docs/decisions/`, and from any checkout with `simt rules why <id>`.

### The command is `simt`

The package is `simt-dev` and the command is `simt`. They are not the same thing and were
never required to be: the command appears only in text the tool itself writes, and that
text migrates on the next write. The package name, the `.simt-hooks/` directory and the
`simt-dev-check.yml` gate already exist in every repository that adopted this tool, and
they did not move. The manifest and the region markers did — see below.

### The manifest is `simt.json`

The manifest was called `simt-dev.json`; it is now `simt.json`. The move is a
read-both/write-new, so nothing in an adopting repository has to be done:

- Every read takes `simt.json` if it exists, else `simt-dev.json`, so a repository that
  has not written since the upgrade is still seen as adopted.
- Every write goes to `simt.json`, and a lone `simt-dev.json` is moved, not shadowed.
- The old name keeps working until the first `init` or manifest write in each repository,
  and that write closes it. *(ADR-056)*

### The region markers are `simt:`

The generated region was stamped `<!-- simt-dev:begin -->` / `<!-- simt-dev:end -->` — and
so was the provenance header inside it; every one of those lines is now `simt:`. The move
is the same read-both/write-new as the manifest:

- Every read accepts either spelling, so a repository that has not written since the
  upgrade is still seen as adopted.
- Every write emits `simt:` only, so the first `sync` in each repository migrates its
  regions in place, and that write closes the window.
- A file holding two regions — one of each spelling — is a state only a hand edit can
  make, and it is reported malformed rather than merged. *(ADR-056)*

### A hook you already had keeps running

`hooks install` points `core.hooksPath` at `.simt-hooks/`, and git reads **every** hook from
that one directory — not just the two events this tool gates. So adopting a repository that
had its own `post-commit`, `post-checkout` or `post-merge` would have quietly stopped them:
nothing fails, nothing is logged, and the hook is still on disk looking intact.

Those hooks are now **chained**. Install writes a shim for them that runs the repository's
own hook and forwards git's arguments, so nothing is lost and the reason is in the file. If
the hook is gone, the shim refuses and names the path instead of passing quietly. A hook on
an event this tool *does* gate (`pre-commit`, `pre-push`) is deliberately not chained —
declare it under `gates.commands` so the dispatcher runs it and its verdict appears in the
gate report. *(ADR-018, as amended)*

### What a first release has to say out loud

These are the behaviours a reader is most likely to trip over. Each one is deliberate,
and each has a numbered decision record behind it — but a behaviour nobody can discover
without reading the source is not a documented one.

- **`sync` and `init` write nothing without `--yes`.** Both print a plan and exit. `sync`
  exits **1** when the plan is non-empty, so bare `sync` doubles as a check. Neither ever
  commits or pushes. *(ADR-035, ADR-036)*
- **`upgrade` moves a pin and nothing else.** It never adopts a repository, never repairs
  one, and never rewrites a manifest. Every consumer moves to the same version as one set.
- **A pre-commit hook with no reachable binary fails closed.** The refusal is the correct
  behaviour, not a bug; the remedy it prints is the command that obtains one.
  *(ADR-010, ADR-018)*
- **A gate whose tool is not installed is dropped, with a remedy naming the package.**
  It is never declared and silently unrunnable. *(ADR-017)*
- **Two rules are never loaded twice.** Each rule projects to exactly one place, chosen by
  what the harness actually reads. *(ADR-021, ADR-046)*
- **macOS and Linux only.** Windows `npm i` fails with npm's `EBADPLATFORM`, which npm
  will not let a package explain; use WSL2. See the platform section of the README.
  *(ADR-012)*

### Packaging

- Licence set to Apache-2.0; the `LICENSE` file is the canonical, unmodified text.
- `files` no longer lists `skills`, `agents`, `tooling` or `hooks`, none of which exist,
  and no longer ships `docs/plans`. The tarball is the tool and the decisions behind it,
  and nothing else.
- The package `description` no longer names an internal ecosystem. It is the first line
  anybody outside the project reads.
- Unscoped, so the install command is `npm i -D simt-dev` rather than a name under an
  organisation. The `@simt` and `@quazarmedia` scopes were both free; an unscoped name is
  the one a reader can guess.

### Notes for anyone upgrading a hook

A shim installed by an earlier version looks for `SIMT_DEV_BIN`, then for
`node_modules/simt-dev/bin/simt-dev.mjs`, then for a program named `simt` on `PATH`. The
last of those is new, so a machine that installed the package before this release and
never ran `simt hooks install` again will find nothing until the dependency is refreshed
and `simt hooks install --yes` is re-run. That is a real upgrade step and it is called out
here rather than discovered.

[0.2.0]: https://github.com/QuazarMedia/simt-dev/releases/tag/v0.2.0
[0.1.1]: https://github.com/QuazarMedia/simt-dev/releases/tag/v0.1.1
[0.1.0]: https://github.com/QuazarMedia/simt-dev/releases/tag/v0.1.0