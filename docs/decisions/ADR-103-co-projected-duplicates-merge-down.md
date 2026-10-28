---
simt-affects: ["rules/stacks/jvm.md", "rules/stacks/android.md", "rules/stacks/react-web.md", "rules/stacks/react-native.md", "rules/stacks/cloudflare-workers.md", "rules/stacks/container.md", "rules/mdc/preview-postflight.mdc"]
simt-supersedes: []
---

# ADR-103 — duplicates stand alone, fingerprints generalize, references spell out

Status: **accepted** · 2026-10-28

## Context

Twenty-four rule files ship: one core, nineteen stack profiles, four process
rule files. An audit of all of them found three kinds of defect and one thing
that looks like a defect but is not:

1. **Verbatim duplicates inside one projection.** An Android repository selects
   both `jvm` (gradle) and `android` (manifest), so it received the gradlew
   invocation, the Spotless entrypoint, the `:core:domain` direction rule and
   the assert-behaviour testing paragraph twice, in two sections of one region.
2. **Estate fingerprints.** Literal module paths (`:core:domain`), a custom
   check name (`checkOverlayModalPolicy`), an allowlisted surface (`core:ui`),
   a string-resource prefix (`cd_`), product nouns (`block`, `reveal`),
   an Arabic-only mirroring rule, a locale-parity claim about the estate's
   tests, a privacy-probe list naming the estate's data categories, and a
   preview-postflight file whose defaults name the estate's env vars, Firebase
   identity and Google-only policy.
3. **Two dangling references.** `react-web` named "the full strictness set
   listed in the Workers profile", which a browser-only repository never
   receives; `react-native` said "see that profile", pointing at a profile a
   native-only repository never receives. Both fail the receiving-repo test:
   a reader who has only their own repository cannot act on them.
4. **Not a defect: duplicates across mutually exclusive profiles.**
   `react-web` and `react-native`, `go` and `rust`, `deno` and `node` repeat
   maxims, but no repository receives both sides. Merging them needs an
   include mechanism profiles do not have, and a pointer to a non-projected
   profile is defect 3 again. Each profile stands alone.

## Ruling

1. **Co-projected duplicates stay duplicated: the merge was attempted and
   refused by a render test.** `android` pointed at the `jvm` section for
   invocation, formatting and the shared suffixes — and a manifest-only
   fixture (an `AndroidManifest.xml` with no root Gradle file) selected
   `android` without `jvm`, leaving the pointers dangling. Gradle at the root
   is usual, not guaranteed, and a rule that is present only usually is
   silently absent exactly when its reader needs it. So `android` stays
   self-contained and the standing jvm/android overlaps are recorded rather
   than merged: merging them needs a profile-implication mechanism profiles
   do not have, and that mechanism needs its own record. No hard-priority
   lines move, so kernel bytes do not move either way.
2. **Fingerprints generalize in place; no profile is removed and no id is
   renamed.** `:core:domain` becomes the core domain module; the modal rule
   keeps the public M3 names and loses the estate check and surface; `cd_`
   becomes a content description; `block`/`reveal` become the generic nouns;
   mirroring covers RTL locales, not Arabic alone; the locale-parity sentence
   and the product data categories go; preview-postflight's env vars, Firebase
   identity and Google-only defaults become neutral wording with the slots
   repos already declare. `rules list`, the catalogue and selection behaviour
   are unchanged.
3. **The two dangling references are spelled out.** `react-web` inlines the
   strictness flags; `react-native` names browser rules instead of pointing at
   them.

## Consequences

- Regions change only where a fingerprint generalized or a dangling reference
  was spelled out; `android` is byte-comparable to before modulo the
  generalizations. `mdc.test.mjs`'s build-config test follows the renamed
  default; its intent (the union survives) is unchanged.
- A repository that opted into preview-postflight on the estate defaults sees
  neutral wording and declares its own provider values through the slots that
  already exist.
- Mutually exclusive duplicates stay duplicated on purpose. A future include
  mechanism needs its own record; this one refuses to invent it by pointer.
