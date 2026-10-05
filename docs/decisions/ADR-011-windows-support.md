# ADR-011 — Windows is supported from v1

Status: **accepted** · 2026-10-05 · affects the `simt-dev` CLI

## Context

No Windows developer currently appears in the estate, and the cheap alternative was
`"os": ["darwin", "linux"]` in `package.json`, which makes npm refuse to install on Windows
with a clear message instead of failing obscurely inside a git hook.

That option was put to you and declined in favour of full v1 support.

The cost is real and is recorded here so it is paid deliberately rather than discovered:

| Obligation | Why |
|---|---|
| Hook scripts must not assume POSIX | `core.hooksPath` hooks run under Git for Windows' bundled sh, which does exist — but the dispatcher cannot assume a POSIX `#!/bin/sh` shebang alone is sufficient. Hook entrypoints are `.cmd`-aware or invoked through `node` explicitly. |
| The projection injector must normalise line endings | The audit found **10 of 16 repos have no `.editorconfig`**, so a generated region written with the host's EOL would produce a whole-file diff on Windows checkouts. The injector writes the canonical EOL from `.gitattributes` (`* text=auto eol=lf`), defaulting to LF. |
| Path handling must not assume `/` | Resolver globs, `paths` matching and every emitted file reference must normalise separators. |
| npm bin shim | The published package must rely on npm's generated shim rather than a hand-written launcher. |
| CI must actually run it | A macOS-only CI run cannot verify a Windows claim. GitHub Actions gains a `windows-latest` job for the CLI itself — not for the repos it serves, which stay macOS/Linux as their own tooling dictates. |

## Ruling

Windows is a supported v1 platform for the `simt-dev` CLI itself. `package.json` declares no
`os` restriction, and CI verifies on `windows-latest`.

Scope is deliberately limited: this covers the CLI running *on* Windows. It does not imply that
any repo's own toolchain is Windows-ready — `bunnyland-server`'s `uv`/`xdist` flow, Monkey C,
and Android Gradle builds are governed by their own repos.

## Consequences

- The shared hook dispatcher ships with a Windows-safe entrypoint from day one. Retrofitting
  this after 16 repos have installed the dispatcher is far more expensive than building it now.
- The EOL normalisation in the projection injector becomes a correctness requirement rather
  than a nicety — which is worth doing regardless, given 10 repos lack `.editorconfig`.
- `windows-latest` CI costs minutes per run and buys an install story that does not break on the
  first non-Mac contributor.

## Rejected

- **`os: ["darwin", "linux"]`.** Cheapest, and a defensible engineering call on estate
  evidence — declined because the hook dispatcher's Windows-safety is substantially harder to
  retrofit across 16 installed repos than to build.
- **Windows via WSL only.** Avoids the native path work but leaves a Windows contributor
  needing a Linux environment, which is the failure this ruling exists to prevent.
