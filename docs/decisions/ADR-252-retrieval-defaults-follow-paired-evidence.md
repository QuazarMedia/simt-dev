---
simt-affects: ["src/commands/map.mjs", "src/commands/gate.mjs", "src/brief/assemble.mjs", "src/index/impact.mjs", "src/commands/why.mjs"]
simt-supersedes: [{ adr: "ADR-091", ruling: 1, kind: "narrowed" }, { adr: "ADR-094", ruling: 1, kind: "narrowed" }]
---
# ADR-252 — Retrieval defaults follow paired evidence

Status: accepted · 2026-11-22 · D39

## Context

The paired retrieval benchmark at baseline `8c38faf` graded 120 tasks.
Full v2 reduced mined lexical Recall@10 by 3.1 percentage points. Composite
minimum subtask coverage reached 40 percent and facet completeness reached
61 percent at 2,048 bytes. The qualified structural replay recovered every
labelled dependent and co-change partner after repairing module-level
impact traversal. Governance was precise on the labelled cases.

## Rulings

1. **Keep experimental ranking and composite briefs opt-in.** Use
   `simt index --retrieval v2` to prepare the index, then pass
   `--retrieval v2` to `simt map`, `simt brief` or `simt knowledge rank`.
   Pass `--retrieval v1` to use legacy ranking or packet selection over the
   same index. Prompt delivery uses the legacy pack by default. Set
   `brief.retrieval` to `"v2"` in `simt.json` to try composite delivery,
   then remove that setting or set it to `"v1"` to roll back. ADR-232,
   ADR-234, ADR-235 and ADR-238 through ADR-241 define the experimental arms.

2. **Use file coverage as the test-selection default.** Test symbol hunk
   selection with `simt gate --changed --precise` or
   `simt tests --run --changed --precise`. Choose `--conservative` to
   restore the full file closure. ADR-245 requires a conservative fallback
   for incomplete bindings and strict requests. Symbol impact uses the
   file import frontier around module-level calls and references whose
   caller symbol is unavailable. ADR-242 through ADR-244 define impact and
   co-change evidence. Use `simt impact <file> --retrieval v1` for the
   baseline file query.

3. **Use current governance and declared structural policy.** The normal
   `simt why <path>` reports current governance and available witnesses
   under ADR-247 and ADR-248. Pass `--retrieval v1` for the legacy path
   answer. Architecture and structural limits remain repository opt-ins
   under ADR-249 and ADR-250. Remove `architecture` or individual
   `limits.graph` settings to disable those checks. ADR-251 defines
   `simt check --changed` and its scope.

4. **Roll back a query on the existing cache.** Choose a legacy mode or
   remove its opt-in without deleting or downgrading the index. ADR-115
   governs cache migration and newer-version sidecars. The shared live
   overlay stays active under ADR-237.

## Consequences

Use the conservative modes in CI unless the repository opts into precision
based on its own regression evidence. ADR-095 governs gate output
compaction. ADR-240 governs experimental brief packing.
