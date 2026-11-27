---
simt-id: kotlin-multiplatform
simt-title: Kotlin Multiplatform
simt-applies: [has-kotlin-multiplatform]
simt-priority: convention
simt-scope: ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts", "gradle.properties", "gradle/libs.versions.toml", "**/*.kt", "**/*.kts"]
---

# Stack profile: Kotlin Multiplatform

Applies to: a Gradle build that applies the Kotlin Multiplatform plugin.

## Build and target matrix

- Use the committed Gradle wrapper and its declared tasks. `./gradlew build` is
  the aggregate build; a repository-declared task remains the answer for a
  specific module or target.
- Enumerate the configured targets from the build files. Do not assume the root
  project has a `jvm` target, or that `./gradlew test` exists, merely because the
  language is Kotlin.
- Run `./gradlew :<module>:tasks` and use a focused test task only when the module
  declares it for the target being changed. Record the target with the test
  result; a JVM pass does not cover Native, Android, JavaScript or Wasm.
- Keep the target matrix in the repository's CI and documentation. Adding a
  target means adding its source sets, dependencies, tests and supported host
  requirements, not only a line in the plugin configuration.
- Pin Kotlin, Gradle and plugin versions through the repository's version catalog
  or dependency declarations. Do not mix versions from an unrelated sample
  project.

## Common code and platform boundaries

- Declare an `expect` in a common source set and its matching `actual` in each
  required platform source set. Keep package, name, type parameters and
  signatures aligned; an actual with a subtly different contract is a new API.
- Keep interfaces and immutable models in common code. Put platform APIs behind
  those interfaces and inject the implementation rather than branching on a
  target name throughout business logic.
- No `java.*`, `javax.*`, JVM reflection or desktop-only API in `commonMain`.
  Such code belongs in `jvmMain` or behind an `expect`/`actual` boundary.
- Do not replace an unavailable actual with `TODO()` or a silent default. A
  target that cannot implement the contract must be removed from the supported
  matrix or given an explicit, tested implementation.

## Source sets and dependencies

- Put shared code in `commonMain` and shared tests in `commonTest`. Use
  intermediate source sets only when several targets genuinely share an API;
  every layer needs a reason to exist.
- Declare a dependency at the narrowest source set that can see it. A platform
  dependency in common code either fails compilation or forces an unsafe
  abstraction, and neither is a working design.
- Keep source-set names and directory layout consistent with the Gradle
  configuration. Do not add a folder that no compilation unit reads.
- Test common behaviour once in `commonTest`. Platform tests cover the actual
  implementation, permissions, lifecycle and integration that common tests
  cannot prove.

## Resources

- Use the repository's declared resource API for each target. Compose
  Multiplatform resources belong in the configured common resource directory;
  Android resources and JVM classpath resources are different mechanisms.
- Access resources through generated accessors or the platform abstraction. Do
  not hard-code absolute paths or assume the working directory contains an
  asset.
- Keep locale, plural and right-to-left cases in resource tests where the
  supported targets expose them. A fallback string is not evidence that every
  target loaded the intended resource.

## Validation

- Run the common tests and the tests for every affected target using the exact
  tasks the build declares. Do not narrow the matrix to make a failure disappear.
- Keep Native toolchain and simulator requirements explicit. If the host cannot
  run a target, report that target as unrun rather than substituting another one.
- Assert public behaviour across the expect/actual boundary. Platform tests also
  check resource loading and the failure path when the platform service is
  unavailable.
