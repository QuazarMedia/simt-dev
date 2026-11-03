---
simt-affects: ["src/adapters/conformance.mjs", "test/work-adapters.test.mjs"]
simt-supersedes: []
---

# ADR-185 — an adapter descriptor is data, and being installed is not being enabled

Status: accepted · 2026-11-03

## Context

An adapter is how a new ecosystem arrives without the core learning its SDK, and every way that
goes wrong is a ruling here:

- an adapter declared an operation it could not perform, or performed one it never declared;
- an executor shipped with no declared side effects, permissions or retry semantics;
- a descriptor carried code and ran it at load, because it arrived as a file;
- a version or digest drifted, so a conformance run tested something other than what shipped;
- a repository's default operation broke because an optional adapter was missing.

## Rulings

1. **Four narrow interfaces and two capabilities.** `observer`, `validator`, `executor`,
   `recipe-mapper`; `observe-only` or `execute`. The contract is the interfaces and bounds, not the
   ecosystem, so a document adapter and a remote adapter pass the same suite.

2. **An executor declares what it does and what it needs.** Side effects, permissions and retry
   semantics are required; an adapter with no executor interface cannot claim the execute
   capability.

3. **Every descriptor is bounded and attributed.** Input and output bounds, a provenance source, a
   version and a content digest — a conformance run that cannot name what it tested is not one.

4. **A descriptor is JSON and nothing else.** `code`, `script`, `hooks`, `eval` and `imports` are
   refused at parse time: installing a file must never be running one.

5. **Absence is not breakage.** An adapter that is not installed leaves the repository on its
   default operation with the reason stated; disabling `work` removes new behaviour and keeps
   historical receipts.

6. **An adapter is used at its pin.** A version or digest that differs from the declared pin is a
   refusal, not a warning.

## Consequences

- The conformance corpus is a pure function over descriptors, so a registry can be checked in CI
  and in review without installing any adapter.
- Transport dependencies stay with the adapter; this module never loads one, and the core never
  imports an SDK to validate a descriptor.
