// Repo-local skills as resolver nodes.
//
// The registry is what simt-dev ships; the skill directories a repo holds are what
// that repo owns. After plan 0005 S2 the registry is small and generic, so a skill
// that lives only in a repo was invisible to `skills find` and `skills brief`, and
// the NOT SELECTED block points a reader at `skills show` by name - a remedy that
// 404s for a name the registry does not declare.
//
// Presence in the repo's skill directory is the eligibility signal: a skill the repo
// installed is about the repo, and the stack it belongs to is the stack the repo has.
// The node's `stack` is therefore the repo's own signals, which makes the stack gate
// a self-overlap that always passes, and the stack score reads "more this repo's"
// rather than "compatible with a stranger".

import { stat } from 'node:fs/promises';

import { BODY_BYTE_BUDGET } from '../graph/compile.mjs';
import { installedSkills } from '../projection/disclosure.mjs';

/**
 * The repo's own skills, as nodes the resolver can rank.
 *
 * Names the registry declares are excluded: the registry entry is canonical and the
 * local file is its installed copy, so keeping both would rank one skill twice.
 *
 * @param {string} root the repository
 * @param {object} registry the loaded registry
 * @param {string[]} repoStack the repo's signals (stack ∪ facts)
 * @returns {Promise<object[]>} resolver-ready nodes, name-sorted
 */
export async function localSkillNodes(root, registry, repoStack) {
  const installed = await installedSkills(root);
  const known = new Set(registry.skills.map((s) => s.name));
  const nodes = [];
  for (const { name, trigger, file } of installed) {
    if (known.has(name)) continue;
    let size;
    try {
      size = (await stat(file)).size;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      continue; // gone between listing and measuring
    }
    nodes.push({
      name,
      summary: trigger,
      keywords: [],
      capabilities: [],
      stack: [...repoStack],
      paths: [],
      bytes: size,
      deferred: size > BODY_BYTE_BUDGET,
      localFile: file,
    });
  }
  nodes.sort((a, b) => a.name.localeCompare(b.name));
  return nodes;
}
