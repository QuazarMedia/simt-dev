---
simt-id: typescript
simt-title: TypeScript
# A fallback, not a specific profile. `select` drops every fallback once any specific
# profile matches, and `node` is itself a fallback. A specific profile here would
# suppress `node` on every TypeScript repository, which is the runner rules those
# repositories are selected for. Two fallbacks both apply when nothing more specific
# matched.
simt-applies: [typescript]
simt-priority: convention
simt-scope: ["tsconfig.json", "*.ts", "*.tsx"]
simt-fallback: true
---

# Stack profile: TypeScript

Applies to: `typescript`, together with the `node` profile when no more specific
profile matches.

## Types

- No `any`, no unsafe casts, no non-null boundary bypasses, no floating promises, no
  `console.*` in application code.
