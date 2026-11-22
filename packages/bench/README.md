# @simt-dev/bench

The optional benchmark package for `simt-dev`: task mining, agent runs, grading, probes,
world models and evaluation reports. The core package does not carry it and does not import
it; `simt bench ...` loads this package when it is installed.

## Install

Install `simt-dev` first, then the bench package built for the same version:

```sh
node scripts/build-bench-package.mjs dist/bench
npm pack dist/bench --pack-destination dist
npm install dist/simt-dev-bench-*.tgz
```

A released pair installs by name: `npm install simt-dev @simt-dev/bench`. Install the tarball
rather than the directory: npm symlinks a directory install, and the package's core imports
would then resolve beside the source checkout rather than beside `simt-dev`.

The build rewrites the package's relative core imports to the core's public exact
`simt-dev/src/<module>` exports — one explicit entry per module in `package.json`'s
`exports` map, no `./src/*` wildcard — and records `simt-dev` as a peer dependency, so the
two packages share one core rather than installing a second copy. Without the package, every
`simt bench` command exits `UNSUPPORTED` with the install remedy; the rest of the CLI, API
and MCP surface runs unchanged.

Replay and calibration answer from one JSON document and run offline. They are retained
here because their vocabulary is the bench's, not the core's.

## Replay retrieval ablations offline

Run `simt bench ablate --input observations.json --json` to grade previously
captured retrieval results. Use `--arm +bm25f-ident` to compare one arm with
`baseline-v1`. Gaps in the evidence appear as missing observations.

The input contains three objects of interest.

- `tasks` lists public task descriptors with `id`, `stratum`, and `prompt`.
- `gold` maps task IDs to expected evidence. Use `files` for lexical or
  vocabulary-gap tasks, `subtasks` for composite tasks, and `impact` plus
  `governance` for structural tasks.
- `observations` maps arm names to task IDs and their observed results. A
  lexical observation contains a `ranking` array. A composite observation
  contains `packets` at byte budgets 1024, 2048 and 4096, each with `text`,
  `files` and `facets`. A structural observation contains `impact` and
  `governance` arrays of returned identifiers.

The live runner takes a local evaluator and supplies only the public task,
fixture files, arm features and budgets. It rejects any change in output
bytes across repeated calls or reversed file enumeration before grading.
