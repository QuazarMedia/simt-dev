# ADR-012 — Windows support is dropped; POSIX only

Status: **accepted** · 2026-10-05 · supersedes [ADR-011](ADR-011-windows-support.md)
Affects: the `simt-dev` CLI

## Context

ADR-011 committed to supporting Windows in the CLI from v1, against the recommendation to
declare `"os": ["darwin", "linux"]` and let npm refuse the install elsewhere. The reasoning
for that decision was sound but the weighing was wrong.

ADR-011's own cost table listed five obligations, three of which are permanent tax on
every future change to the hook dispatcher and the projection injector rather than one-off
work:

1. Hook entrypoints must be `.cmd`-aware instead of relying on a POSIX shebang.
2. The projection injector must normalise line endings on every write.
3. Glob matching and every emitted path reference must normalise separators.
4. npm's generated bin shim must be relied on rather than a hand-written launcher.
5. CI must carry a permanent `windows-latest` job.

Against that: **no Windows developer appears anywhere in the 16 repos**, and no repo's own
toolchain is Windows-ready either — `bunnyland-server` drives `uv`/`xdist`,
`simt-garmin` drives the Monkey C toolchain, and `simt-app`/`wakt-app`/`app-ui` drive Gradle
and Android tooling. So the CLI would have been the *only* Windows-ready artefact in the
estate, serving nobody.

The deciding argument is not the cost, it is the shape: obligations 1–3 are correctness
constraints that every contributor must keep satisfying forever. Adopting them to serve a
population of zero is how a codebase accumulates permanent complexity nobody can evaluate.

## Ruling

**POSIX only: macOS and Linux.** `package.json` declares `"os": ["darwin", "linux"]`, so npm
refuses to install on Windows with a clear message instead of failing obscurely inside a git
hook. CI verifies on `macos-latest` and `ubuntu-latest` only.

The code obligations of ADR-011 are withdrawn, with one exception that stands on its own
merits rather than on Windows: **the projection injector still normalises line endings to the
canonical EOL.** 10 of 16 repos have no `.editorconfig`, so a generated region written with
whatever the host produced would cause whole-file diffs on checkouts whose
`core.autocrlf` differs. That is a cross-platform problem among POSIX hosts and has nothing
to do with Windows.

## Consequences

- `bin/simt-dev.mjs` keeps its shebang as a plain POSIX entrypoint; no `.cmd` shim handling.
- Glob matching and emitted paths assume `/`. The existing forward-slash normalisation in
  `fingerprint.mjs` is retained as cheap insurance, not as a Windows requirement.
- The permanent `windows-latest` CI job is not added.
- Revisit only when a Windows developer joins the estate — at which point the deciding
  argument is gone and the cost table in ADR-011 becomes the deciding one.

## Rejected

- **Keeping Windows v1 (ADR-011).** Permanent correctness constraints in the dispatcher and
  injector, serving zero users, in the only part of the estate that would have been
  Windows-ready.
- **Deferring rather than dropping.** A deferred platform is an unbounded promise; the
  obligations would still shape the code.
