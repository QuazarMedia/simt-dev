# ADR-069 — The conformance lint checks the published specification

Status: **accepted** · 2026-10-13 · filed as S44
**Affects:** `graph lint`, `skills install`, `src/graph/spec.mjs`, `src/graph/speccheck.mjs`,
`src/commands/graph.mjs`, `src/commands/skillsinstall.mjs`, `test/graphspec.test.mjs`

## Context

Review 0002 found that the Agent Skills specification sets out limits this package does not
check, and that `graph lint` — the command whose whole job is to hold skills to their
declarations — checks bytes and structure instead. Forty extra characters of description
are not a formatting problem: a client that validates a skill at load time will refuse it,
and the discoverer of that is whoever runs the client, not whoever wrote the file.

So the specification was fetched and read rather than recalled. Two things fell out of
reading it. The first is that the review's list was incomplete: it named the name, the
description and the compatibility limits, and missed four rules — a name may not start or
end with a hyphen, may not contain consecutive hyphens, and must equal the directory it
lives in, and the main file is recommended to stay under five hundred lines. The second is
that the specification is explicit about which of its rules are musts and which are
recommendations, which is a distinction a lint has to keep.

It also turns out most real descriptions use a folded block scalar, `description: >-` with
indented lines under it. A reader that treated the arrow as the value measured a
two-hundred-character description as two characters, and the first run of this lint produced
that wrong answer on five real skills before the reader was rewritten.

## Rulings

1. **The lint checks the specification it names, and the flag refuses any other name.**
   `--spec agentskills` is the only value that works, and a different one is a usage error
   rather than an unnamed default. A lint against an unnamed set of rules cannot be argued
   with, and the argument is the whole point of publishing the rules.

2. **A must is an error and a recommendation is a warning.** Name, description and
   compatibility limits, a name that disagrees with its directory, and a file not named
   SKILL.md fail the exit code. Body length and line count warn, because the specification
   words them as recommendations for progressive disclosure, and a lint that fails on a
   recommendation teaches a reader to skip the lint — which costs it every rule it does
   enforce.

3. **The name rules live in one place, and `skills install` asks them too.** The
   specification requires a name to equal its directory, and an install creates the
   directory from the name. So an install is not the place to allow a name the lint would
   reject: it is the last moment anybody can notice before a skill is deployed that no
   client can address by the name inside it. The command refuses with the rule broken.

4. **The frontmatter reader reads block scalars.** A folded or literal block is the ordinary
   spelling of a long description, and a reader that misses one reports a conforming skill
   as broken. This is the one rule in this file that is about the reader rather than the
   skill, and it is here because the first version of this lint was confidently wrong about
   five files.

5. **The conformance pass is additive to the registry pass, not gated by it.** The registry
   answers "does the bookkeeping match the files"; the specification answers "would a
   client accept these files". A reader with no registry can still lint a skill directory,
   so the two passes run side by side, and a path the first cannot read is a warning from
   the second and never a second error for the same thing — one defect, one exit path.

6. **Progressively disclosed fields that are not musts are reported as unknowns, not
   rejected.** An experimental field and a vendor's extra key appear as warnings naming the
   field. The specification says clients may add metadata, and a lint that failed on it
   would fail on a skill built exactly the way the specification invites.

## Consequences

Thirty warnings and no errors across the skills this workspace declares, which is the
outcome the review predicted. The warnings are real: seven bodies over the recommended
size, one at six times it, and a set of vendor-specific frontmatter keys the specification
does not define. None of those is a defect in the skills — they are the cost a reader pays
per activation, which is what the recommendation exists to make visible.

The naming rules now hold at install time as well as at lint time, so a skill can no longer
be written to a directory its own name contradicts.

## Rejected

- **Recalling the limits instead of reading them.** The review's summary was missing four
  of them, and the ones it missed are the ones that break an install.
- **A byte-length check alone.** The specification counts characters and tokens, and the
  body limit is a token recommendation with a line count beside it; a byte check answers a
  different question.
- **Failing the exit code on the body recommendations.** They are recommendations, and a
  gate that fails on advice is a gate that gets skipped.
- **A dependency on the upstream reference validator.** It would be a second copy of the
  rules, maintained elsewhere, and this package ships no runtime dependencies.
- **Rejecting an unknown frontmatter field.** The specification invites extra metadata, and
  a lint that failed on it would refuse skills built to specification.
- **Two copies of the name rules, one for the lint and one for the install.** The one
  nobody linted would be the one that let an unaddressable skill through.
