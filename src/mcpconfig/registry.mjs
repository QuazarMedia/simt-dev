// The MCP server registry: which external servers simt-dev knows, how each is
// reached, and when a task needs one.
//
// Unlike the skill registry this is package data, not workspace data: a skill body
// lives in the repository that holds it, while an MCP server is an external process
// whose transport (a command or a URL) is the same everywhere the reader runs. The
// catalogue therefore ships with the tool, beside `harnesses/`, and an installed
// package serves its own catalogue to every repository.
//
// Selection deliberately has no second idea of what a task matches: `selectServers`
// scores each entry with the same `scoreSkill` the skill resolver uses, so a server
// is offered for exactly the reasons a skill would be - capability, keyword, name,
// summary, stack - and nothing this module invents.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { PACKAGE_ROOT } from '../workspace.mjs';
import { scoreSkill, selectionVerdict } from '../resolve/resolve.mjs';

/** The catalogue this tool ships; an explicit path always wins over it. */
export const MCP_REGISTRY_FILE = join(PACKAGE_ROOT, 'graph', 'mcp.json');

/**
 * Validate a parsed registry. Returns an array of named errors; empty means the
 * shape holds. Every error names the offending entry, because a hand-authored
 * registry that fails silently stops being trustworthy to read from.
 */
export function validateMcpRegistry(data) {
  const errors = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return ['the registry root is not an object'];
  }
  if (!Number.isInteger(data.version) || data.version < 1) {
    errors.push('`version` must be an integer of 1 or more');
  }
  if (!Array.isArray(data.servers)) {
    return [...errors, '`servers` must be an array'];
  }
  const seen = new Set();
  data.servers.forEach((server, index) => {
    const id = typeof server?.id === 'string' && server.id !== '' ? server.id : `servers[${index}]`;
    if (id === `servers[${index}]`) {
      errors.push(`servers[${index}]: \`id\` must be a non-empty string`);
    } else if (seen.has(id)) {
      errors.push(`servers[${index}]: duplicate \`id\` ${id}`);
    }
    seen.add(id);
    if (typeof server?.name !== 'string' || server.name === '') {
      errors.push(`${id}: \`name\` must be a non-empty string`);
    }
    if (typeof server?.summary !== 'string' || server.summary === '') {
      errors.push(`${id}: \`summary\` must be a non-empty string`);
    }
    const caps = server.capabilities ?? [];
    if (!Array.isArray(caps) || caps.some((cap) => typeof cap !== 'string')) {
      errors.push(`${id}: \`capabilities\` must be an array of strings when present`);
    }
    const t = server.transport;
    if (!t || typeof t !== 'object') {
      errors.push(`${id}: \`transport\` must be an object`);
    } else if (t.type === 'stdio') {
      if (typeof t.command !== 'string' || t.command === '') {
        errors.push(`${id}: a stdio transport needs a non-empty \`command\``);
      }
      if (!Array.isArray(t.args) || t.args.some((arg) => typeof arg !== 'string')) {
        errors.push(`${id}: a stdio transport's \`args\` must be an array of strings when present`);
      }
    } else if (t.type === 'http') {
      if (typeof t.url !== 'string' || t.url === '') {
        errors.push(`${id}: an http transport needs a non-empty \`url\``);
      }
    } else {
      errors.push(`${id}: \`transport.type\` must be "stdio" or "http"`);
    }
  });
  return errors;
}

/**
 * Load and validate the registry. `flags.registry` names a file explicitly;
 * anything else reads the catalogue this package ships.
 *
 * @returns {Promise<{ok: boolean, registry?: object, errors: string[]}>}
 */
export async function loadMcpRegistry(flags = {}) {
  const path = flags.registry ?? MCP_REGISTRY_FILE;
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (cause) {
    return { ok: false, errors: [`no MCP registry at ${path}: ${cause.message}`] };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (cause) {
    return { ok: false, errors: [`${path} is not valid JSON: ${cause.message}`] };
  }
  const errors = validateMcpRegistry(data);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, registry: data, errors: [] };
}

/**
 * The servers a task names, in score order.
 *
 * A server with no capabilities is never auto-offered: it appears in `simt mcp
 * list`, not in every packet. That is the rule that keeps a catalogue of ten
 * servers from becoming noise in a brief about one.
 */
export function selectServers(registry, context) {
  const selected = [];
  for (const server of registry.servers) {
    if ((server.capabilities ?? []).length === 0) continue;
    const { score, evidence, reasons } = scoreSkill(server, context);
    if (selectionVerdict(evidence, reasons) === null) {
      selected.push({ server, score, reasons });
    }
  }
  selected.sort((a, b) => b.score - a.score || a.server.id.localeCompare(b.server.id));
  return selected;
}
