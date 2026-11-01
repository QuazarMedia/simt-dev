# Plan 0005 — the release process as a repo-local skill

Status: **queued** · created 2026-11-01 · baseline `d69c98e`
Depends on: the v0.7.1 release (done — tag pushed, publish run green, staged on npm).

## Scope

One repo-local skill, `release-process`, that teaches an agent this package's release process end to end: versioning and the release commit, the changelog, tags, the `publish.yml` workflow, npm staging, the downstream channels (`publish-channels.yml` — PyPI and Homebrew), version deprecation, and verification. Plus the recognition and injection the tool already provides for repo-local skills, exercised by the commands an agent actually runs and pinned by tests.

Out of scope:

- Adding the skill to the shipped registry (`graph/skills.graph.json`). The release process is specific to *this* repository; registry content is data projected into every consuming repository, and an instruction that only resolves here is the canonical defect this package's own `AGENTS.md` names.
- Changing the release machinery itself. The skill records it; it does not alter it.

## Why a repo-local skill, and how the tool recognises it

`src/resolve/local.mjs` ranks the repository's own skills alongside the registry, and
`src/projection/disclosure.mjs` tells every agent session they exist. The recognition
mechanism, verified in source:

- `installedSkills(root)` scans exactly four directories — `.agents/skills`,
  `.cursor/skills`, `.claude/skills`, `.opencode/skills` — reading each
  `SKILL.md`'s frontmatter `name` and `description` (the trigger). A symlink
  fan-out dedupes to one skill; the `name` must equal the directory name
  (Agent Skills spec).
- `localSkillNodes` builds a resolver node per installed skill, **excluding names the
  registry declares** (the registry is canonical; a local copy would rank twice), with
  the repo's own stack so the stack gate always passes, and `deferred` derived from the
  20,000-byte body budget.
- Injection has two paths: `simt sync --yes` renders a `## Disclosure` section into the
  generated `AGENTS.md` region (one line per installed skill: `- name — trigger`), and
  on demand `simt skills find` / `simt skills brief --task` rank and inline local
  bodies, `simt skills show <name>` prints one.

The repository's own `skills/` directory is the registry's source location and is not
scanned; none of the four dot-dirs exists in this repository yet, so `release-process`
lands in `.agents/skills/` (the canonical directory `skillsDir` invents when none of the
others exists) with a symlink fan-out for the surfaces `simt.json` declares.

The release machinery the skill records is settled by ADR-058, ADR-059, ADR-097,
ADR-099 and ADR-117 (all accepted): a `release:` commit plus a lightweight tag starts
`publish.yml`, which guards the tag against `package.json`, runs the suite, and stages
the npm channel for a maintainer's 2FA approval; the downstream channels run by hand
from `publish-channels.yml` with the version as an input; the committed Homebrew formula
is re-rendered from the served bytes. `RELEASING.md` records the burned versions
(`0.0.0-stage`, `1.0.0`) and the deprecation commands.

## The open decisions, resolved

The authority docs leave no material decision open:

- **Name and location** — dictated by the recognition mechanism above (four dirs,
  `name` = directory name, `skillsDir` invents `.agents/skills`).
- **Local, not registry** — dictated by the projection rule in this repository's
  `AGENTS.md`: every byte that leaves the repository must resolve in the reader.
- **`localSkills` schema** — `src/manifest/schema.mjs` validates `localSkills` as a
  list of strings while the tool's own writer (`recordLocal` in
  `src/commands/skillsinstall.mjs`) appends record objects. S2 verifies empirically and,
  if the manifest is flagged on every load, widens the check to accept strings or
  record objects — a one-line fix, in scope.

## Tracker

| id | slice | state | evidence |
| --- | --- | --- | --- |
| S1 | the skill body | Complete | ca2864ed51782af205768f97c4d1acd30ee78b1b · test: frontmatter parses; 4202 bytes under the 20k deferral budget; every cited path, command and ADR resolves in-repo |
| S2 | the tool recognises and injects it | Complete | f2331ada47515a18f807e7f5ffc8b33c91bb04b3 · test: skills find release ranks release-process (name:release); skills brief --task 'release 0.7.2' selects it within budget and inlines the body; skills show release-process prints it; sync --yes renders the Disclosure line; check reports the region CURRENT; manifestProblems(simt.json) = [] |
| S3 | the recognition is pinned by a test | Complete | 9b4ed4de7307dad822f4b182def8409ad3605043 · test: node --test test/resolve.test.mjs test/disclosure.test.mjs 54/54 pass incl. the new release-instance test; npm run test 1701/1701 pass |

## S1 — the skill body

**Goal.** Hand-author `.agents/skills/release-process/SKILL.md`: frontmatter with
`name: release-process` and a `description` that is the release-work trigger, and a body
under the 20,000-byte deferral budget that records the process as an agent would run
it.

**Content, in release order:**

1. **Cut the version** — the `release: simt-dev <version> (<kind>; <summary>)` commit
   (Conventional Commits, `Co-Authored-By` trailer) carrying the `CHANGELOG.md` section
   (`## [X.Y.Z] — YYYY-MM-DD`, `### Added` / `### Changed` / `### Fixed`), the
   `package.json` bump, and the `simt.json` `projection.version` pin agreeing
   (ADR-059) — the 0.7.1 release shipped with the bump and pin landing in follow-up
   commits, and the version guard caught it.
2. **Tag** — lightweight `vX.Y.Z` on the release commit; `publish.yml` fires on `push:
   tags: ['v*']`.
3. **`publish.yml`** — the version guard, the suite, the skill-registry lint, the wheel
   parity check, `npm stage publish`, and the `npm stage list` step that hands a
   maintainer the stage id for `npm stage approve`.
4. **Downstream channels** — `gh workflow run publish-channels.yml [-f version=X.Y.Z]`:
   PyPI (requires the npm channel to serve the version first) and Homebrew (renders
   `Formula/simt-dev.rb` from the published assets' checksums, pushes the tap), with
   `verify-brew` proving the tap serves the release.
5. **Verification** — `npm view simt-dev version`, the release assets and `.sha256`
   files, the formula, and the tap.
6. **Deprecation** — `npm deprecate` is an owner action; the burned versions and their
   commands live in `RELEASING.md`; `test/packaging.test.mjs` guards the version
   against the placeholders.

**Accept.**

- Frontmatter parses; `name` equals the directory name; the description reads as a
  trigger a release-tasking agent would match.
- Body is under 20,000 bytes, so the node is not `deferred`.
- Every path, command and ADR it cites resolves in this repository.

## S2 — the tool recognises and injects it

**Goal.** With the skill on disk, demonstrate the two injection paths with the
repository's own commands, and record its provenance the way the tool records it.

**Accept.**

- `simt skills find release` ranks `release-process` with a named score.
- `simt skills brief --task "release 0.7.2"` selects it within budget and inlines the
  body.
- `simt skills show release-process` prints the body.
- `simt sync --yes` renders the Disclosure line `- release-process — <trigger>` in the
  generated `AGENTS.md` region, and `simt check` reports the region current; the
  `simt.json` `localSkills` record carries `{name, from, variant, bytes, sha}`.
- If the manifest schema flags the object record on every load, the widened check
  lands in this slice and `simt check` is clean.

## S3 — the recognition is pinned by a test

**Goal.** A behavioural test delta proving the mechanism a repository-local skill rides
on, in a fixture so the test does not depend on this checkout's contents (ADR-031): a
repository with a `.agents/skills/<name>/SKILL.md` is recognised by `skills find`,
disclosed with its trigger, and its body inlined by `skills brief` for a matching task;
a local copy of a registry skill still ranks once.

**Accept.**

- The new test(s) pass under `node --test <file>` through the repository's runner.
- The full suite stays green: `npm run test` exits 0.
