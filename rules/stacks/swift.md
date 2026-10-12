---
simt-id: swift
simt-title: Swift
simt-applies: [has-swift-package]
---

# Stack profile: Swift

Applies to: `has-swift-package` — a Swift package.

## Build and gates

- `swift build`, `swift test` are the entrypoints; `swift format lint -r .` is the
  formatting gate. A platform build (Xcode) is a different question from a package
  build — do not conflate the two in one command.
- Pin the toolchain where the repo does (a `Package.swift` tools version or a
  pinned Xcode); a compiler on the developer's machine is not a floor anything
  enforces.
- Dependencies are declared in `Package.swift`; a package that imports a module the
  manifest does not list builds only by accident.

## Style

- Concurrency is checked, not assumed: `Sendable` conformance is a decision. A
  `@unchecked Sendable` that papers over a real race is a defect the compiler was
  told to stop reporting.
- `throws` for expected failures, not `fatalError`. A crash path in library code is
  an unhandled error; return a `Result` or throw.
- Prefer a small `enum` of states over optionals of optionals; a triple `??` is a
  state machine somebody refused to name.

## Testing

- `swift test` is the gate; a target with no tests is allowed to have none, but a
  change that touches one must not break its neighbours.
- Assert on values through the public API; a test that reaches into an internal
  field is coupled to an implementation it should not own.
