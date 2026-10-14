---
simt-id: jvm
simt-title: JVM backend
# The build tool and the language, which is what a JVM backend is identified by.
# This profile used to be `jvm-android` and applied on `gradle` alone, so a Spring
# or Ktor service received rules about Compose, Wear OS application ids and
# instrumentation tests — advice with nothing to apply it to (S28, ADR-047).
simt-applies: [gradle, has-maven-pom, kotlin, java]
simt-scope: ["build.gradle", "build.gradle.kts", "pom.xml", "settings.gradle", "settings.gradle.kts"]
---

# Stack profile: JVM backend

Applies to: `gradle`, `has-maven-pom`, `kotlin`, `java` — a JVM build. The Android
rules live in the `android` profile, which selects on `has-android-manifest`.

## Build

- `./gradlew` only, never a system `gradle`; `./mvnw` where a wrapper is committed,
  never a system `mvn`. Never `--configuration-cache` where a repo documents that it
  breaks.
- `./gradlew spotlessApply` is the formatting entrypoint in repos that use Spotless.
- Pin the JVM toolchain in the build file (`java.toolchain`, `sourceCompatibility`).
  A JDK on the developer's PATH is not a floor anything enforces.

## Modules and layers

- `:core:domain` depends on no other internal module. Enforce it; do not add an
  import that breaks the direction.
- Layer suffixes: `*Repository`, `*Service`, `*Mapper`, `*Controller`. A class named
  `*Repository` that talks to HTTP is not a repository.

## Kotlin

- Four-space indent, LF, 300-char line limit.
- No `!!`. Prefer a sealed `RepositoryResult<T>` over exceptions for expected failures.
- Expose `MutableStateFlow` as `StateFlow` via `.asStateFlow()`; update state with
  `_state.update { }`.
- Java and Kotlin interop: `Optional` in a Java signature, a nullability annotation in
  a Kotlin one, and never a platform type left untyped at the boundary.

## Testing

- Unit tests for services, repositories and mappers; an integration test only when the
  behaviour is genuinely cross-system.
- Assert behaviour, not implementation. Never weaken an assertion to match current
  behaviour.
- Test the narrowest layer that proves the behaviour.

## Data

- One new sequential immutable migration per change. Never edit an applied migration.
  Define coexistence order and forward repair; do not promise SQL rollback.
- Prepared, parameterised statements only. Never interpolate a value into SQL, and
  never assemble SQL by string concatenation from a caller-supplied identifier.