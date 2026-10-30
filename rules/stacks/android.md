---
simt-id: android
simt-title: Android
# Selected on the one thing that makes a repository an Android application: a
# module with an `AndroidManifest.xml`. `gradle` and `kotlin` are shared with every
# JVM backend, which is how a Spring or Ktor service used to receive this profile
# (S28, ADR-047).
simt-applies: [has-android-manifest]
simt-priority: convention
simt-scope: ["AndroidManifest.xml", "**/build.gradle", "**/build.gradle.kts", "**/*.kt"]
---

# Stack profile: Android

Applies to: Android modules — some module has a `src/main/AndroidManifest.xml`.
A JVM backend with no Android module does not get this profile; see `simt rules
show jvm`.

## Build

- `./gradlew` only. Never a system `gradle`. Never `--configuration-cache` where a
  repo documents that it breaks.
- `./gradlew spotlessApply` is the formatting entrypoint in repos that use Spotless.
- The manifest is not hand-edited for a build-level change: `applicationId`, `versionCode`
  and `versionName` are declared in the module's build file and land in the merged
  manifest. A value in two places is a value that will disagree.

## Modules and layers

- The core domain module depends on no other internal module. Enforce it; do not add an
  import that breaks the direction.
- Layer suffixes: `*Repository`, `*ViewModel`, `*UiState`, `*Screen`, `*Service`.
- Feature modules never present a raw `Dialog` window (`androidx.compose.ui.window.Dialog`,
  M3 `AlertDialog`, M3 `ModalBottomSheet`) that bypasses the shared modal policy.
  Modals go through the design system's dialog surfaces, and the repo's check fails
  the build on a bypass.

## Accessibility

- Every user-facing string is a resource, with a content description where an
  icon or image carries meaning. Decorative images declare `contentDescription = null`
  explicitly.
- Touch targets meet the platform minimum, and the minimum is asserted rather than
  eyeballed.
- Respect the system font scale and the display size the user has chosen; a fixed
  `sp` value or a hard-coded cell height breaks both.

## Wear OS

- `applicationId` in the wear module must equal the phone app's. Divergence makes the
  Data Layer fail silently — no error, no delivery.
- Wear and phone target SDKs differ by design for Play Console reasons. Do not "align"
  them.

## Data

- Room: bump the version, add the migration, extend the migration test. Never edit an
  applied migration.

## Testing

- Unit tests for view models, repositories and mappers; instrumentation tests for UI.
- `Dispatchers.setMain` in a `@BeforeTest`, restored in `@AfterTest`.
- Assert behaviour, not implementation — including accessibility checks and fixtures. Never weaken one to match current behaviour.