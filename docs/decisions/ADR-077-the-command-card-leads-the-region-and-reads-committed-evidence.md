# ADR-077 — The command card leads the region, and is derived from committed evidence only

Status: **accepted** · 2026-10-16 · filed as R10 (plan 0003)
**Affects:** `src/kernel/card.mjs`, `src/projection/rules.mjs`, `rules/core.md` (indirectly, as
the region's first bytes), `test/card.test.mjs`

## Context

Plan 0003 R10 asks for the highest-value, non-inferable bytes: the exact commands for *this*
repository, at the top of the region, in a block of at most 600 B, "derived from gates and
runner detection alone, so it needs no index". A reader who has the rules has the same rules
every other repository has; what they cannot infer is that *their* tests run under
`./gradlew :app:testDebugUnitTest` and not `npm test`.

Two things the plan leaves open, and both are the kind an implementer gets wrong once:

1. **Which modes carry the card.** R07's kernel is a smaller projection a repository asks
   for (ADR-073), and R10 says "at the top of the kernel". Read literally, the card would
   appear only for the repositories that opted into kernel mode — that is, only for the
   readers who already measured that they can do without guidance. The reader who kept
   `full` is the one who has the commands nowhere.

2. **What evidence the card may read.** "Runner detection" has two possible meanings here.
   `readCapability` answers "can this machine run it" by probing PATH and `node_modules`,
   and that answer is machine-specific. But the projected region is required to be
   byte-identical on two machines (plan 0003 P4 and R13): the whole reason the tool has no
   model and no network is that a pull request can meaningfully diff a projection. A card
   that named whichever linter happened to be installed would differ between a laptop and
   CI for no reason a diff could explain, and `check` would flake on a clean tree.

## Rulings

1. **The card leads the region in both modes.** `full` and `kernel` differ in which *rules*
   are packed (ADR-073 ruling 5); neither withholds the commands. The card is bytes the
   reader most needs and the rules never carry, so it is above even the core, and it is not
   a rule the kernel can defer.

2. **It is derived from committed evidence only.** Three sources, in precedence order: the
   manifest's declared `gates.commands`, the repository's own `package.json` scripts, and
   the marker facts that name its ecosystem. It never reads PATH or `node_modules`.
   Runnability is a property of the machine; a command is a property of the repository, and
   only the second belongs in bytes that leave it.

3. **The ecosystem table is the single source, and the gate list cannot disagree with it.**
   The fallback for a marker that has no declared command is the same `ECOSYSTEMS` table
   `manifest.mjs` seeds gates from. Two tables would eventually name two different test
   commands for one repository, which is the drift this tool exists to remove. Python is the
   one ecosystem the table does not seed, because its runner varies (uv, poetry, tox, nox); the
   card still names the command a committed lockfile proves — `uv run -m pytest`, never
   `uv run pytest`, because the uv profile is explicit that the console entrypoint can run a
   different copy of the package than the one under test.

4. **A template is labelled as a template, per path kind.** The focused-test entries carry
   `{file}`, `{pkg}`, `{Test}` and `{class}` placeholders and are labelled by the kind of
   path they apply to, so a reader never pastes a brace into a shell. Which test a given
   `{file}` maps to is R24's refinement, not R10's.

5. **The ceiling is 600 B, enforced by dropping whole lines, never silently.** Lines drop in
   a stated order — `format`, `typecheck`, `lint`, `build`, then focused templates from the
   last — and `test` is never among them, because a card that dropped the test command would
   have dropped the command it exists to carry. Every drop is named in the projection notes;
   a card that lost a command in silence is a card the reader cannot tell is incomplete.

6. **It is computed in `desiredRegion`, the one place the region is computed.** `plan` and
   `checkTarget` therefore cannot hold two opinions about the same card, which is the same
   property that keeps a clean tree from reporting drift (the comment on `desiredRegion`).

## Consequences

Every adopted repository's region gains the card on the next `sync`, in both modes. That is
the point of the slice: the bytes were absent everywhere, and the ones added are the ones a
reader can act on. The card is derived, so it moves only when the repository's own commands
move — a new `package.json` script, a declared command, or a marker file appearing.

What is not here: which test a `{file}` should be mapped to (R24), the inferability filter
that would drop a card line the repository already states (R09), and the cost measurement
that would say whether the card earns its bytes (R02, R27). This ruling is what makes those
measurable rather than what concludes them.

## Rejected

- **Kernel mode only.** It withholds the card from the readers who kept the larger
  projection, which is all of them until R02 has run.
- **Probing PATH or `node_modules`** so the card shows only commands that will run here. The
  answer would not survive a second machine, and the region is required to.
- **Writing the commands as rule text.** The commands are data about one repository; a rule
  is the same in every repository, and a rule that stated one repository's test command would
  be wrong in every other.
- **Letting the card grow past 600 B, or trimming it silently.** An unbounded card is a
  second copy of the rules, and a silently short one is a reader who trusts a card that is
  missing a command.
