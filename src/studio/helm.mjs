// The Helm's source: the spec's read-only rows, and the one allowlist the API will run.
//
// The palette cannot invent a command: every entry comes from `SPEC`, where a row without
// `writes` is a read. Execution is narrower still. `mcp` and `agent-hook` are reads but
// neither returns a document on a request, and `check` writes its line cache, so they stay
// visible as copyable commands without becoming an API route that quietly writes.

import { SPEC } from '../commands/spec.mjs';

export const HELM_UNRUNNABLE = new Set(['agent-hook', 'check', 'doctor', 'index', 'mcp']);

export function helmCatalog() {
  return SPEC.filter((row) => row.writes === undefined).map((row) => ({
    path: row.path,
    summary: row.summary,
    usage: row.usage ?? '',
    flags: [...(row.flags ?? [])],
    runnable: !HELM_UNRUNNABLE.has(row.path),
  }));
}

export function helmRow(path) {
  const row = SPEC.find((entry) => entry.path === path);
  return row && row.writes === undefined ? row : null;
}
