# ADR-061 — The skill registry is workspace data, and the package ships none of it

Status: **accepted** · 2026-10-12 · filed as S61
**Affects:** `graph lint`, `skills list`, `skills show`, `skills resolve`, `skills brief`,
`src/graph/load.mjs`, `package.json` `files`, the estate-name guard in `test/shipped.test.mjs`

## Context

`graph/skills.graph.json` is published. It is in `files`, so it is in the npm tarball and in
the wheel, and `REGISTRY_PATH` finds it by resolving from `src/` — which in an installed
package is inside the package itself:

```js
export const REGISTRY_PATH = resolve(HERE, '..', '..', 'graph', 'skills.graph.json');
```

So the registry every one of those commands reads is not the reader's. It is *this* source
tree's catalogue of the skills that live in sibling repositories of this estate. An adopting
repository has none of them.

The estate-name guard found the symptom, and the symptom is the smaller half. Widened from
`.md` to every text extension the package ships, it reported **51 strings in that one file**
naming eight private repositories. The paths are the larger half and are not names at all:
every `sources[].path` is `.agents/skills/<id>` or `.cursor/skills/<id>`, and not one of
them resolves in a repository that is not this workspace. A reader who runs
`simt skills list` gets skills they do not have, and `simt skills resolve` finds the
declaration and then looks for a body that was never there. That is the corpus check this
repository exists to enforce, failing in a file this repository publishes, on a scale the
name grep was too narrow to see.

Two more facts made the shape of the answer unambiguous rather than a judgement call:

- **The sources are load-bearing, not decoration.** `graph lint` refuses a skill with none
  ("no sources; every skill must point at the file it came from"), and the same array does
  byte verification, variant resolution and duplicate detection. Nothing can simply be
  deleted from it.
- **There is already a workspace, and it is already resolved here.** `loadRegistry` calls
  `workspace(flags)` before it validates anything, precisely so the sources can be checked
  against a root. The registry is read from *inside the installed module* and verified
  against *the reader's workspace* — a workspace that has nothing to do with it.

So the file is not being shipped with a defect in it. It is a file that describes this
workspace and is being shipped as though the workspace were universal, which is the one
condition under which it makes no sense to any reader.

## Rulings

1. **The skill registry is workspace data.** It describes which skill bodies a particular
   workspace contains, where they are, how big they are, and which stack tags separate the
   variants. Every one of those is a fact about a workspace and none of them is a fact
   about the tool.
2. **The package ships no registry.** `graph` leaves `files`. The file stays in this
   checkout, because this repository still has to lint and resolve its own skills, and the
   rule that a tool must not carry its author's portfolio is about what it *publishes*.
3. **A command reads the workspace's registry, and says so when there is none.** The
   registry lives in a *member* of the workspace, not in the root: the root is the
   directory that contains the member repositories, and it holds no `graph/` of its own.
   When the reader names no path, resolution proceeds in tiers. First, the package root —
   which is how this checkout finds its own registry; in an installed package `graph` is not
   in the published set (ruling 2), so it never does. Next, a member of the resolved
   workspace, when exactly one holds it: a tool installed from node_modules or a formula is
   configured to find its workspace, and the member that holds the registry is usually the
   tool's own checkout. More than one holding it means the reader must pick; none means the
   command reports the workspace has no registry, naming that workspace. And where there is
   no workspace at all: an honest absence — the command says there is no registry to read,
   with a remedy that names the ways to point at one — which is the same shape
   `loadRegistry` already uses for a missing file, and it does not become a new failure
   mode. An explicitly named path always wins over all of this, and every tier is file
   existence plus the configured workspace: there is no scoring, so the answer can be
   explained to whoever asks.

   What must not happen is the current silence: `skills list` in an adopting repository
   answering with this estate's skills is a confident wrong answer, and a wrong answer from
   a command whose only job is to list what is here. Nor may the remedy be a dead end: a
   reader who follows the ways to point at a workspace must get the registry that workspace
   holds, which is what the member tier exists for.
4. **The guard keeps widening, and the suite stays red until the file is gone.** The
   coverage test asserts in both directions that what is guarded is what is published, so
   removing `graph` from `files` removes it from `SHIPPED_ROOTS` too — the two are one
   number. Pseudonymising the names was rejected because it would have left the paths, the
   byte counts and the variant stacks describing this workspace while hiding only the part
   a grep can see.

## Consequences

- `simt skills list`, `show`, `resolve`, `brief` and `graph lint` in an adopting repository
  report no registry rather than a foreign one. This is a behaviour change for anyone who
  ran those commands and got this estate's skills; it was wrong, and the commands now say
  so instead.
- A copy of the tool installed from node_modules or a formula, pointed at a workspace that
  holds a registry in one of its members, reads that member's registry and verifies it
  against the workspace. This is how this estate keeps using its skills from an installed
  copy; without it the remedy the absence message prints would be a dead end.
- Byte verification still works here, because the file is still in this checkout. Nothing
  about this repository's own use of the tool changes.
- `test/shipped.test.mjs`'s `SHIPPED_ROOTS` loses `graph`, and the guard still covers
  `bin`, `src`, `rules` and `docs/decisions`. The estate-name count in that file drops to
  zero, which is the point.
- The 51 strings are no longer shipped and the suite stops being red on purpose.

## Rejected

- **Pseudonymise the eight names to `repo-NN`.** It hides the part a grep can see and keeps
  the part that matters: hundreds of paths that resolve nowhere for the reader, byte counts
  of bodies they do not have, and variant stacks drawn from stacks they did not write. It
  would also have required a second registry mapping the pseudonyms back, and that registry
  is estate data — so it cannot be published either.
- **Ship the registry with an empty `sources`.** `graph lint` refuses a skill with no
  sources, so this would have meant shipping a registry that fails its own lint, or
  shipping a second, weaker lint for adopters.
- **Keep it, because a reader can ignore it.** The corpus check is not about whether a
  reader is misled; it is about whether the shipped artefact is actionable by someone with
  only the receiving repository. This one is not, for every field it has.
