// Where a skill's body lives, and how a path the registry names becomes a file.
//
// Extracted from src/commands/skills.mjs when the distiller (plan 0003 R38) became
// the second real caller: two commands that resolve the same body differently would
// print two answers to one question, and ADR-002 refuses the third copy rather than
// the second use.
//
// Sources are declared as `repo/path`, so finding one needs the workspace that
// CONTAINS the repos. That used to be `resolve(here, '..', '..', '..')`, which is
// right in the checkout and wrong in `node_modules` - so every source resolved to a
// path that could not exist and `skills` failed with 38 ENOENT lines. Now it comes
// from configuration, and `null` is a legitimate answer meaning "this installation
// has no workspace" (ADR-014).
//
// A second location exists and is not a fallback: the repo being read is itself a
// location for a declared source, matched on bytes rather than on hope (ADR-015).
// The canonical source is still tried first, so a workspace body always wins.

import { join } from 'node:path';
import { existsSync } from 'node:fs';

import { locateSource, sourceHeldLocally } from './source.mjs';

export async function sourcePath(skill, workspaceRoot, root) {
  // A node synthesized from the repo's own skill directory already names its file.
  // Asking the workspace for it would hunt for a body the registry never declared.
  if (skill.localFile) return skill.localFile;

  const canonical = skill.sources?.find((s) => s.role === 'canonical') ?? skill.sources?.[0];

  if (canonical) {
    const found = await locateSource(canonical, { workspaceRoot, root });
    if (found.path) return found.path;
  }

  const held = await sourceHeldLocally(skill, root, { workspaceRoot });
  if (held && !held.ambiguous) return held.path;

  // A skill with no canonical source, or one whose bytes match nothing, has no
  // body. Say so rather than printing an empty section.
  return canonical && workspaceRoot ? join(workspaceRoot, canonical.repo, canonical.path) : null;
}

/**
 * The file a source path points at. A path may be a directory that carries its
 * body as SKILL.md, the Agent Skills layout; SKILL.md wins when both exist.
 */
export function bodyFile(full) {
  return existsSync(join(full, 'SKILL.md')) ? join(full, 'SKILL.md') : full;
}
