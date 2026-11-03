---
simt-affects: ["src/commands/agenthooks-explain.mjs", "src/agenthooks/facts.mjs", "src/commands/agenthook.mjs", "src/commands/spec.mjs", "src/commands/index.mjs", "src/commands/help.mjs", "src/argv.mjs", "CHANGELOG.md"]
simt-supersedes: []
---

# ADR-190 — an explanation reads a payload through the hook's own adapter and policy table

Status: accepted · 2026-11-03

## Context

`src/agenthooks/normalize.mjs` names a tool call in the policy table's terms — effect class,
resource selector, operation identity — so that a browser action, an API call and a shell wrapper
are judged by the same rows. It shipped with no command surface: the hook calls `decide` directly
and answers one bit, allow or deny, and nothing let a person ask what the payload had been read as.

That absence is the defect the six-dialect surface keeps producing. `simt agent-hooks status`
reports that a harness is wired; a tool call is then denied, or worse allowed, and the only
evidence available is a decision with no reading behind it. The first reaction in that situation is
to write a second interpreter for the payload — a script that parses the harness JSON its own way —
and a second interpreter is how the diagnosis comes to disagree with the hook that produced the
behaviour.

## Rulings

1. **The explanation goes through the same adapter and the same table.** `agent-hooks explain`
   calls `factsFrom`, `factsFor`, `normaliseFacts` and `mediate` — the functions the hook calls —
   and prints what they returned. It carries no payload parsing of its own, so it cannot drift
   from the decision it explains.

2. **It reports the reading, not a second verdict.** The output names the surface, effect class,
   resource set and operation digest, and the mediation the boundary may claim. A caller who wants
   a gate runs `agent-hook`; a caller who wants to understand a gate runs this.

3. **It is read-only and exits 0 whenever it could read a payload.** A payload that arrives
   unparseable is a usage error naming the remedy, because the command was asked to explain
   something and was given nothing to explain. Unlike the hook, an empty payload is not silence
   here: it is a question with no input.

4. **The write-path resolution is shared, not copied.** The rule that a relative write resolves
   against the directory the harness reported — not the repository root the facts resolve against
   — now lives in `src/agenthooks/facts.mjs` and both callers use it. Two copies of that rule
   would disagree about which file a payload named, which is exactly the disagreement this
   command exists to expose.

## Consequences

- A harness can be diagnosed from the payload it sends: run the command with the harness's own
  JSON and read the class the table assigned to it.
- The mediation claim is toggled by `--mediated` rather than assumed, so an observe-only boundary
  cannot be reported as a mediated one.
- The command is the first consumer of the context modules that a person invokes directly. It is
  listed under `help --all` with its group.
