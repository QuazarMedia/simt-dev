---
simt-id: bun
simt-title: Bun
simt-applies: [has-bun-lock]
simt-priority: convention
simt-scope: ["package.json", "bun.lock", "bun.lockb", "bunfig.toml"]
---

# Stack profile: Bun

Applies to: Node repositories with a committed `bun.lock` or `bun.lockb`.

## Runner

- Bun is this repository's committed package-manager evidence. Invoke declared
  `package.json` scripts with `bun run <script>`; never substitute `npm run`,
  `npm test`, `npx` or another manager's global runner.
- Keep script bodies manager-neutral. A script that hard-codes npm or npx is a defect
  to fix in the script, not a reason to bypass Bun.
- Keep `packageManager` and `engines.node` consistent with the lockfile and CI. Commit
  the lockfile and use the repository's frozen install command in automation.
- Resolve declared tools from project dependencies. Do not fetch an unpinned package
  with `bun x` merely because a local binary is missing.

## Scripts, format and tests

- Script names are the command contract. Add or rename build, lint, format-check,
  typecheck and test scripts in `package.json`, then update every caller in the same
  change.
- Use the declared format-check script for hooks and CI. Generated and vendored output
  stays out of formatting and test globs.
- Keep one test runner and make the test script own the full-suite invocation. The
  command card carries the repository's scripts; it does not invent a Bun-specific
  replacement for them.
- TypeScript remains strict where the repository uses it. A Bun runtime does not make
  erased types a typecheck.
