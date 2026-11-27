---
simt-id: flutter
simt-title: Flutter
simt-applies: [has-flutter]
simt-priority: convention
simt-scope: ["pubspec.yaml", "pubspec.lock", "analysis_options.yaml", "lib/**", "test/**", "integration_test/**", "android/**", "ios/**", "linux/**", "macos/**", "windows/**", "web/**"]
---

# Stack profile: Flutter

Applies to: a committed `pubspec.yaml` whose dependencies include the Flutter SDK.

## SDK and dependencies

- Use `flutter analyze` and `flutter test` for this repository. Do not substitute
  the Dart entrypoints for Flutter's analyzer or test runner.
- Use the Flutter SDK pinned by the repository. If it declares an FVM or another
  version-manager wrapper, invoke `flutter` through that wrapper; a binary that
  happens to be on `PATH` is not a pin.
- Keep `analysis_options.yaml` as the lint source. A disabled rule is a decision;
  changing it needs the analyzer and affected tests to pass.
- Run `flutter pub get` after changing dependencies. Commit `pubspec.lock` for an
  application; a publishable package normally does not commit it. Never resolve
  an import from a dependency the manifest does not declare.

## Widgets and state

- Prefer small widgets and `const` constructors. Give a key to a child whose
  identity matters in a rebuilt list; do not use a key to hide unstable state.
- Keep state at the smallest owner that can serve it. Pass immutable values down
  and callbacks up; do not mutate a parent's model from a child widget.
- Building a widget is side-effect free. Start network, database and controller
  work in lifecycle-aware code, not in `build`.
- After an `await`, check that a `BuildContext` is still mounted before using it.
  Do not turn that check into permission for unrelated navigation or UI work.
- Follow the repository's state-management convention. Do not introduce a second
  provider or global singleton merely because one file is inconvenient.

## Tests

- `flutter test {file}` is the focused widget or unit-test entrypoint. Use
  `pumpWidget` and pumps that settle the behaviour under test; an arbitrary sleep
  is not synchronisation.
- Assert rendered output, state transitions and callbacks through the public
  widget API. Do not reach into private state to make an assertion pass.
- Test semantics and text scaling for user-facing widgets. Maintain golden tests
  only where the repository already has a deterministic golden workflow.
- Put end-to-end tests under `integration_test` only when the project declares
  that runner and its required device or simulator. A widget test is not evidence
  that a platform integration passed.

## Platform folders

- `android/`, `ios/`, `linux/`, `macos/`, `windows/` and `web/` are independent
  platform surfaces. Their presence does not mean every one is a supported build
  target, and a missing folder is not an invitation to invent one.
- Change native permissions, entitlements and platform configuration in that
  platform's source files. Keep purpose strings truthful and secrets out of the
  application bundle.
- Review generated runner and plugin registration files after a Flutter upgrade.
  Regenerate them with the pinned tool rather than hand-copying output from a
  different SDK version.
- A platform channel is a contract: document its method names, payloads, error
  cases and behaviour when the implementation is unavailable.

## Accessibility and build targets

- Give meaningful widgets `Semantics` labels, roles, values and hints. Decorative
  images are hidden from assistive technology; informative images are described.
- Respect text scaling, bold text, contrast and reduced-motion settings. Do not
  encode meaning by colour alone or truncate essential content at the default
  font size.
- Run the repository's declared accessibility checks and touch-target tests.
  Never weaken one to match current rendering.
- Build only a target declared by the repository's scripts, CI workflow or
  contributor documentation, with its declared Flutter target and flags. A
  platform folder alone is not a build command; do not guess an APK, IPA, web
  bundle or desktop target.
