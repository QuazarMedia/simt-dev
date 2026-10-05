# ADR-017 — A declared gate must be one the repo can actually run

Status: **accepted** · 2026-10-06
Affects: `hooks/capability.mjs`, `projection/manifest.mjs`, `commands/init.mjs`, `commands/sync.mjs` (`check`), `hooks/dispatcher.mjs`

## Context

The first real adoption wrote a manifest declaring five gates into `simt-social-media`.
Three of them could not run:

| Gate | Kind | Why it could not run |
|---|---|---|
| `format` | staged | prettier is not a dependency and is not in `node_modules/.bin` |
| `lint` | script | there is no `lint` script in `package.json` |
| `i18n-completeness` | command | nothing is declared under `gates.commands` |

It reported as healthy. `simt-dev check` was green, the projected files were current, and the
repo's own 37 tests passed. The defect was invisible to all of that because nothing had asked
whether the gates could run — the stack table proposed them from the repo's tags, and the tags
said `node` and `cloudflare-workers`, which is true.

The dispatcher would have caught it, and correctly: it fails closed. Installing it on that
manifest blocks **every commit** with `FAILED format … [ADR-004]`. So the first thing a new
user does after adopting simt-dev is discover that the tool makes committing impossible, and
the only escape any of them will find is `--no-verify`.

That is the exact spiral the dispatcher was built to prevent. Step 8's design note says a gate
that cannot run must be a failure rather than a skip, precisely because `simt-space` removed
tests from `pre-commit` for being slow and the team's answer was `--no-verify`. Failing closed
is right; declaring an unrunnable gate is wrong.

Two further facts made it survivable for as long as it was:

- **Nothing else owns the manifest.** `sync` writes the projected rules; `init` writes the
  manifest. A manifest written by an older version is therefore never revisited, which is the
  same class of bug as the stale `$comment` fixed in `c607d0a`.
- **`hooks status` already said so** — *"gate `i18n-completeness` in preCommit is a command
  gate with no declared command; the hook will fail"*. The information existed. It was printed
  by the one command nobody runs before installing hooks.

## Rulings

1. **A gate is declared only if the repo can run it.** `init` filters the stack table's
   proposals through what the repo demonstrably has: a script that exists in `package.json`,
   a binary installed in `node_modules/.bin`, a command the manifest itself names. This is
   `has-*` fact discipline applied to gates (ADR-013): detection reports evidence, it does not
   assume capability.

2. **Every drop is named, with the remedy that undoes it.** A silently shorter gate list reads
   as "this repo needs no formatting check", when the truth is "declaring one would block every
   commit". The three ways to make a gate runnable are a real choice the repo owns, so the
   reader is given all three — install the tool, add the script, or name the command.

3. **A gate the repo already declared is never dropped.** Quietly disarming a gate somebody
   declared on purpose is a worse surprise than a visible one, and a re-init that silently
   removed gates would make the gate list look like simt-dev's opinion rather than the repo's.

4. **`check` reports an unrunnable declared gate as a finding.** The repo must be red *before*
   anyone installs hooks, not after. `check` is the gate that runs in CI, so this is where a
   landmine belongs; `hooks status` saying so is not enough when it is the command nobody runs.

5. **The remedy differs by whether a manifest already exists.** A re-init never re-adds a gate
   to a manifest that already declares one, so on an existing manifest "install prettier, then
   re-run init" would send the reader round the loop and back to where they started. The remedy
   there names the declaration as the second half of the fix.

## Consequences

- `simt init` needs to read the repo before it writes the manifest, so `init` now depends on
  the hooks subsystem. The dependency runs one way: `gates.mjs` imports nothing.
- `check` is no longer only about the generated rules. It is the gate over what the manifest
  promises, which is what a gate is for.
- A repo whose only answer is "no tool for any of these" gets `preCommit: []`. That is a valid
  manifest, and the dispatcher says so in one line rather than passing in silence. A string
  where the caller expected an array once printed that line one character at a time.

## Rejected

- **Fail open in the dispatcher when a gate cannot run.** The spiral is the point; failing open
  makes the tool's green meaningless, which is worse than a blocked commit because it is silent.
- **Infer capability from the dependency graph.** A repo with `prettier` in `devDependencies`
  and no `node_modules` cannot run a formatter. Reading the manifest and the installed binaries
  are two facts; guessing a third from a lockfile is how the two get to disagree.
- **Have `init` refuse to adopt a repo that cannot run its gates.** Refusing is worse than
  writing fewer gates: the repo gets no rules at all, and the obstacle is a formatting tool.
- **Leave it to `hooks status`.** It is the command run after installing hooks, which is one
  step after the commit that fails.
- **Drop unrunnable gates on re-init too.** Silently; the reader sees a shorter list and no
  explanation, and cannot tell a removed gate from one that was never there.