// `simt mcp install`, the plan: which files change, and what each will hold.
//
// The write itself is `applyPlan`'s job; this module states the changes and nothing
// else. The rules that keep it honest: a config that cannot be parsed is refused and
// named, and NO other harness is written - the plan comes back with problems and the
// command never reaches the apply; user-scope files are never touched, because every
// path here is a project-relative one the harness facet names; and the DeepSeek plugin
// row is reported with its vendor note, not written.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { change } from '../write/plan.mjs';
import { dialects, renderEntry } from './dialects.mjs';
import { parseToml, replaceOwnedTables } from './toml.mjs';

/**
 * The changes `mcp install` would make, plus one note per harness it does not write.
 * `problems` non-empty means the command refuses before anything is written.
 *
 * @returns {Promise<{changes: object[], notes: Array<{id: string, state: string, note: string|null}>, problems: string[]}>}
 */
export async function planMcpInstall(root, scope, registry) {
  const changes = [];
  const notes = [];
  const problems = [];
  // With a root, the table sees the repository's `.simt/harnesses/` records, not
  // only the shipped set: a custom harness onboards by data, and install must reach it.
  const table = dialects(root);
  for (const id of Object.keys(table)) {
    const d = table[id];
    if (d.path === null) {
      notes.push({ id, state: 'not-ours', note: d.note });
      continue;
    }
    if (!scope.ids.includes(id)) {
      notes.push({ id, state: 'skipped', note: 'not selected; declare it in "surfaces" or pass --harness' });
      continue;
    }
    const entries = Object.fromEntries(registry.servers.map((server) => [server.id, renderEntry(server, id)]));
    let text = null;
    try {
      text = await readFile(join(root, d.path), 'utf8');
    } catch {
      // No file is a create, not an error: install is how the entry gets there.
    }
    if (d.format === 'toml') {
      const { errors } = parseToml(text ?? '');
      const owned = (name) => name !== null && (name === d.container || name.startsWith(`${d.container}.`));
      const bad = errors.filter((error) => owned(error.table)).map((error) => `line ${error.line}: ${error.text}`);
      if (bad.length > 0) {
        problems.push(`${d.path} is outside the TOML subset this tool reads (${bad.join('; ')}); fix it, or move the tables out of ${d.container}`);
        continue;
      }
      changes.push(
        change({
          path: d.path,
          before: text,
          after: replaceOwnedTables(text ?? '', d.container, entries),
          owner: 'mcp install',
          reason: `writes the registry servers into the ${id} config`,
        }),
      );
    } else {
      let config = {};
      if (text !== null) {
        try {
          config = JSON.parse(text);
        } catch (e) {
          problems.push(`${d.path} is not valid JSON: ${e.message}`);
          continue;
        }
        if (config === null || typeof config !== 'object' || Array.isArray(config)) {
          problems.push(`${d.path} is not a JSON object`);
          continue;
        }
      }
      changes.push(
        change({
          path: d.path,
          before: text,
          after: `${JSON.stringify(mergedJson(config, d.container.split('.'), entries), null, 2)}\n`,
          owner: 'mcp install',
          reason: `writes the registry servers into the ${id} config`,
        }),
      );
    }
  }
  return { changes, notes, problems };
}

/**
 * Merge the registry's entries into a parsed JSON config, preserving every other key
 * and its order: ours is replaced in place, repo-owned keys stay where they are, new
 * servers are appended. A value on the container path that is not a table is replaced,
 * because an array of strings cannot hold a server.
 */
function mergedJson(config, parts, entries) {
  const [head, ...rest] = parts;
  const child = config[head];
  const isTable = child !== null && typeof child === 'object' && !Array.isArray(child);
  const base = isTable ? child : {};
  const next = rest.length === 0 ? mergeLevel(base, entries) : mergedJson(base, rest, entries);
  return spliceKey(config, head, next);
}

/** One container level: every key keeps its position, ours is replaced in place, new ids appended. */
function mergeLevel(node, entries) {
  const ordered = Object.keys(node);
  for (const id of Object.keys(entries)) if (!Object.hasOwn(node, id)) ordered.push(id);
  const out = {};
  for (const key of ordered) out[key] = Object.hasOwn(entries, key) ? entries[key] : node[key];
  return out;
}

/** Rebuild `parent` with `key` replaced or inserted, every other key in its original position. */
function spliceKey(parent, key, value) {
  const out = {};
  for (const k of Object.keys(parent)) out[k] = k === key ? value : parent[k];
  if (!(key in out)) out[key] = value;
  return out;
}
