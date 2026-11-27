---
simt-affects: ["src/ecosystem/schema.mjs", "src/ecosystem/records.mjs", "src/resolve/fingerprint.mjs", "src/projection/rules.mjs", "src/kernel/inferability.mjs", "src/graph/load.mjs"]
simt-supersedes: []
---

# ADR-262 — ecosystem probes and root-aware signal vocabulary

Status: accepted · 2026-11-27

## Context

Ecosystem records already own markers, gate commands, language metadata and
Dependabot entries, but detection can currently prove only a root filename or a
small set of hard-coded package facts. Frameworks distinguished by an exact
dependency key, Flutter by the shape of `pubspec.yaml`, Kotlin Multiplatform by
Gradle content, and F# or OpenTofu by nested extensions cannot be added without
another product branch in the detector.

Record-defined facts are also emitted at runtime but absent from the static
profile vocabulary, so a central profile cannot select on them and a local
profile is rejected as unselectable.

## Rulings

1. **Ecosystem detection is declarative.** A record may declare `probes` that
   prove `has-*` facts from repository-relative file existence, bounded text
   matching, exact JSON object paths, or root and depth-bounded globs. Text probes
   may strip line and block comments, including nested Kotlin block comments, before
   matching. A probe records the matching file as evidence, never the glob that matched it.
2. **Probe inputs are bounded, contained and validated.** Text is read from at
   most 256 KiB per file, parsed JSON is cached for the pass, and symlinks that
   resolve outside the owning root are neither read nor counted as glob evidence.
   Local records with unsafe paths, invalid regular expressions, ambiguous matchers,
   malformed probe lists or JSON paths, or malformed gate/card/Dependabot exclusions
   are quarantined whole by the record validator.
3. **The vocabulary is root-aware.** Shipped `STACK_TAGS`, `FACT_TAGS`, and
   `KNOWN_TAGS` remain compatibility sets and include shipped record facts.
   `knownTags(root)` adds facts from validated records in force for that root;
   profile validation, inferability markers and registry lint use the owning
   root's vocabulary when one is available.
4. **Conditions may exclude facts.** Data conditions and gate rows accept
   `unless`, evaluated after their positive condition. This keeps Flutter and
   Dart, or Bun and npm, from declaring duplicate commands without naming
   either product in engine code.
5. **No product branches are added.** New ecosystems arrive as records and
   profiles. The detector learns only the probe grammar; gate, card, language
   and Dependabot views continue to read the same record.
6. **Root automation keys on root evidence.** A broad ecosystem fact may select
   guidance and Dependabot coverage for nested modules or projects, but a gate or
   root-command card row keys on a separate root-scoped fact. Nested evidence
   alone must not declare a command that cannot run from the repository root.
