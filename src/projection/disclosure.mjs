// The names a reader needs before it can open anything that was kept out of the region.
//
// A scoped profile and an installed skill are the same situation: the body is not in the
// file the reader loads at session start, and a reader that is not told the name will
// never ask for it. This module reads only what the index line needs — a skill's name and
// its description — and never the body. The body is the cost the index exists to avoid.

import { readdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';

import { readFrontmatter } from '../graph/spec.mjs';

/**
 * Where an installed skill can live. These are the directories `skills install` writes
 * and the directories the loader table records, which are the same four. A fifth would
 * be a place this tool can write a skill and then fail to tell the reader it is there.
 */
export const SKILL_DIRS = ['.agents/skills', '.cursor/skills', '.claude/skills', '.opencode/skills'];

/**
 * The skills installed in a repository, one entry per file.
 *
 * A symlink fan-out is one skill: the file is counted by its real path, so the same
 * body linked from two of these directories produces one line. Two different files that
 * share a name both stay, because dropping one would hide a trigger.
 *
 * @param {string} root
 * @returns {Promise<{name: string, trigger: string, dir: string}[]>}
 */
export async function installedSkills(root) {
  const seen = new Set();
  const skills = [];
  for (const dir of SKILL_DIRS) {
    let entries;
    try {
      entries = await readdir(join(root, dir), { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue;
      throw error;
    }
    for (const entry of entries) {
      const file = await skillFile(root, dir, entry);
      if (file === null) continue;
      let key;
      try {
        key = await realpath(file);
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      if (seen.has(key)) continue;
      seen.add(key);
      let text;
      try {
        text = await readFile(key, 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      const { meta } = readFrontmatter(text);
      const fallback = entry.isDirectory() ? entry.name : entry.name.replace(/\.md$/, '');
      const name = typeof meta.name === 'string' && meta.name !== '' ? meta.name : fallback;
      const trigger = typeof meta.description === 'string' ? meta.description.replace(/\s+/g, ' ').trim() : '';
      skills.push({ name, trigger, dir });
    }
  }
  skills.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
  return skills;
}

/**
 * The file that holds one skill, or null when the entry is not a skill.
 *
 * A symlink is the fan-out case: the directory a reader opens is a link, and
 * `Dirent.isDirectory` is false for it, so treating "not a directory" as "not a
 * skill" would index the canonical copy and then miss a repository whose only
 * copy is the link.
 */
async function skillFile(root, dir, entry) {
  const base = join(root, dir, entry.name);
  if (entry.isDirectory() || entry.isSymbolicLink()) {
    const nested = join(base, 'SKILL.md');
    try {
      await realpath(nested);
      return nested;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith('.md')) return base;
  return null;
}
