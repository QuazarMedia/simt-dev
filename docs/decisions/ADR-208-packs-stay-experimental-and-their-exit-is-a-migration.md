---
simt-affects: ["src/packs/manage.mjs", "src/commands/pack.mjs", "src/commands/spec.mjs", "src/commands/index.mjs", "src/projection/rules.mjs", "src/surface.mjs", "test/packs.test.mjs", "test/packcli.test.mjs", "docs/reference/surface.md"]
simt-supersedes: []
---
# ADR-208 — packs stay experimental, and their exit is a migration, not a removal

Status: accepted · 2026-11-21 · filed as review 0005 PR30

## Context

ADR-130 froze packs pending a real consumer: no repository in this estate vendors one,
the feature is exercised by its own tests, and the surface was marked `experimental` in
ADR-130 and again in ADR-207. PR30 asked the next question — retire the publishing and
scaffolding surface if the caller audit finds no production user, or retain it explicitly
with an owner and a support tier — and requires that either answer leave an adopted pinned
pack migratable without changing its effective rules or losing its provenance.

The audit in this slice found the same thing ADR-130 did: no production caller inside the
estate. It cannot establish that nobody outside it pinned a pack — vendoring is a copy into
the adopting repository, invisible from here. That asymmetry decides the slice: removing
`pack lint` or the vendored-pack projection would strand bytes a repository already
committed, while keeping `pack new`/`pack publish` frozen costs nothing while nobody runs
them.

## Ruling

1. **Retain, explicitly, with an owner and a tier.** The pack group stays `experimental`
   in `src/surface.mjs`, owned by the maintainers, consumer "rule-pack authors, once a
   repository vendors one". It remains frozen under ADR-130: no new pack capability until
   a repository outside this one vendors a pack. The call to remove it is a later decision,
   and the evidence for that decision is an audit that also covers outside usage.

2. **The read and projection paths are what a repository keeps.** A pinned pack under
   `.simt/packs/<name>/` still projects, still resolves by digest, and `pack lint` still
   judges it. Nothing in this slice changes what an adopted pack renders.

3. **Local profiles are the first-choice configuration path.** They always were the
   supported route (ADR-013); what was missing was a way to get from one to the other
   without retyping rules.

4. **`simt pack migrate <name>` is that way.** It reads the pack's declared identity and
   pin, verifies the bytes still digest to the pin, copies each rule file byte for byte into
   `.simt/profiles/<file>.md`, and removes the pack declaration from the manifest. Local
   profiles outrank packs in the origin order, so a repository that ran the migration and
   `simt sync --yes` renders the same rule text with a new source list.

5. **It refuses rather than guesses.** A missing manifest, an undeclared pack, a drifted
   pin, a rule with no `simt-id`, two rule files that would land on one profile name, or an
   existing profile with different bytes are all refusals with a remedy. Each of those
   would change effective rules or overwrite a repository's own rule, which is the one
   outcome a migration must not have.

6. **The pack directory stays.** It is the provenance record — source, version, pinned
   digest, and the bytes the migration copied. Deleting vendored bytes is the repository's
   decision; the command reports that the directory was left and why.

7. **No command is removed in this slice.** `pack new` and `pack publish` stay, marked
   experimental, because the retirement case rests on evidence about outside usage that
   this slice does not have. A later slice may remove them; it should cite this record and
   the migration as the route that made removal safe.

## Consequences

- An adopting repository with a pinned pack has a supported exit that is exercised by a
  test comparing the effective region body before and after migration.
- The surface page now says the pack group is frozen, names the migration, and keeps the
  three author-side commands in the experimental tier.
- `parseRuleMeta` is exported from the projection loader so the migration reads `simt-id`
  with the same parser the loader uses rather than a second regex.
- The provenance directory is dead weight in the tree until the repository chooses to
  delete it; the migration says so, and nothing reads it once the declaration is gone.
- Removing the author-side commands later is a spec change plus a deprecation entry in
  `src/surface.mjs`; the migration is already in place.

## Alternatives

- **Remove `pack new` and `pack publish` now.** The audit found no caller, but it cannot
  see outside the estate, and the removal would not make a pinned pack any safer to carry.
  The freeze already prevents growth; removal buys a smaller `--help` page at the cost of
  a decision made on absent evidence.
- **Remove the whole group and require migration in the same release.** That strands a
  repository whose pack lives in a branch or tag, and makes the migration the only way to
  read bytes the tool itself told them to vendor.
- **Migrate by rendering the region instead of copying files.** Rendering loses the
  per-rule frontmatter (id, priority, applies) that local profiles are selected by, and
  produces a profile the projection cannot re-select.
- **Overwrite an existing profile on a name collision.** Two rules with one id is a
  review blocker, not a merge the tool can perform; refusing names the conflict.
