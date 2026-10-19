// Federation configuration: the servers a repository names, and nothing else (plan 0003 R26).
//
// A brief is deterministic by default. Federation is the one opt-in exception, and the
// opt-in is a `federation` block in the repository's own manifest. Nothing here probes a
// harness config, scans for a server that might exist, or opens a socket the manifest did
// not ask for — a repository that declared nothing pays nothing and reads nothing. Where
// a harness would keep the same names is R42's several slices away, and it is a different
// question: this one is "what did the repository commit", not "what did the editor
// configure".
//
// The trust model is the one `gates.commands` already has. Those are commands a repository
// declares and this tool runs; a federation server is the same declaration one layer up.
// The manifest is the file a person reviews before they commit the change, so a command in
// it is a command the repository meant to run.
//
// The block is deliberately small, because every field in it is a promise the packet has
// to keep:
//
//   "federation": {
//     "servers": [
//       {
//         "name": "serena",                  // required, unique; the name the packet cites
//         "command": "uvx",                  // required; started with stdio pipes
//         "args": ["serena", "start-mcp-server"],
//         "tool": "find_symbol",             // optional; the MCP tool to call, default "query"
//         "argument": "query",               // optional; where the question goes, default "query"
//         "languages": ["python"],           // optional; the coverage the packet records
//         "timeoutMs": 4000                  // optional; the wait, default 5000
//       }
//     ]
//   }
//
// An entry that breaks the shape is not a crash and not a silent skip. It becomes a finding
// with a sentence in it, the brief turns that into a caution, and every other entry still
// runs. A malformed block costs the reader one line, which is exactly what they need to fix
// it — and a silent skip is the failure that line exists to prevent.

import { readManifest } from '../projection/manifest.mjs';
import { DEFAULT_TIMEOUT_MS } from './client.mjs';

/** The tool a server is asked for when it does not name one. */
const DEFAULT_TOOL = 'query';

/** The argument the question is placed in when a server does not name one. */
const DEFAULT_ARGUMENT = 'query';

/** A list of strings, or null when the value is anything else. */
function strings(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? [...value] : null;
}

/** A non-empty trimmed string, or the empty string. */
function word(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** One declared server, or the sentence explaining why it is not one. */
function serverOf(entry, seen) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return { finding: 'a federation server must be an object' };
  }
  const name = word(entry.name);
  if (name.length === 0) return { finding: 'a federation server needs a `name`' };
  // The name is claimed before the rest is checked, so a rejected entry still reserves it:
  // two entries called `serena` are a mistake whether or not the first one is also
  // malformed, and a duplicate that only surfaced once both were valid would be the harder
  // mistake to see.
  if (seen.has(name)) return { finding: `two federation servers are named \`${name}\`` };
  seen.add(name);

  const command = word(entry.command);
  if (command.length === 0) return { finding: `the \`${name}\` server needs a \`command\`` };

  const args = entry.args === undefined ? [] : strings(entry.args);
  if (args === null) return { finding: `the \`${name}\` server's \`args\` must be a list of strings` };
  const languages = entry.languages === undefined ? [] : strings(entry.languages);
  if (languages === null) return { finding: `the \`${name}\` server's \`languages\` must be a list of strings` };

  const tool = entry.tool === undefined ? DEFAULT_TOOL : word(entry.tool);
  if (tool.length === 0) return { finding: `the \`${name}\` server's \`tool\` must be a tool name` };
  const argument = entry.argument === undefined ? DEFAULT_ARGUMENT : word(entry.argument);
  if (argument.length === 0) return { finding: `the \`${name}\` server's \`argument\` must be an argument name` };

  const timeoutMs = entry.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : entry.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    return { finding: `the \`${name}\` server's \`timeoutMs\` must be a positive whole number` };
  }

  return { server: { name, command, args, tool, argument, languages, timeoutMs } };
}

/**
 * The servers a manifest declares, and the reason each rejected one was rejected.
 *
 * Pure: the manifest comes in, the decision comes out, and the same manifest always gives
 * the same two lists. The order is the manifest's, because a packet's items are ordered and
 * a federation answer is a packet item.
 */
export function federationServers(manifest) {
  const block = manifest?.federation;
  if (block === undefined || block === null) return { servers: [], findings: [] };
  if (typeof block !== 'object' || Array.isArray(block)) {
    return { servers: [], findings: ['`federation` must be an object'] };
  }
  const declared = block.servers;
  if (declared === undefined || declared === null) return { servers: [], findings: [] };
  if (!Array.isArray(declared)) return { servers: [], findings: ['`federation.servers` must be a list'] };

  const servers = [];
  const findings = [];
  const seen = new Set();
  for (const entry of declared) {
    const parsed = serverOf(entry, seen);
    if (parsed.finding !== undefined) {
      findings.push(parsed.finding);
      continue;
    }
    servers.push(parsed.server);
  }
  return { servers, findings };
}

/**
 * The same two lists, read from the repository's manifest.
 *
 * A repository with no manifest, an unreadable one or none at all declares no servers and
 * reports no finding: federation is silent unless it was asked for, and "you did not
 * configure this" is not a fault a reader needs told.
 */
export async function readFederation(root) {
  const { manifest, exists, error } = await readManifest(root);
  if (!exists || error !== null || manifest === null) return { servers: [], findings: [] };
  return federationServers(manifest);
}
