# ADR-083 — A budget is met by cutting the kernel, and the hard constraints are the floor

Status: **accepted** · 2026-10-17 · filed as R08 (plan 0003)

**Affects:** `src/kernel/budget.mjs`, `src/projection/rules.mjs`, `src/projection/manifest.mjs`,
`src/measure/context.mjs`, `src/projection/project.mjs`, `src/commands/sync.mjs`,
`test/kernel.test.mjs`, `test/tokens.test.mjs`, `test/surfaces.test.mjs`

## Context

ADR-072 shipped the number: `budget.bytes` at the top level of the manifest, 30 000 bytes by
default, reported by `simt tokens` and raised by `check`, both non-blocking. It recorded what had
not landed and why — the packing needed a kernel, and the kernel was R07.

ADR-073 shipped the kernel. A repository declares `mode: kernel`, every rule declares its class
in its own frontmatter, and the mode packs `hard` and `command` while naming everything else in
the region with the command that fetches it. R08's accept criterion — the budget is never
exceeded — is now reachable, and this record is the part that reaches it.

Three facts about the number made the shape of this a decision rather than a loop.

The first is that the budget is one number and the meter bills more than the region. A generated
rule file is billed whole, a managed skill by its name and description, the region by the span
between its markers. A repository whose rules live in per-rule files has paid for those files
whether or not the region fits; packing the region against the whole declared number ships a
projection that fits on its own and is over the line the moment its rule files are written. On a
fixture with a Cursor surface, three `.mdc` files billed 6,552 B beside a 15,725 B region.

The second is the region's own span. It is the one number that moves when the projection is
packed, so a ceiling derived from it would make `sync` rewrite the file it had just written and
then report drift on a clean tree.

The third is what ADR-072 already ruled and R08's text has not caught up with: the key is
`budget.bytes`, not `projection.budget.bytes`. The plan is not edited. `projection` is a
generated key, `upgrade` replaces it wholesale, and a budget written there would disappear on a
green gate.

## Rulings

1. **One reader for the declared number.** `declaredBudget(manifest)` in `manifest.mjs` is the
   only place `budget.bytes` is interpreted, and both the packer and `measureRoot` call it. A
   finite non-negative value is taken as declared, including `0` — "this repository wants an
   empty projection" is a decision somebody can make — and anything else (a string, `NaN`, a
   negative) falls back to the review figure, because the one reading that cannot silently
   produce compliance is the one where a typo is not a ceiling.

2. **Nothing is cut in `full` mode.** ADR-072's finding already tells the reader "nothing was cut:
   the projection is still in full mode", and a full projection that quietly lost a rule would
   make the tool lie about itself in its own words. `desiredRegion` returns `budget: null` there,
   not an empty cut list, so a reader of the field cannot conclude a cut happened when the mode
   made none possible.

3. **`hard` is the floor.** A priority class exists to say what a reader loses by not having the
   line, and a byte count is not a reader. The packer skips `hard` instead of cutting it, and the
   leftover is a distinct fact — `floorHeld` — reported as such: the notes say the kernel is still
   over after every rule outside the hard class went, and that a hard constraint is not cut to
   reach a byte count. The levers that remain are the repository's own, which is exactly what
   ADR-072's kernel wording already tells the reader. One case gets its own sentence: when the
   reserve alone reaches the declared budget the ceiling is zero or less, which is arithmetically
   true and unreadable — it does not say that the files loading beside the region already spent
   the whole budget — so the notes say that, because a reader left to infer it from a subtraction
   is a reader who demotes a hard rule to fix a number they set too low.

4. **The ceiling is the declared budget minus a reserve, and the region's own span is in
   neither term.** The reserve is the larger of what the meter already bills outside the region
   (what is installed) and what this projection is about to write as rule files (what a
   repository that has not run `sync` yet will pay). Both are lower bounds; the larger is taken
   because the failure each would otherwise cause is the one that must not happen — under-
   reserving reports compliance for a projection that is over. The region's span is excluded
   deliberately, per the second fact above. A folded single-surface repository reserves nothing,
   which is correct rather than untested: `opencode` reads `AGENTS.md` and writes no rule files,
   so there is nothing beside the region to pay for.

5. **The cut order is the region's own order reversed, and it is fixed before any cost is
   computed.** Class, then rule id — the comparator the deferred section already uses, least
   valuable first. Which class a reader can best afford to lose is declared by the rules
   themselves (ADR-073 ruling 3); what is left here is arithmetic, so the order is handed in and
   the module that packs does not second-guess it.

6. **A cut costs what the document then weighs, not the rule's own length.** Three things move
   when a rule leaves: the provenance header drops a source, the deferred section gains a line
   naming what left, and both move again as the cut list grows. So each attempt re-renders the
   region and weighs it — `costs(cut)` returning `Buffer.byteLength(compose(...))`, markers and
   provenance header included, one byte conservative because the file's trailing newline falls
   outside the meter's span and conservative is the only direction a ceiling can afford. The loop
   stops the moment it fits, so a budget never costs a rule it did not have to. This is the
   command card's `CARD_LIMIT_BYTES` idiom (ADR-077) applied to the region instead of the card.

7. **One list, two reasons.** Class-deferred and budget-cut rules share the region's existing
   `## Deferred rules` section, and each line says which it was: `deferred in kernel mode` or
   `cut to fit the declared budget of N bytes`, both naming `simt rules show <id>`. A second
   heading would spend region bytes on a distinction the reader acts on identically, and a cut
   line that did not say why would be indistinguishable from a kernel decision nobody made.

8. **`BUDGET-CUT` is a finding, non-blocking in both commands, and carries the numbers a reader
   needs to judge it.** The detail gives `before → after`, the declared budget, the reserve when
   it is not zero, and every cut rule by id and class; the remedy is a decision
   (`raise budget.bytes to <before + reserve>`, the budget that would have admitted the region
   as it stood — `before` alone would leave the cut in place, because the ceiling it was cut
   against is the budget less the reserve), not a place to go and look. Non-blocking for ADR-072's
   reason: the cut is the tool doing what the repository asked, and a gate that failed here would
   fail a repository for shipping a smaller projection. `sync` prints the same two facts as notes
   so the cut is never silent from either command.

9. **`simt tokens` keeps no second opinion.** ADR-064 kept the meter to one measurement, and the
   packer's arithmetic is not substituted for it anywhere: the meter reports the bytes it finds
   against the declared line, and the end-to-end test judges the cut with the meter's number
   rather than the packer's. A packer that reports compliance for a projection the meter says is
   over budget is the failure this arrangement is arranged against, so the test asserts the
   meter's number even where the packer's own numbers are already visible in the same object.

## Consequences

A repository that declares `mode: kernel` and a budget its rules do not fit gets a smaller
projection, a list of what left and why, and a note from both `sync` and `check`. The accept
criterion is checkable end to end rather than asserted: a fixture declares a budget a thousand
bytes under its own projection, syncs, and `simt tokens` reports `over: false` with the declared
line intact — and a second fixture, whose rule files are billed beside the region, is cut further
than the region alone would have needed, which is the only way the reserve can be seen to work.

The costs are accepted rather than avoided. In kernel mode a projection is now measured
(`measureRoot`) and its rule targets rendered a second time (`ruleTargets`) on every
`desiredRegion`, where previously the region's bytes were composed once. `measureRoot` is reached
through `await import` inside `budgetReserve` because `measure/context.mjs` already imports
`readLimitFindings` from `projection/project.mjs`; a static import from `rules.mjs` would close a
three-module loop that has to survive being loaded in any order.

Determinism is structural and partly argued. `packToBudget` takes its cost function as an
argument and reads no clock, no network and no PATH, so the cut set is a function of the rules,
the classes, the ids and the declared number; the test that renders one repository twice catches
the failure a test can catch, which is state leaking between calls. Two machines is the claim
R08 actually makes and no test in this repository can execute it — the argument is the one ADR-073
ruling 7 already makes.

What has not landed, and is not this slice's to land: R02's evaluation, which is still what would
justify `kernel` as a default rather than a repository's own choice; and the cross-machine half
of the accept criterion, which is argued from the code's inputs rather than demonstrated.

## Rejected

- **Cutting in `full` mode.** The mode is a promise about what a reader gets, and the number in
  ADR-072's finding says nothing was cut; making that sentence untrue to save bytes is the tool
  misreporting itself.
- **Cutting `hard` to reach the line.** It would remove the one class whose claim is that its
  absence is a defect, and report the result as compliance.
- **A second `## Cut` section beside `## Deferred rules`.** Two headings for one reader-facing
  fact, and the second one spends bytes to be distinguished from the first.
- **Subtracting each rule's own length instead of re-rendering.** The provenance header and the
  deferred line both change when a rule leaves, so the arithmetic would either overshoot or stop
  short — and it would be a second definition of the region's size next to the meter's.
- **A binary search or two-pass packer.** The cost function is called once per candidate and the
  candidate list is the length of the kernel; a cleverer search would add a failure mode to a
  loop whose whole value is that it is the same computation every time.
