# Changelog

All notable changes to this package are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] — 2026-10-10

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

[1.1.0]: https://github.com/QuazarMedia/simt-dev/releases/tag/v1.1.0