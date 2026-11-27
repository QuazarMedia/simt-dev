---
simt-id: cpp
simt-title: C/C++
simt-applies: [has-cmake, has-meson]
simt-priority: convention
simt-scope: ["**/CMakeLists.txt", "**/meson.build", "**/*.c", "**/*.h", "**/*.cc", "**/*.cpp", "**/*.cxx", "**/*.hpp", "**/*.hh", "**/*.hxx"]
---

# Stack profile: C/C++

Applies to: a committed CMake or Meson build definition.

## Build and gates

- Configure out of tree, conventionally in `build`. Follow the repository's declared
  configure command and build directory; do not turn a source directory into a build
  tree.
- For a conventional CMake build, use `cmake --build build` and narrow registered
  tests with `ctest --test-dir build -R {test}`. For a conventional Meson build, use
  `meson compile -C build` and `meson test -C build {test}`. A repository wrapper or
  declared target takes precedence over these templates.
- Treat warnings as errors where the build declares that policy. Do not invent
  compiler flags, install a toolchain, or seed a gate the repository has not declared.
- Keep generated build output out of commits, including `build/`, CMake caches and
  Meson private metadata. A clean checkout must configure from committed inputs.

## Ownership and safety

- Use RAII for every owned resource. Name ownership at API boundaries, prefer standard
  containers and smart pointers, and document a raw pointer as non-owning when it
  crosses the boundary.
- Never pair an owning raw pointer with an unrelated lifetime. Views may borrow, but
  they must not outlive the object that owns the storage.
- Check bounds and lengths before indexing, pointer arithmetic or copying. Prefer
  checked containers and spans; an unchecked size from input is a defect even when a
  sanitizer is enabled.
- Keep allocation, deallocation and error cleanup under one owner. Early returns must
  release resources through the same deterministic path as success.

## Testing

- Register tests with CTest or Meson so the focused template reaches a real test name.
  Assert observable behaviour, not allocator addresses or incidental object layout.
- Run AddressSanitizer and UndefinedBehaviorSanitizer in CI where the repository
  declares them. A local sanitizer run is useful evidence, not a replacement for the
  CI job.
- Keep tests deterministic and independent of timing, locale, filesystem order or a
  developer's installed compiler version.
