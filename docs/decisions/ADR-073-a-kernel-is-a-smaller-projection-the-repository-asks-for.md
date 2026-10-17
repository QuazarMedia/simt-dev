# ADR-073 — A kernel is a smaller projection the repository asks for, not one it is given

Status: **accepted** · 2026-10-14 · filed as S38 (R07) · ruling 6 narrowed by ADR-084
**Affects:** `src/projection/manifest.mjs`, `src/projection/rules.mjs`, `src/measure/context.mjs`,
`rules/core.md`, `rules/stacks/*.md`, `test/kernel.test.mjs`

## Context

S38 asked for a number — generated always-on bytes per turn — and this repository built the
meter (ADR-064) and the budget line to measure it against (ADR-072). What the meter then
made unavoidable is that the budget cannot be met by measuring more carefully. A python
repository projects 11,305 always-on bytes: the shared core, the python profile, and the
process rules. A kernel keeps the first of those and defers the other two, and the same
repository projects 9,551. Sixteen percent, for a declaration.

Plan 0003 R07 describes this as packing kernel lines by priority class, and R08's accept
criterion — the budget is never exceeded — is only reachable once something is packed. So
this is the piece R08 waits on.

What R07 does not say is which lines are the kernel, and that question is not rhetorical.
Classifying a rule is a claim about what a reader loses by not having it: a rule that says
never force-push is not equivalent to a rule that says prefer descriptive commit subjects,
and only one of those can be the one thing loaded when nothing matches. The classification
lives in the rule's own frontmatter, because the judgement belongs beside the text it
describes and not in a table that would have to be kept in step with 20 files.

## Rulings

1. **The mode is a repository declaration, beside the budget, not inside `projection`.**
   `mode` is written only when the repository declared it, for exactly the reason ADR-072
   gave for `budget`: `projection` is a generated key, `upgrade` replaces it wholesale, and
   a mode that reset itself on upgrade would reset the reader's context size without anyone
   asking.

2. **Absent means `full`, and `full` stays the default.** Nobody has measured that a kernel
   is not worse at getting a task done; plan 0003 R02 is that measurement and it has not
   been run. Shipping a default that quietly withholds rules from every repository on the
   strength of an unrun study is the same defect as a rule nobody can find.

3. **A rule declares its class in its own frontmatter, and the vocabulary is closed.**
   `simt-priority: hard | command | convention | style`, ordered as a kernel packs them.
   An unrecognised value is a defect reported by `graph lint` and `check`, in the order the
   other frontmatter checks run, rather than a class nobody happened to use.

4. **A rule that states no class is deferred in kernel mode.** An unstated class is not a
   hard constraint, and the asymmetry decides it: wrongly keeping a line defeats the mode
   the repository asked for, while wrongly dropping one costs a convention or a style, which
   `rules show <id>` returns on demand.

5. **The kernel is the two classes a reader loses least from.** `hard` and `command` are
   what a repository must not do wrong; `convention` and `style` are guidance that is
   valuable in context and worthless out of it. The shipped content is classified to match:
   `core.md` is `hard`, and the 19 stack profiles are `convention`.

6. **Everything deferred is named in the region, with the command that shows it.** The
   region gains a `## Deferred rules` section listing each omitted rule, its class and
   `rules show <id>`, sorted by class then rule id. A rule left out and named nowhere is a
   rule the reader cannot find, which is indistinguishable from a rule that was never
   written — the same defect S50's scoped pointers exist to prevent, in the other
   direction.

7. **The order is deterministic and is the only thing that determines it.** Class, then
   rule id. Two machines that project the same repository produce byte-identical regions,
   which is R08's second half and this repository's standing rule.

8. **A kernel over the budget is a different finding from a full projection over it.** The
   budget finding takes the mode and says so: in `full`, nothing was cut and the advice is
   to raise the number or switch to kernel; in `kernel`, the projection is already as small
   as this mode makes it, so the advice is to raise the number or move rules out of the
   hard and command classes. Conflating the two would leave a reader believing a trimmed
   projection was waiting to be trimmed.

## Consequences

A repository that declares `mode: kernel` gets the shared core plus the hard and command
rules, and a list of everything else with the command to fetch it. The meter's own reading
drops by about a sixth on a python repository, and the budget finding now distinguishes the
two reasons a projection can be over its line.

What is not here: the measurement that would justify making `kernel` the default, and the
workspace-level dedupe R11 proposes. Both are named in the tracker's remaining note for this
row. This ruling is what makes them measurable rather than what concludes them.

## Rejected

- **Making `kernel` the default.** It withholds guidance from every repository on the
  strength of a study that has not been run.
- **A central table of classes rather than frontmatter.** A table beside 20 rule files is a
  thing to keep in step with them, and the judgement it records belongs next to the text.
- **Silently deferring, or deferring with a count.** A reader told "12 rules deferred" has
  to guess which ones apply to the file in front of them; the names are the part that
  answers.