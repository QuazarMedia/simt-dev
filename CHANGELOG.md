# Changelog

All notable changes to this package are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-10-10

First published release. Nothing earlier was ever on a registry, so this entry is the
whole history; the decisions that produced it are readable in the package under
`docs/decisions/` and from any checkout with `rules why <id>`.

### What a first release has to say out loud

These are the behaviours a reader is most likely to trip over. Each one is deliberate,
and each has a numbered decision record behind it — but a behaviour nobody can discover
without reading the source is not a documented one.

- **`sync` and `init` write nothing without `--yes`.** Both print a plan and exit. `sync`
  exits **1** when the plan is non-empty, so bare `sync` doubles as a check. Neither ever
  commits or pushes. *(ADR-035, ADR-036)*
- **`upgrade` moves a pin and nothing else.** It never adopts a repository, never repairs
  one, and never rewrites a manifest. Every consumer moves to the same version as one set.
  *(ADR-037)*
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

[0.1.0]: https://github.com/quazarmedia/simt-dev/releases/tag/v0.1.0