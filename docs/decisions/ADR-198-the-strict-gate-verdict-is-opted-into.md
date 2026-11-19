---
simt-affects: ["src/commands/gate.mjs", "test/gate.test.mjs"]
simt-supersedes: []
---

# ADR-198 — the strict gate verdict is opted into, and the default keeps its answer

Status: **accepted** · 2026-11-19

## Context

Review 0005 (PR13) found that `simt gate` exited 0 in four situations a reader would read as
one: a change whose tests all passed, a change that reaches no test at all, a change whose
import graph did not resolve, and a run whose runner ignored the files it was given and
reported a pass for nothing.

The empty answer is explicit in the JSON (`verdict: "nothing-selected"`), but the exit code is
what a hook, a script and a CI step read, and it has said 0 since ADR-094. ADR-164 settles the
selection for document changes elsewhere; it does not speak for this command's exit status.
Changing the exit code in place would turn every existing green pipeline red on a commit that
changed only documentation, and a gate that fails when there is nothing to check is the failure
ADR-017 describes: the exit an author finds is `--no-verify`.

## Rulings

1. The default verdict stays compatible: an empty selection exits 0 and says
   `nothing-selected`. Nothing that reads the old answer changes behaviour.
2. `--strict` is the opt-in verdict. Under it an empty selection is `unproven-selection` and
   exits nonzero unless every changed path is documentation, which is the one case where an
   empty selection is the whole truth.
3. A rename is reported as one change with both names, and a deletion is named as deleted. A
   renamed module used to arrive as two unrelated paths, and a deleted one as a path that no
   longer exists; both selected nothing while exiting 0.
4. "The runner ran the file" is established from the runner's own output naming the file. It is
   not a parse of pass counts: a runner is free to report counts in a shape this tool does not
   know, and a count that could not be read must not become a failure of the code under test.
