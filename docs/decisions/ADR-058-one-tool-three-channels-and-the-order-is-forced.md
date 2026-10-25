# One tool, three channels, and the order is forced

Status: **accepted** · 2026-10-11

> Ruling 7's re-run mechanics are superseded by
> [ADR-097](ADR-097-the-channels-publish-by-hand-and-the-version-rides-in-as-an-input.md):
> the two channel jobs moved to a manual `workflow_dispatch` workflow whose `version`
> input dissolves the branch-vs-tag failure recorded below. The ordering ruling —
> npm live before either channel publishes — stands.

Affects: `pyproject.toml`, `python/simt_dev/`, `Formula/simt-dev.rb`,
`.github/workflows/publish.yml`, `scripts/release-formula.mjs`,
`scripts/verify-wheel.mjs`, `test/packaging.test.mjs`

## Context

simt-dev is a Node program. It is also a *repository* tool: somebody adopting a
repository runs `simt init` inside it, and the places people run that from are
not all Node projects. A python developer in a repository that has no
`package.json` has no reason to install a package manager to get a command that
adopts their repository, and a Homebrew user has no reason to install Node to
install a tool that needs Node.

So the tool is published to three channels:

| Channel | What it installs |
| --- | --- |
| npm | a tarball of `.mjs` files |
| PyPI | a wheel carrying those same files, plus a `simt` entry point |
| Homebrew | a formula that downloads the npm tarball at install time |

The design constraint that decided all of it: the tool has **zero runtime
dependencies and no build step**. The whole thing is ~1.3 MB of text. That makes
the "packaging for a second language" problem a *copying* problem rather than a
build one, and copying is a problem with a right answer.

## Ruling

1. **The Python wheel carries the tool's own source, byte for byte.** `files` in
   `package.json` and `force-include` in `pyproject.toml` name the same paths,
   and `scripts/verify-wheel.mjs` builds both artefacts and hashes every file in
   both, failing the release when a single byte differs.

   The wheel is not a wrapper around `npm install`. A wrapper would fetch code
   at install time - unpinned, unsigned by anything the installer can check, and
   absent the moment somebody runs `pip install` on a train.

2. **The version is one number, read rather than written.**
   `pyproject.toml` declares `dynamic = ["version"]` and reads it from
   `package.json` with a regex. A second literal would drift, and the drift
   would be invisible until somebody ran `pip show` beside `simt --version` and
   got two answers about which release they are running.

3. **The Python launcher is standard library only, and has no required
   dependencies.** The `[node]` extra is optional and imports `nodejs_wheel`
   *inside a `try`, at the point of use* - never at module level - so the
   default install cannot fail on a package it never asked for.

   ADR-012 rules out runtime dependencies for the npm package. The reasoning
   transfers without modification: a dependency is a runtime this package cannot
   verify and its owner cannot patch, and this package exists to be the thing
   people run in a repository rather than the thing they have to curate.

4. **`simt` is the one command, on every channel.** `bin` in `package.json` and
   `[project.scripts]` in `pyproject.toml` are asserted equal, and the formula's
   `test do` block runs it. A second name under the package name would be a
   convenience that forks the documentation the first time somebody documents
   one channel and not the other.

5. **Homebrew installs the npm tarball, and does not use `std_npm_args`.**
   `depends_on "node"` declares the runtime; the entry point's shebang is
   rewritten to that node rather than left at `#!/usr/bin/env node`, so the
   command works from a cron job and from a shell that has moved node out of
   the way, both of which look identical to a broken install.

   `std_npm_args` invokes npm at build time, which needs the registry at build
   time. This package has nothing to install, so that would add a network fetch
   to installing the one thing in the estate that provably needs none.

6. **`Formula/simt-dev.rb` is the source of truth, and `scripts/release-formula.mjs`
   patches two lines in it.** It does not regenerate the formula from a
   template: a template would mean the bytes a reader sees in this repository
   are not the bytes a tap serves, which is the defect ADR-023 ruled out for the
   gate file. The two lines are matched by content, not by line number, because
   a line number would make the formula a file that cannot be edited - adding a
   comment above the `sha256` line would silently write the checksum to the
   wrong place.

7. **The npm version must be live before `publish-pypi` and `publish-brew`
   succeed, and both jobs say so when it is not.** The order is not a
   preference. Homebrew downloads from the npm registry at install time, so a
   formula naming a version that is still in npm's staging area installs a
   404 - on somebody else's machine, at a tap, from a release this workflow
   already declared done.

   Those two jobs are the ones a maintainer runs again after
   `npm stage approve`. "Re-run failed jobs" carries the tag context, which a
   `workflow_dispatch` does not: on a dispatch, `github.ref_name` is the branch,
   and the version guard would compare a tag against a branch.

## Consequences

The invariants split in two, and the split is deliberate.

`test/packaging.test.mjs` holds the **static** ones: that `files` and
`force-include` name the same paths, that the version is not written twice, that
the command is one name, that the launcher imports nothing outside the standard
library, that no second build system sits at the repository root. Every one of
those is checkable from this checkout with no network and no interpreter, which
is what lets it run in `npm test`.

`scripts/verify-wheel.mjs` holds the one that is not: that the paths, once
built, contain the same bytes. It runs in the release workflow, where a Python
and a registry are available by construction.

That split is ADR-031 applied. A test that needed `pip` would not run for the
next person who clones this repository, and would run differently on the
machine that wrote it - which is the failure that suite is about.

Two findings from building it are recorded because they are the kind that only
appear when a check is real:

- The first run of `verify-wheel.mjs` reported `LICENSE` and `README.md` as
  differences. They are not defects: npm adds both to every tarball, and the
  wheel carries them as *distribution metadata* rather than as files. The
  comparison is now scoped to what `files` names, which is the content the tool
  reads.
- The first run of that same comparison reported every one of `bin`, `src`,
  `graph` and `rules` as missing from both, because `files` names **directories**
  and npm includes them recursively. The expansion happens in the script now,
  with the reason stated where the code is.

The check was also tampered with deliberately - a wheel-only `README.md` was
injected into `force-include` and it failed - because a parity check that has
never failed is not evidence that it works.

## Rejected

- **A Python wrapper that runs `npm install -g simt-dev` on first use.** This is
  what the unofficial `pyright` package does, and it has the properties it is
  reputed to have: a download on first run, unpinned, uncacheable, and a failure
  mode that reads as a broken package rather than as a missing runtime.
- **Requiring node, with no bundled fallback.** The reader who installs from
  PyPI is frequently the reader with no node, which is the whole reason the
  channel exists. The failure message therefore names the `[node]` extra first,
  because it is the one remedy that is the same command on every platform.
- **Guessing where node is.** A hardcoded list of `/opt/homebrew/bin/node`,
  `/usr/local/bin/node` and `~/.nvm/...` is three guesses and a surprise: it
  prefers a guess over the reader's own `PATH`, and it is already out of date
  for anyone who installs node differently. `shutil.which` asks the question
  instead of answering it.
- **`std_npm_args`.** See ruling 5.
- **Publishing all three channels simultaneously.** Rejected by the ordering in
  ruling 7 - Homebrew cannot name a version npm has not released.
