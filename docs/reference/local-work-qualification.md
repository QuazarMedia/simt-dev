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

## Opted-in repository trials

Both trials used the shipped npm commands in disposable standalone clones on
Darwin arm64, Node 26.13.0 and npm 11.20.0. The install used `npm pack --offline`
and `npm install --offline --ignore-scripts --no-audit --no-fund <tarball>`.
The tested tarball had SHA-256
`9beb74df31dbf21e3e5e650a9450556fbe9b20f269a84aa67e1458836563ce82`.

- The multilingual requirements scope started at
  `213c60ba037fcda8f0bb01444aa93afca8aeb155`. Top-five source retrieval reached
  **10/10**, matching the distinct-word lexical baseline. There were 53
  indexed files and 2,001 units. An unsupported spreadsheet stayed outside
  the index. The final corpus cache was 4,733,090 bytes. Setup preview and
  apply took 476 and 394 ms. Cold and repeat builds took 765 and 759 ms.
  First and repeat queries took 862 and 883 ms.
- The documentation and recipes scope started at
  `d138258a13997dfd90dd70d13864c79bb9b643f0`. Top-five source retrieval
  improved from **8/10** to **10/10**, matching the repository's
  `uv run --offline --no-sync meta/search/query.py --mode bm25 --json`
  baseline restricted to the declared paths. The initial misses were a
  check-status document and a recipe whose matching sections competed with
  a documentation page. The baseline reused installed BM25 dependencies
  under Python 3.14 because a full offline environment sync lacked an
  unrelated browser package. There were 21 indexed files and 203 units.
  The final corpus cache was 303,413 bytes. Setup preview and apply took 341
  and 373 ms. Cold and repeat builds took 664 and 559 ms. First and repeat
  queries took 745 and 603 ms.

Ten expectations per shape were frozen before measuring. Cases included
lexical, multilingual or accented, recipe, and exact citation lookup as
applicable to the corpus. The metrics are single wall-clock samples that
include CLI startup. Both trials reopened a committed citation by path and
anchor after assigning an artifact id. A trial-only claim in each clone
recorded a date that already appeared in the original committed evidence.
`knowledge why --as-of <date> --known-at <date>` returned the applicable
claim and excluded it beyond the recorded window. The scope and time controls
in the synthetic suite exercise other source and date combinations.

Both clones ran `work setup` and `knowledge build` in preview and apply modes.
Repeated setup left the manifest intact. Both trials previewed undo and used
`undo --yes` to restore the tracked state, including the ignore file and
authored content. The maintained workflow then used `knowledge impact --changed`,
`verify select --changed`, `verify run --changed --yes` and
`verify status --changed` with the configured scope. The requirements
impact reached two reviewed audit references and their dated claim.
The mixed impact reached a reviewed downstream document. Both used
trial-only sidecars for references confirmed in the source text.

The requirements adapter supplied per-file added line numbers to the native
language audit because its introduced-mode parser skipped diff headers for
paths with spaces. It also checked that existing link targets and headings
had not changed. The successful receipt counted two edited files, and an
intentionally unpaired term produced a failed receipt. The mixed adapter
ran the native convention linter with `--scope size` and `--scope links`,
`--paths` and `--json`. It recorded nine advisory rules and preserved
the runner's advisory semantics. An invalid scope produced a failed receipt.

Verification previews left the receipt ledger untouched. Both trials started
with pending human review and reached verified status after attesting to the
trial edits. A local `work handoff` and `work resume` reopened two obligations
after a follow-up edit while retaining one in the requirements scope and two
in the mixed scope. An unsupported change was reported as unmapped. Both
incremental builds matched a clean build byte for byte. The local Node probe
observed zero guarded network API calls and zero reads of an excluded
sentinel. Neither export included the private sentinel. These probes cover
the commands exercised and do not replace kernel tracing.

## Repository checks

After the trial fixes, the isolated `npm test` run passed 2,763 tests with
zero failures. It reported the existing standalone executable test as
qualification-only. `npm run lint` passed its
structural checks in the isolated clone, and `npm run verify:shipped` passed
all 25 checks. The generated decision index, command reference, package path
parity and first-session command dispatch checks passed.

## Qualification boundary

The [operator guide](../guides/local-work.md) covers incremental adoption,
supported inputs, verification counts and rollback. The trials qualify their
selected paths, repository snapshots and local checks. They used disposable
sidecars, a private trial task and reversible document edits.

An offline wheel built from the source distribution and installed under
CPython 3.9.6. Its vendored command set up a scope, built a corpus, returned a
committed citation and rolled back setup. All 592 vendored files matched the
npm tarball by SHA-256. Full lifecycle qualification covers the npm tarball.
Registry delivery, Homebrew and standalone binaries remain unqualified for
this workflow.
