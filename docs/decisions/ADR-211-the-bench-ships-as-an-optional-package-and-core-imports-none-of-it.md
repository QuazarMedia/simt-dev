---
simt-affects: ["package.json", "pyproject.toml", "src/commands/bench.mjs", "src/compare/learn.mjs", "src/measure/ablation.mjs", "packages/bench/src/commands.mjs", "packages/bench/src/evaluation.mjs", "scripts/build-bench-package.mjs", "test/pack-imports.test.mjs"]
simt-supersedes: []
---
# ADR-211 — the bench ships as an optional package, and core imports none of it

Status: accepted · 2026-11-21 · filed as PR31 (review 0005)

## Context

ADR-209 closes a slice with one command; this ruling closes a package boundary. The bench
was moved to `packages/bench` behind a loader (review 0003 Q79), then put back into the core
tarball because two core modules imported it statically: `src/commands/bench.mjs` imported
the replay and calibration engines, and `src/compare/learn.mjs` imported the ablation grammar.
Shipping the package made the binary's `simt bench` work, but every repository installing the
rules and the gate paid for task mining, agent adapters, probes, worlds and judge calibration.

The two static imports are the whole dependency. The replay and calibration commands answer
from a JSON document and are bench vocabulary, not production measurement; `compare --learn`
only reads stored ablation rows and needs the arm-name grammar and the deletion threshold,
which are read-only proof primitives. Nothing else in `src/` or `bin/` reaches the bench.

## Ruling

1. **Core imports no bench module, statically or dynamically.** The only exception is
   `src/commands/bench.mjs`, whose job is to load the optional package. The ablation grammar
   (`parseAblationArmName`, `DEL_R_TOLERANCE`) moves to `src/measure/ablation.mjs`; the bench
   imports it from core and re-exports it, so one grammar serves both. The replay and
   calibration handlers move to the bench package.

2. **The core tarball and wheel do not carry the bench.** `package.json`'s `files` and
   `pyproject.toml`'s force-include drop `packages/bench/src`. A repository with only
   `simt-dev` gets the CLI, API, MCP, rules, gate and retrieval; `simt bench` answers
   `UNSUPPORTED` with the install remedy. Payload and startup graph shrink by the package's
   source and its imports.

3. **The bench has a supported optional install.** `scripts/build-bench-package.mjs` copies
   the source, rewrites its core specifiers to the public `simt-dev/src/*` export, and writes a
   manifest that names `simt-dev` as a peer dependency and the same version. The loader first
   uses a checkout's `packages/bench` and otherwise resolves the installed `@simt-dev/bench`
   package. Installing the bench therefore shares the installed core instead of vendoring a
   second copy.

4. **Research stays behind that boundary.** Task mining, agent adapters, probes and their
   catalogues, worlds, corpora, accounting and reports are bench files. The action, adapter,
   coordination and verification helpers stay in core because each has a production command
   door (`wires`, `action`, `work`, `lease`, `verify`); they are not experiment-only, and
   moving them would break commands. Features without such a door are not promoted here.

5. **Distill remains core.** `simt distill` is a deterministic, offline command with a local
   model only when the manifest names one; it has no bench dependency and no optional half.
   Its local adapter is a core capability, not a measurement harness.

## Consequences

- The core package is smaller and its startup graph has no edge to the benchmark package.
- A source checkout still runs every bench command with no install step; a consumer adds
  `@simt-dev/bench` only when it measures an agent.
- The optional package must be rebuilt for each core version; its peer range records that.
- `compare --learn` keeps reading stored ablation records without loading the bench, through
  the core grammar module.
- The package boundary is enforced in both directions: a test rejects a static core import of
  the bench, and the core tarball test rejects a bench entry in `files`.

## Alternatives

- **Keep shipping the bench to make the binary self-contained.** That is the state this
  reverses: every install carries code it did not ask for, and the optional boundary exists
  only in the directory layout.
- **Copy the ablation grammar into `compare`.** A second parser would drift from the arm names
  the bench writes; the core module is the single grammar.
- **Have the bench declare `simt-dev` as a dependency.** It could install a second core beside
  the one running it; a peer dependency keeps one core and one rule set.
