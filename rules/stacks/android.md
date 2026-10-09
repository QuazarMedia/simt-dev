---
simt-id: android
simt-title: Android
# Selected on the one thing that makes a repository an Android application: a
# module with an `AndroidManifest.xml`. `gradle` and `kotlin` are shared with every
# JVM backend, which is how a Spring or Ktor service used to receive this profile
# (S28, ADR-047).
simt-applies: [has-android-manifest]
---

# Stack profile: Android

Applies to: `has-android-manifest` — some module has a
`src/main/AndroidManifest.xml`. A JVM backend with no Android module does not get
this profile; see `jvm`.

## Build

- `./gradlew` only. Never a system `gradle`. Never `--configuration-cache` where a
  repo documents that it breaks.
- `./gradlew spotlessApply` is the formatting entrypoint in repos that use Spotless.
- The manifest is not hand-edited for a build-level change: `applicationId`, `versionCode`
  and `versionName` are declared in the module's build file and land in the merged
  manifest. A value in two places is a value that will disagree.

## Modules and layers

- `:core:domain` depends on no other internal module. Enforce it; do not add an
  import that breaks the direction.
- Layer suffixes: `*Repository`, `*ViewModel`, `*UiState`, `*Screen`, `*Service`.
- Feature modules never import `androidx.compose.ui.window.Dialog`, M3 `AlertDialog`
  or M3 `ModalBottomSheet`. The raw `Dialog` window belongs to allowlisted `core:ui`
  surfaces, and `checkOverlayModalPolicy` fails `./gradlew check` when a feature
  bypasses it.

## Accessibility

- Every user-facing string is a resource, with a `cd_` content description where an
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
- Assert behaviour, not implementation. Never weaken an assertion, an accessibility
  check or a fixture to match current behaviour.