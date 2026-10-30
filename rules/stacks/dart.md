---
simt-id: dart
simt-title: Dart
simt-applies: [has-pubspec]
simt-priority: convention
simt-scope: ["pubspec.yaml", "**/*.dart"]
---

# Stack profile: Dart

Applies to: a committed `pubspec.yaml`. A Flutter project is a Dart project
with the `flutter` SDK dependency; the Flutter-specific rules live with the tools
that build it, not here.

## Build and gates

- `dart analyze`, `dart test` are the entrypoints; `dart format --output=none
  --set-exit-if-changed .` is the formatting gate. A Flutter project runs the same
  commands through `flutter`, and the two must not be mixed in one change.
- Dependencies are declared in `pubspec.yaml`; `pub get` resolves them into
  `pubspec.lock`, which is committed for an application. A package that imports a
  library the manifest does not list resolves only by accident.

## Style

- `package:lints` (or the repo's stricter set) is the lint source; a rule the repo
  disabled is a decision, and re-enabling it is a change, not a fix.
- No `dynamic` where a real type exists. A `dynamic` that is guessed rather than
  checked is a hole the analyzer was told to stop looking through.
- `late` and `?` are decisions: a field that is `late` because the author did not
  know when it is set is a defect, not a convenience.
- Prefer a small `sealed` class hierarchy over booleans; a pair of `bool` fields is
  four states, one of which is always wrong.

## Testing

- `dart test` is the gate; a library with no tests is allowed to have none, but a
  change that touches one must not break its neighbours.
- Assert on values through the public API; a test that reaches into a private field
  is coupled to an implementation it should not own.
