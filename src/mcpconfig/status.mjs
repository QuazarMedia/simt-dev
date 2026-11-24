// `simt mcp status`: what is CONFIGURED, per selected harness and per server in the
// registry. The comparison is entry-level: a file that holds other keys of its own is
// not drift, and the bytes an entry carries are what the harness runs until install
// rewrites them.
//
// Honesty boundary: a config file is a fact this tool can read, so status claims it.
// Whether the harness has ACCEPTED the server is a runtime fact this tool cannot read,
// so status never says "enabled" - the vendor's own verify command is named instead.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { CLI } from '../name.mjs';
import { canonical, dialects, renderEntry } from './dialects.mjs';
import { parseToml } from './toml.mjs';

/**
 * One row per (harness, server), plus one row for a harness whose servers are not a
 * project file and one for a selected-out harness. `problems` carries unreadable files
 * only: drift and absence are states the remedy handles, not failures of this command.
 *
 * @returns {Promise<{rows: Array<{id: string, server: string|null, path: string|null, state: string, note: string|null}>, problems: string[]}>}
 */
export async function mcpStatus(root, scope, registry) {
  const rows = [];
  const problems = [];
  // With a root, the table sees the repository's `.simt/harnesses/` records, not
  // only the shipped set: status reports what install would write, so it must see the same.
  const table = dialects(root);
  for (const id of Object.keys(table)) {
    const d = table[id];
    if (d.path === null) {
      rows.push({ id, server: null, path: null, state: 'other', note: d.note });
      continue;
    }
    if (!scope.ids.includes(id)) {
      rows.push({ id, server: null, path: d.path, state: 'skipped', note: 'not selected; declare it in "surfaces" or pass --harness' });
      continue;
    }
    const { servers, problem } = await readServers(root, d);
    if (problem !== null) problems.push(problem);
    for (const server of registry.servers) {
      if (servers === null) {
        rows.push({ id, server: server.id, path: d.path, state: 'unreadable', note: null });
        continue;
      }
      const entry = servers[server.id];
      if (entry === undefined) {
        rows.push({ id, server: server.id, path: d.path, state: 'absent', note: null });
        continue;
      }
      const stale = canonical(entry) !== canonical(renderEntry(server, id));
      rows.push({
        id,
        server: server.id,
        path: d.path,
        state: stale ? 'drift' : 'present',
        note: stale ? `entry differs from what install would write; run ${CLI} mcp install --yes to restore it` : null,
      });
    }
  }
  return { rows, problems };
}

/**
 * Read the servers a harness has configured. A missing file is `{}` (absent), not an
 * error; a file this tool cannot trust is `null` with the problem that says why.
 */
async function readServers(root, d) {
  let text;
  try {
    text = await readFile(join(root, d.path), 'utf8');
  } catch {
    return { servers: {}, problem: null };
  }
  if (d.format === 'toml') {
    const { tables, errors } = parseToml(text);
    const owned = (table) => table !== null && (table === d.container || table.startsWith(`${d.container}.`));
    const problems = errors.filter((error) => owned(error.table)).map((error) => `${d.path} line ${error.line} is outside the TOML subset this tool reads: ${error.text}`);
    if (problems.length > 0) return { servers: null, problem: problems.join('; ') };
    const servers = {};
    for (const [name, obj] of tables) {
      if (!name.startsWith(`${d.container}.`)) continue;
      servers[name.slice(d.container.length + 1)] = obj;
    }
    return { servers, problem: null };
  }
  let config;
  try {
    config = JSON.parse(text);
  } catch (e) {
    return { servers: null, problem: `${d.path} is not valid JSON: ${e.message}` };
  }
  // A file that parses but is not an object cannot hold a servers container, and
  // install refuses to write into one; status has to agree with it.
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return { servers: null, problem: `${d.path} is not a JSON object` };
  }
  let node = config;
  for (const part of d.container.split('.')) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return { servers: {}, problem: null };
    node = node[part];
  }
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return { servers: {}, problem: null };
  return { servers: node, problem: null };
}
