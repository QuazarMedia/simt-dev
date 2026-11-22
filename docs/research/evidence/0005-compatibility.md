# Research Plan 0005 installed-consumer qualification

The D38 candidate ran `SIMT_QUALIFY_SEA=1 npm test` in a fresh isolated
clone on macOS arm64. All 2,943 tests passed with zero skipped tests.
The source suite's npm pack was installed offline into a temporary directory
and has zero runtime dependencies.

## Consumer matrix

The installed package exercised Node and TypeScript, Python and uv, Go,
Rust, Kotlin and Android, knowledge-only, and mixed monorepo repositories.
The matrix covered `brief`, `map`, `impact`, `why`, `check`, `gate`,
`tests`, and `knowledge rank`. It compared gate and test selections, map
output across locales, and generated `AGENTS.md` bytes before and after the
commands.

A cold MCP brief returned the index remedy without creating a database.
Warm MCP brief, impact and check results matched the corresponding CLI
fields. The installed package upgraded a v5 SQLite index and preserved a
newer database byte for byte while serving its own sidecar.

## Artifacts

- `npm run verify:wheel` compared 690 runtime paths across npm and the
  Python wheel. The wheel installed without dependencies and its launcher
  indexed a receiving repository and returned the expected map result.
- `npm run build:sea -- darwin-arm64 darwin-x64 linux-x64` produced all
  supported binaries and SHA-256 files from the pinned Node floor. The
  arm64 binary passed the Gradle and hook acceptance with Node absent
  from PATH. The Intel binary ran `index` and `map` under Rosetta with
  native Git on PATH.
- The Linux x64 artifact was built and identified as an ELF executable.
  Linux runtime, platform determinism and Linux installer behavior remain
  unverified. The available Docker environment could not start.

## Compatibility repairs

The MCP request validator now enforces the advertised minimum target
length. Symbol impact follows the file import frontier when it reaches a
module-level call or reference with no caller symbol, preserving its
downstream tests. The line check retains the vendored dependency exclusion
in nested packages.

The D37 structural stratum was replayed after the repair. Across 30 cases,
full-v2 recall rose from 0.75 to 1.00 while hub noise stayed at 0.00. The
D37 mined and composite results still govern the default rollout.
