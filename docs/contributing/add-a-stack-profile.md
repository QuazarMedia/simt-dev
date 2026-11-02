# Add a stack profile

A profile is rule text plus the facts that select it. It is data, not code: the resolver
scores profiles against facts, and no branch in `src/projection/project.mjs` names a stack
(ADR-013).

1. **Write `rules/stacks/<id>.md`.** Frontmatter carries `simt-id`, `simt-title`,
   `simt-applies` (the manifests, build files or CI files that select it) and
   `simt-priority` (`hard`, `command`, `convention`, `style`). The body is the rules, in the
   same shape as `rules/core.md`.
2. **Check the selector.** `simt rules list` marks what applies to this repository and why;
   `simt doctor` prints `stack`, `facts` and `factEvidence` for the repository in front of
   you. If a profile is selected for the wrong repository, the fact is wrong, not the
   profile.
3. **Add a fact only if detection cannot see it.** A `has-*` fact belongs in the detection
   record for that ecosystem (`ecosystems/<id>.json`), not in the projection.
4. **Test it.** `test/rules.test.mjs` holds the projected text; a profile that changes what a
   repository of that stack receives needs a fixture that asserts the selection, not just
   the prose.

A repository-specific profile goes in `.simt/profiles/<id>.md` in that repository and never
in this tree: a rule that only one repository needs is that repository's rule.
