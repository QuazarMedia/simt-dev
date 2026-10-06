---
simt-id: connectiq
simt-title: Connect IQ (Monkey C)
simt-applies: [connectiq]
---

# Stack profile: Connect IQ (Monkey C)

Applies to: `connectiq`.

## The platform is not the language you know

This profile exists because the most expensive failures in this stack are silent. Read the
repo's own known-defects table before assuming any platform behaviour; the entries there are
empirically verified and will otherwise be rediscovered one bug at a time.

Known traps to assume until verified otherwise:

- `String.toNumber()` can truncate rather than fail.
- `==` on two `String`s compares identity, not value.
- `Number` is 32-bit. Values outside that range are wrong, not approximate.
- `logger.error()` does not fail a test. A passing suite can contain a logged error.
- `getGlanceView()` is unavailable on the Simulator.

## Memory

- Memory budgets are hard limits, not targets, and they are the repo's declared gate
  (`simt-dev.json`). Zero allocation in `onUpdate`; no allocation in a draw callback.
- A memory check that "currently exits 1 by design" is not a gate — it is noise that teaches
  everyone to ignore it. Declare the budget or drop the check.

## Language and style

- Four-space indent, LF, 300-char line limit.
- `initialize()`, `_camelCase` for private members, `UPPER_SNAKE_CASE` for constants.
- `typeCheckLevel: "gradual"` — do not raise it to chase a build; fix the types instead.
- One responsibility per class. A class that draws, computes and persists is three classes.
- 400 lines is a review trigger, 1000 a ceiling (ADR-005). Generated `.mc` is exempt when the
  generator is named.

## Data and protocol

- A model that crosses the wire is **generated, never hand-written**. Hand edits are overwritten
  by the next codegen run and the drift is discovered in production.
- Validate every field at construction. A target with `bearingDeg = 400` cannot be created.
- A positional parser makes field order part of the contract. Reordering a field is a protocol
  change, not a refactor.
- `schemaVersion` is checked before parsing, never after.

## Security

- Never commit the developer key, an app UUID hardcoded as a literal, or any credential.
  The developer key is unrecoverable if lost — treat its loss as unrecoverable and rotate.
- Data minimisation: a field not needed on the device is not sent to it.
- No payload logging. Log the shape of a failure — field name and reason — never the data.

## Build

- `monkeyc -f monkey.jungle` with the documented product ids. Verify with the identity and
  settings-defaults checks before every build; they catch the two mistakes that otherwise reach
  a device.
- Do not pass `--configuration-cache` to Gradle.