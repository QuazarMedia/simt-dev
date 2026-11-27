---
simt-id: compose-multiplatform
simt-title: Compose Multiplatform
simt-applies: [has-compose-multiplatform]
simt-priority: convention
simt-scope: ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts", "gradle/libs.versions.toml", "**/*.kt", "**/composeResources/**"]
---

# Stack profile: Compose Multiplatform

Applies to: a Gradle build that applies the Compose Multiplatform plugin.

## Build and common code

- Follow the `kotlin-multiplatform` profile (`simt rules show kotlin-multiplatform`)
  for source sets, expect/actual boundaries and the target matrix. Compose does
  not make platform code common.
- Use the committed Gradle wrapper. Keep the Compose Multiplatform and Compose
  compiler versions aligned through the repository's declared catalog or plugin
  declarations; do not copy versions from an unrelated project.
- Run only the Gradle tasks declared for the target under test. There is no
  universal JVM-shaped focused command for a Native, desktop, web or Android
  target, and a root `test` task must not be assumed.
- Keep UI in common source sets only while its dependencies and semantics are
  genuinely shared. Platform chrome, permissions and native services remain
  behind the multiplatform boundary.

## State and side effects

- Hoist state to the smallest stable owner. Composables receive immutable state
  and callbacks; they do not mutate a repository, controller or parent model
  while rendering.
- Use `remember` for computation or state tied to a composition and
  `rememberSaveable` only for values that can be restored through the declared
  saveable state registry. Do not serialise secrets or platform handles.
- Collect flows with lifecycle-aware APIs and the repository's convention.
  Starting a collector in a composable without cancellation ownership leaks work
  across recompositions and destinations.
- Keep side effects out of composition. Launch them from the declared event or
  effect API, and cancel work when its owner leaves the composition.
- Prefer `derivedStateOf` for a value derived from observed state. Do not use it
  to hide an expensive operation that should be moved out of composition.

## Accessibility and input

- Give interactive content `Semantics` with a role, label, state description and
  action where appropriate. Decorative content is excluded from the semantic
  tree; meaningful images have useful descriptions.
- Respect text scaling, contrast, bold text and reduced-motion settings. Do not
  encode a selected or error state by colour alone.
- Meet the platform's touch-target minimum and keep focus order logical. Desktop
  and web targets also need keyboard and pointer behaviour; a mobile tap test is
  not an interaction test for every target.
- Run the repository's semantics and accessibility checks on each supported UI
  target. Never loosen an assertion or regenerate a baseline to hide a defect.

## Resources and target coverage

- Put shared Compose resources in the configured `composeResources` directory
  and use generated resource accessors. Do not assume Android's resource system,
  a JVM classpath or a native bundle exposes the same paths.
- Test locale, plural, right-to-left and missing-resource behaviour where the
  target supports it. Keep platform-specific assets in their declared platform
  source sets.
- Use common UI tests for shared rendering and state. Target-specific tests cover
  lifecycle, input, resources and native integration that common tests cannot
  reach.
- Keep screenshot tests deterministic and limited to the targets the repository
  declares. Fonts, animations and platform chrome must be controlled before a
  golden comparison is treated as evidence.
- Report the target with every UI test result. Do not replace a failing platform
  with a JVM-only test and call the multiplatform surface verified.
