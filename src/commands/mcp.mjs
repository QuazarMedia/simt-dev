// simt-dev mcp - serve the tool surface over MCP on stdio.
//
// Optional by design (plan 0002 section 5): it adds a transport, not a capability, and
// the CLI stays the primary interface because it works in CI, in a hook and in a bare
// shell. What this command must NOT become is a second implementation - it wires the same
// modules the commands use into a line protocol and does nothing else.
//
// `--list` prints the surface and exits, without reading stdin. An editor that has
// misconfigured the command needs to be able to ask what it exposes without hanging, and
// a command that only speaks when spoken to cannot answer that.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { EXIT, emit, fail, isJson } from '../output/index.mjs';
import { TOOLS } from '../mcp/tools.mjs';
import { PROTOCOL_VERSION, serve } from '../mcp/server.mjs';
import { CLI } from '../name.mjs';

export async function mcpCommand(positional, flags) {
  const { version } = await packageVersion();

  if (flags.list === true) {
    if (isJson(flags)) {
      emit(`${JSON.stringify({ ok: true, protocolVersion: PROTOCOL_VERSION, version, tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) }, null, 2)}\n`);
      return EXIT.OK;
    }
    emit(
      [
        `simt-dev ${version} - MCP surface over stdio (protocol ${PROTOCOL_VERSION})`,
        '',
        `${TOOLS.length} read-only tools:`,
        ...TOOLS.map((t) => `  ${t.name.padEnd(16)} ${t.description.split('.')[0]}`),
        '',
        'No tool here writes. init, sync, hooks install, skills install and upgrade stay in the',
        'CLI, because each is meant to be read as a diff by a human before it touches anything.',
        '',
        `serve them with: ${positional[0] ?? `${CLI} mcp`}`,
      ].join('\n'),
      { maxBytes: flags.maxBytes ?? 0 },
    );
    return EXIT.OK;
  }

  try {
    return await serve(TOOLS, { version });
  } catch (error) {
    return fail(`mcp transport failed: ${error.message}`, EXIT.FAIL, `run: ${CLI} mcp --list to check the surface loads`);
  }
}

async function packageVersion() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(await readFile(join(here, '..', '..', 'package.json'), 'utf8'));
    return { version: pkg.version };
  } catch {
    // A missing version must not stop the server: the client already knows which
    // build it launched, and a hard failure here would look like a protocol bug.
    return { version: 'unknown' };
  }
}