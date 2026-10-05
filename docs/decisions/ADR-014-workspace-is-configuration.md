# ADR-014 — The workspace is configuration, and a single repo is a first-class case

Status: **accepted** · 2026-10-05
Affects: `simt-dev` CLI (workspace resolution, `compare`, `skills`, registry validation, packaging)

## Context

ADR-013 made the *vocabulary* generic. It did not make the *filesystem layout* generic, and the
gap was invisible from inside the checkout. Three failures were measured rather than reasoned
about, by running the tool from a throwaway repo outside `/code/simt` and from a simulated
`node_modules` install:

1. **Every `skills` command and `graph lint` fails outside the SIMT workspace.** `WORKSPACE_ROOT`
   was `resolve(HERE, '..', '..', '..')` — three levels up from the source file. In the checkout
   that is `/code/simt`, which is correct. In an npm install it is
   `node_modules/@quazarmedia`:

   | install location | `WORKSPACE_ROOT` resolves to |
   |---|---|
   | `/code/simt/simt-dev/src/graph` | `/code/simt` — correct |
   | `…/node_modules/@quazarmedia/simt-dev/src/graph` | `…/node_modules/@quazarmedia` — wrong |

   The symptom is `ENOENT` for all 38 sources. The *remedy* printed is
   `run: simt graph lint`, which is itself wrong, because the reader has no workspace to lint.

2. **`rules why` cannot work in the published package.** `package.json` `files` lists
   `bin src graph rules skills agents tooling hooks` and not `docs`. `npm pack` produces 39 files
   and zero from `docs/`, so every ADR lookup fails in a real install. The whole provenance
   feature — the reason `rules why` exists — is unusable outside the checkout.

3. **`compare` treats a repo as a workspace and rejects it.** `--root <a-repo>` fails with
   `contains no git repositories` and exit 3, because `discover` scans the *children* of the
   given directory. The most common invocation outside a multi-repo workspace — point the tool at
   one repo — is an error. The remedy, `no git repositories found under <path>`, is also
   misleading: there is one, you are standing in it.

None of this was visible in the tests, because every test ran from the checkout. That is the
general lesson and it is the reason this record exists: **a tool's own layout is part of its
interface, and a test suite that only runs the tool from its source tree cannot detect that the
tool only works from its source tree.**

The related question — how does `simt upgrade` know which repos to bump? — has the same root
cause. There is no consumer registry on disk. The only thing aware of sibling repos is
`compare`'s one-level-deep scan, rooted at `..` of the *current checkout*. That is why
`compare` already prints `run: simt upgrade` for every drifted repo: the detection half exists and
the remedy is a dangling reference.

## Ruling

### 1. The workspace is configuration, resolved in a fixed, reported order

Precedence, highest first:

1. `--workspace <path>` — an explicit flag always wins.
2. `SIMT_DEV_WORKSPACE` — the environment variable, for CI and one-off invocations.
3. A user config file at the platform's conventional location (§2).
4. The sibling heuristic — the parent of this package, when that parent actually contains git
   repositories. This is what makes a fresh clone of the checkout work with no configuration at
   all, and it is a **heuristic, not a rule**: it is consulted last and it is only accepted when
   it verifies.

**Every command that consults the workspace reports where it came from.** `simt doctor` prints
the resolved root and its source. An invisible configuration is a configuration nobody can debug,
and a silent fallback to a wrong directory is the worst outcome available: every answer is then
confidently wrong.

### 2. The user config file lives where the platform expects it, with a documented fallback

Candidate paths, searched in order; the first that exists wins, and the first is the one named
when reporting a path to create:

| Platform | Candidates, in order |
|---|---|
| any | `$XDG_CONFIG_HOME/simt-dev/config.json` |
| POSIX | `$HOME/.config/simt-dev/config.json` |
| macOS | `$HOME/Library/Application Support/simt-dev/config.json` |
| Windows | `%APPDATA%/simt-dev/config.json` |

`$XDG_CONFIG_HOME` first because it is the only way to *override* the location on a POSIX system,
and honouring an explicit override before guessing is the whole point. macOS is listed after the
XDG candidates deliberately: `~/Library/Application Support` is Apple's documented location for
application data, but a tool that honours XDG where set is friendlier to a developer who already
uses it, and the fallback means neither convention is unsupported.

The file is JSON. Its shape is deliberately **not** a workspace-shaped object:

```json
{
  "workspace": "/path/containing/repos"
}
```

`workspace` is an optional key. An empty, absent or unreadable file is not an error — it means
"not configured", and resolution continues down the precedence list. Only a file that exists and
does not parse is reported, because that is a real mistake the reader can fix.

Windows appears in the table although [ADR-012](ADR-012-drop-windows-support.md) drops Windows
support. The lookup function stays total so it is testable on any host and correct if that
reversal ever happens; `package.json` still refuses to install on Windows.

### 3. A workspace is optional; a single repo is a normal, supported case

Every command that needs a workspace must work with **one repo and no workspace at all**. Concretely:

- `compare --root <path>` where `<path>` is a repository compares that repository. Where it is a
  directory, its git-repository children are compared. The distinction is detected, not configured,
  because the two cases are already distinguishable from the filesystem.
- Discovery no longer reports "no git repositories" when it is standing in one.
- Nothing anywhere requires a second repo to exist.

### 4. A missing workspace is a fact, reported once — never a fatal error

When no workspace is configured and the heuristic does not verify, the skill catalogue cannot be
resolved from disk. That is a **warning with one remedy**, not an error:

```
WARNING skill sources are not available: no workspace configured
REMEDY  set one with --workspace <path>, SIMT_DEV_WORKSPACE, or the config file
```

Registry disk verification is **skipped** in that state, with the skip itself reported by
`graph lint`. The alternative — 38 `ENOENT` lines — teaches the reader that the lint is noisy,
and a lint that is always noisy is a lint that is always ignored.

The exit code follows the same principle as `compare`'s non-adoption rule
([ADR-013](ADR-013-genericity-by-facts-and-local-profiles.md), and step 9 of plan 0002): exit
non-zero when something is **wrong**, zero when something is merely **absent**.

### 5. The decision records ship with the package

`docs/decisions` is added to `package.json` `files`. A feature whose input is not packaged is not
a feature; `rules why` is the provenance mechanism the whole one-canonical-home doctrine rests
on, and it cannot depend on a git checkout being present.

`docs/plans` ships with it, because every non-zero exit prints a remedy pointing at
`docs/plans/0002-simt-dev-cli.md section 11`.

### 6. "Absent", "wrong" and "moved" are three different facts

Section 4 settled the case where **no** workspace is configured. Writing the tests for it exposed
two more, and they are not the same case:

| State | Reported as |
|---|---|
| Nothing configured | `no workspace configured` + the remedy |
| Configured, directory **missing** | `the configured workspace <path> (from <source>) does not exist` |
| Configured, directory exists but **holds none of the named repositories** | `<path> contains none of the repositories the registry names (…)` |

All three are warnings and all three skip disk verification. What changed is the **specificity**
of the message, and that specificity is the whole value: "you configured nothing" and "you
configured the wrong directory" are different problems with different fixes, and the reader can
only fix the one they are told about.

The third state is the one that mattered. Existence is not a sufficient test for a workspace, and
before this section `--workspace <an empty directory>` produced 38 `ENOENT` lines reading as a
broken registry — precisely backwards, because the registry is fine and the pointer is wrong. So
verification requires that the workspace hold at least one of the repositories the registry
names, checked before any file is measured.

### 7. A workspace can be declined, and a broken config is reported whatever outranks it

Two things the first implementation got wrong, both found by running the CLI rather than by
testing a function:

- **There was no way to say "no workspace".** The sibling heuristic always fired when nothing
  was configured, so a reader who did not want a directory guessed for them had no way to refuse
  — and no test running from the checkout could reach the unconfigured path at all, because the
  checkout always has a verifying sibling. `--workspace off`, `SIMT_DEV_WORKSPACE=off` and
  `"workspace": "off"` now all mean *declined*, and return the same shape as any other answer so
  callers need no special case.
- **A config file that does not parse was only read if nothing outranked it.** Precedence decided
  the *answer*, but it was also suppressing a *defect*: an unparseable config is a real mistake in
  the reader's setup, and hiding it because `SIMT_DEV_WORKSPACE` happened to be set sends them
  looking for a configuration problem in the wrong place. The config file is therefore read
  first, and a parse failure is returned immediately.

That second bug is the standing lesson of this record, discovered by its own meta-lesson:
`configPaths` defaulted `env` to `{}` so that tests could inject a fake environment, which meant
`XDG_CONFIG_HOME` — the one documented way to *override* the config location — was ignored on
every real invocation. Every unit test passed `{env}` explicitly. **A test that supplies a
dependency explicitly cannot detect that the default for that dependency is wrong.**

## Consequences

- The checkout keeps working with zero configuration, because the sibling heuristic is consulted
  last and verified.
- A single developer with one repository never has to learn what a workspace is. `compare`,
  `rules`, `sync`, `check`, `hooks` and `init` all work against one repo.
- The skill catalogue — which is SIMT content — degrades to a single warning outside the SIMT
  workspace, while the *rules* engine stays fully functional, because `rules/` ships in the
  package and `rules/*.md` has no external sources.
- `simt upgrade` gets a real answer for consumer discovery: the resolved workspace, plus an
  explicit `--root` for a single repo. No consumer list needs to be maintained in simt-dev,
  because a repo that has not adopted cannot be listed by the thing it has not adopted.

## Rejected

- **A consumer list inside simt-dev.** A repo that has not adopted has no manifest, so it cannot
  appear in a manifest kept by the tool it has not adopted. Discovery has to come from the
  filesystem.
- **Inferring the workspace from git remotes.** Fragile, and wrong in the common case: several
  sibling repos legitimately share one remote organisation, and a personal fork of one repo has a
  remote that points nowhere useful.
- **Requiring a workspace.** It would make the common case — one repo, one user, no org — pay a
  configuration tax to use a tool whose rules engine is already ecosystem-neutral.
- **A machine-wide registry of skill sources.** A directory of symlinks into the workspace would
  reintroduce exactly the cross-repo symlink fragility that made plan 0001 choose a generated
  projection instead.
- **Treating an unresolvable workspace as a registry error.** Same failure as printing 38
  `ENOENT` lines: it converts an absent thing into a loud failure and trains the reader to ignore
  the output.