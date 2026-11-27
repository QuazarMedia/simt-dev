# Add a stack profile

A profile is rule text plus the facts that select it. It is data, not code: the resolver
scores profiles against facts, and no branch in `src/projection/project.mjs` names a stack
(ADR-013).

1. **Write `rules/stacks/<id>.md`.** Frontmatter carries `simt-id`, `simt-title`,
   `simt-applies` (the tags or facts that select it), `simt-priority` (`hard`, `command`,
   `convention`, `style`) and a narrow `simt-scope`. The body is the rules, in the same shape
   as `rules/core.md`, written for the repository that receives it rather than for simt-dev.
2. **Select on what the repository runs on.** A source extension alone does not prove a
   framework or platform. Prefer an exact dependency key, build marker or other committed
   fact (ADR-047). Keep the human-readable `Applies to:` line free of internal `has-*`
   vocabulary.
3. **Understand fallback composition.** A specific non-fallback profile suppresses fallback
   profiles such as `node` and `typescript`. If the specific profile replaces that baseline,
   carry the baseline rules it still needs; do not assume the fallback will be projected
   beside it. A narrow profile must not select an unrelated framework.
4. **Check the selector.** `simt rules list` marks what applies to this repository and why;
   `simt doctor` prints `stack`, `facts` and `factEvidence` for the repository in front of
   you. If a profile is selected for the wrong repository, the fact is wrong, not the
   profile.
5. **Add a fact only if detection cannot see it.** A `has-*` fact belongs in the detection
   record for that ecosystem (`ecosystems/<id>.json`), not in the projection. Shipped and
   validated repo-local record facts are available to profile validation through the owning
   root's vocabulary (ADR-262).
6. **Test it.** `test/rules.test.mjs` holds projected text; `test/genericity.test.mjs` holds
   shipped fact-to-profile selection. A profile that changes what a repository receives
   needs a fixture that asserts selection and negative controls, not just prose coverage.

A repository-specific profile goes in `.simt/profiles/<id>.md` in that repository and never
in this tree: a rule that only one repository needs is that repository's rule.
