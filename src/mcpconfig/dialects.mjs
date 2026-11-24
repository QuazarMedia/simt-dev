// The dialect table: where each harness keeps its MCP servers, and the shape an entry
// takes once written.
//
// The `loader.mcp` facet of the harness records is the sole source of the LOCATION -
// the file, and for a shared config file the key that holds the servers inside it. This
// module adds only what the facet does not carry: the container of a dedicated file,
// the format, and the entry shape a transport renders to. A second copy of a vendor
// location would be a defect, so nothing here re-states a path the facet already names.

import { loadHarnesses } from '../harness/records.mjs';

/** Every dedicated MCP config file this tool knows names its servers under `mcpServers`. */
const DEDICATED_CONTAINER = 'mcpServers';

/**
 * One row per harness: `{ id, path, format, container }`, or `null` for a harness whose
 * servers are not a project file this tool can read (a plugin row, documented as such).
 * `path: null` with a note is the same answer agent-hooks give a reader with no hooks
 * file: reported from the table that documents it, not from a second list.
 */
export function dialects(root = null) {
  const out = {};
  for (const record of loadHarnesses(root)) {
    const mcp = record.loader?.mcp;
    if (!mcp || mcp.path === null) {
      out[record.id] = { id: record.id, path: null, format: null, container: null, note: mcp?.verified ?? null };
      continue;
    }
    out[record.id] = {
      id: record.id,
      path: mcp.path,
      format: mcp.path.endsWith('.toml') ? 'toml' : 'json',
      // A shared config file keeps the key the facet names; a dedicated file is a
      // single-purpose document whose container is the vendor constant.
      container: mcp.key ?? DEDICATED_CONTAINER,
    };
  }
  return out;
}

/**
 * The entry a server's transport renders to, in the shape the harness reads. Most
 * harnesses take `command` + `args` for stdio, `url` for http; opencode V2 requires a
 * `type` and a single `command` array, and ignores the pair - verified: `opencode mcp
 * list` reported no servers against the old shape. Status and install render from this
 * one call with the dialect row's id, so they cannot disagree about what an entry means.
 */
export function renderEntry(server, harness = null) {
  if (server.transport.type === 'stdio') {
    if (harness === 'opencode') return { type: 'local', command: [server.transport.command, ...(server.transport.args ?? [])] };
    return { command: server.transport.command, args: server.transport.args ?? [] };
  }
  if (harness === 'opencode') return { type: 'remote', url: server.transport.url };
  return { url: server.transport.url };
}

/**
 * Canonical JSON with sorted keys, for comparing two objects that must be equal as
 * data, not as bytes: a reader who hand-writes `{"args": [...], "command": "..."}`
 * in a different key order is not drift, and a string comparison of the file's bytes
 * would call it that.
 */
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
