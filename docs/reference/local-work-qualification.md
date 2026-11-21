# Local work qualification

Date: 2026-11-21

Plan 0006's local npm workflow was exercised from a packed install in two
standalone Git clones. The reference for the earlier CLI was
`7188aefa7ab4b1c0bd8f64a608b3bb87751e570a`. That CLI refused the scoped rank and
verification invocations and listed no setup command. The qualified package
runs setup, extracts committed Markdown, answers scoped and historical
questions, and records a local validator's observations.

## Synthetic results

The ten frozen lookup cases cover lexical terms, accented terms, direct
location and id lookup, and jurisdiction. The historical and scope
negative-control assertions are additional checks. The baseline scores each of
the three primary fixture files by the number of distinct query words it
contains, with the declared jurisdiction filter where applicable.

- Handbook corpus reached the labelled source in the top five in **10/10**
  cases. The lexical baseline also reached **10/10**. Five files were indexed.
  The final cache was 12,542 bytes. Cold and repeat-build wall times were 214
  and 237 ms. First and repeat-query wall times were 230 and 233 ms.
- Mixed operations corpus reached **10/10**. The lexical baseline also reached
  **10/10**. Six files were indexed. The final cache was 14,428 bytes. Cold and
  repeat-build wall times were 227 and 226 ms. First and repeat-query wall times
  were 221 and 224 ms.

These are single runs on Darwin arm64 with Node 26.13.0 and npm 11.20.0.
Timings include CLI process startup. The fixtures establish a floor for these
inputs. Larger corpora and language-specific retrieval quality need live trials.

Each installed workflow executed the guide's first-session commands. The
existing fixture validator checked two changed files, recorded the observed
count, and kept human review pending. An explicit synthetic attestation
completed verification for both changed files. A subsequent change reopened the
two obligations attached to that file and retained the two attached to the
other. Impact found the downstream specification, and an unsupported file
remained unmapped during selection. The incremental cache matched a clean
rebuild byte for byte.

The installed CLI probes observed zero calls to the guarded Node networking
APIs and zero reads of the excluded private fixture source. npm installed the
tarball with `--offline`. The probes cover the exercised Node call paths.
Kernel-level network and filesystem tracing remain outside this evidence.

A separate packed npm checkout exercised the rollback. The last journaled
setup write was previewed and undone. The authored Markdown remained byte
identical and the scope manifest was removed.

## Repository checks

The isolated `npm test` run passed 2,760 tests. It reported the existing
standalone executable test as qualification-only. `npm run lint` passed its
structural checks in the isolated clone, and `npm run verify:shipped` passed
all 25 checks. The generated decision index, command reference, package path
parity and first-session command dispatch checks passed.

## Qualification boundary

The [operator guide](../guides/local-work.md) covers incremental adoption,
supported inputs, verification counts and rollback. The two maintainer-led
trials remain pending.

An offline wheel built from the source distribution and installed under
CPython 3.9.6. Its installed command set up a scope, built a corpus and
returned a committed citation. All 591 vendored files matched the npm
tarball by SHA-256. Full lifecycle qualification covers the npm tarball. Registry delivery, Homebrew and standalone binaries remain
unqualified for this workflow.
