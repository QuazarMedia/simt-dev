// simt mcp - serve the tool surface over MCP on stdio.
//
// Optional by design: it adds a transport, not a capability, and
// the CLI stays the primary interface because it works in CI, in a hook and in a bare
// shell. What this command must NOT become is a second implementation - it wires the same
// modules the commands use into a line protocol and does nothing else.
//
// `--list` prints the surface and exits, without reading stdin. An editor that has
// misconfigured the command needs to be able to ask what it exposes without hanging, and
// a command that only speaks when spoken to cannot answer that.

import { EXIT, emit, emitJson, fail, isJson } from '../output/index.mjs';
import { TOOLS } from '../mcp/tools.mjs';
import { PROTOCOL_VERSION, SUPPORTED_VERSIONS, serve } from '../mcp/server.mjs';
import { CLI } from '../name.mjs';
import { packageVersion } from '../package-version.mjs';
import { commandRoot } from '../repo-root.mjs';
import { resolveHarnessScope } from '../agents/scope.mjs';
import { loadMcpRegistry } from '../mcpconfig/registry.mjs';
import { mcpStatus } from '../mcpconfig/status.mjs';

export async function mcpCommand(positional, flags) {
  // A subcommand before the transport: `simt mcp status` reports, bare `simt mcp` serves.
  // The serve path stays first-class because an editor's config names the bare form.
  if (positional[0] === 'status') return mcpStatusCommand(flags);

  const version = packageVersion();

  if (flags.list === true) {
    if (isJson(flags)) {
      emitJson({
        ok: true,
        protocolVersion: PROTOCOL_VERSION,
        protocolVersions: SUPPORTED_VERSIONS,
        version,
        // The output schema and the read-only annotation travel with the tool here too:
        // a reader listing the surface should see the same contract a call returns,
        // rather than discovering the shape by making one.
        tools: TOOLS.map(({ name, description, inputSchema, outputSchema, annotations }) => ({
          name,
          description,
          inputSchema,
          ...(outputSchema ? { outputSchema } : {}),
          annotations,
        })),
      });
      return EXIT.OK;
    }
    emit(
      [
        `simt-dev ${version} - MCP surface over stdio (protocols ${SUPPORTED_VERSIONS.join(', ')})`,
        '',
        `${TOOLS.length} tools (all read-only except federation_query, which starts a declared server):`,
        ...TOOLS.map((t) => `  ${t.name.padEnd(16)} ${t.description.split('.')[0]}`),
        '',
        'Nothing here writes to your repositories. init, sync, hooks install, skills install and upgrade stay in the',
        'CLI, because each is meant to be read as a diff by a human before it touches anything.',
        '',
        `serve them with: ${positional[0] ?? `${CLI} mcp`}`,
      ].join('\n'),
    );
    return EXIT.OK;
  }

  try {
    return await serve(TOOLS, { packageVersion: version });
  } catch (error) {
    return fail(`mcp transport failed: ${error.message}`, EXIT.FAIL, `run: ${CLI} mcp --list to check the surface loads`);
  }
}

/**
 * `simt mcp status`: which servers the selected harnesses have CONFIGURED, entry-level.
 * Reports file facts only - a config file is a fact this tool reads; whether the harness
 * accepted the server is a runtime fact it cannot, so "enabled" is never claimed here.
 */
async function mcpStatusCommand(flags) {
  const root = commandRoot(flags);
  const scope = await resolveHarnessScope(root, flags);
  if (scope.error) return fail(scope.error, EXIT.USAGE, scope.remedy);
  const loaded = await loadMcpRegistry(flags);
  if (!loaded.ok) return fail(loaded.errors.join('; '), EXIT.FAIL, 'fix the registry, or name one with --registry <path>');
  const { rows, problems } = await mcpStatus(root, scope, loaded.registry);

  if (isJson(flags)) {
    emitJson({ ok: problems.length === 0, command: 'mcp status', root, harnesses: rows, problems });
    return problems.length === 0 ? EXIT.OK : EXIT.FAIL;
  }

  const lines = [
    `repo     ${root}`,
    `scope    ${scope.source === 'flag' ? `--harness ${scope.ids[0]}` : scope.source === 'surfaces' ? `"surfaces" (${scope.ids.join(', ')})` : 'none selected'}`,
  ];
  if (scope.ids.length === 0) {
    lines.push('NO SCOPE  no harness is selected, so nothing is reported as configured or absent here');
    lines.push(`remedy   ${scope.remedy}`);
    emit(lines.join('\n'));
    return EXIT.OK;
  }
  const word = { present: 'PRESENT  ', absent: 'ABSENT   ', unreadable: 'INVALID  ', drift: 'DRIFT    ', other: 'NOT OURS ', skipped: 'SKIPPED  ' };
  for (const row of rows) {
    lines.push(`${word[row.state]} ${row.id.padEnd(12)} ${(row.path ?? '(no project file is documented)').padEnd(24)} ${row.server ?? row.note ?? ''}`);
    if (row.state === 'absent' || row.state === 'drift') lines.push(`          ${''.padEnd(12)} install: ${CLI} mcp install --yes`);
  }
  if (problems.length > 0) {
    lines.push('');
    lines.push(`problems (${problems.length}):`);
    for (const problem of problems) lines.push(`  ${problem}`);
  }
  emit(lines.join('\n'));
  return problems.length === 0 ? EXIT.OK : EXIT.FAIL;
}
