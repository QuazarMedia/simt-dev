---
simt-id: jvm-android
simt-title: JVM / Android / Compose
simt-applies: [gradle, kotlin, wear-os]
---

# Stack profile: JVM / Android / Compose

Applies to: `gradle`, `kotlin`, `wear-os`.

## Build

- `./gradlew` only. Never a system `gradle`. Never `--configuration-cache` where a repo
  documents that it breaks.
- `./gradlew spotlessApply` is the formatting entrypoint in repos that use Spotless.

## Modules and layers

- `:core:domain` depends on no other internal module. Enforce it; do not add an import that
  breaks the direction.
- Layer suffixes: `*Repository`, `*ViewModel`, `*UiState`, `*Screen`, `*Service`.
- Feature modules never import `androidx.compose.ui.window.Dialog`, M3 `AlertDialog` or M3
  `ModalBottomSheet`. The raw `Dialog` window belongs to allowlisted `core:ui` surfaces, and
  `checkOverlayModalPolicy` fails `./gradlew check` when a feature bypasses it.

## Kotlin

- Four-space indent, LF, 300-char line limit.
- No `!!`. Prefer a sealed `RepositoryResult<T>` over exceptions for expected failures.
- Expose `MutableStateFlow` as `StateFlow` via `.asStateFlow()`; update UI state with
  `_uiState.update { }`.

## Accessibility

- Every user-facing string is a resource with a `cd_` content description where an icon or
  image carries meaning. Decorative images declare `contentDescription = null` explicitly.
- Touch targets meet the platform minimum.

## Wear OS

- `applicationId` in the wear module must equal the phone app's. Divergence makes the Data
  Layer fail silently — no error, no delivery.
- Wear and phone target SDKs differ by design for Play Console reasons. Do not "align" them.

## Testing

- Unit tests for view models, repositories and mappers; instrumentation tests for UI.
- `Dispatchers.setMain` in a `@BeforeTest`, restored in `@AfterTest`.
- Room: bump the version, add the migration, extend the migration test. Never edit an applied
  migration.