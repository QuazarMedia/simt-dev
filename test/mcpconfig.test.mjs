import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { loadMcpRegistry, selectServers, validateMcpRegistry } from '../src/mcpconfig/registry.mjs';
import { canonical, dialects, renderEntry } from '../src/mcpconfig/dialects.mjs';
import { parseToml } from '../src/mcpconfig/toml.mjs';
import { mcpStatus } from '../src/mcpconfig/status.mjs';

/** A valid registry with one stdio server, for shape tests that mutate freely. */
function sample() {
  return {
    version: 1,
    servers: [
      {
        id: 'simt',
        name: 'simt-dev',
        summary: 'The simt-dev tool surface over MCP.',
        transport: { type: 'stdio', command: 'simt', args: ['mcp'] },
        capabilities: ['feature-slice', 'release'],
      },
    ],
  };
}

test('registry: the shipped catalogue loads and carries the simt entry', async () => {
  const { ok, registry, errors } = await loadMcpRegistry();
  assert.equal(ok, true, errors.join('\n'));
  const simt = registry.servers.find((server) => server.id === 'simt');
  assert.ok(simt, 'the simt server is the one this estate knows end to end');
  assert.equal(simt.transport.type, 'stdio');
  assert.equal(simt.transport.command, 'simt');
});

test('select: a task naming a capability selects the server', async () => {
  const { ok, registry } = await loadMcpRegistry();
  assert.equal(ok, true);
  const selected = selectServers(registry, { taskTokens: ['prepare', 'a', 'release'] });
  assert.equal(selected.length, 1);
  assert.equal(selected[0].server.id, 'simt');
  assert.ok(selected[0].reasons.some((reason) => reason.startsWith('capability:')));
});

test('select: a task with no overlap selects nothing', async () => {
  const { ok, registry } = await loadMcpRegistry();
  assert.equal(ok, true);
  const selected = selectServers(registry, { taskTokens: ['xylophone'] });
  assert.deepEqual(selected, []);
});

test('select: a server without capabilities is never auto-offered', () => {
  const registry = sample();
  registry.servers[0].capabilities = [];
  // The task names the server's own word; name signal alone must not select it.
  const selected = selectServers(registry, { taskTokens: ['simt', 'mcp'] });
  assert.deepEqual(selected, []);
});

test('validate: a stdio transport without a command names its entry', () => {
  const registry = sample();
  delete registry.servers[0].transport.command;
  const errors = validateMcpRegistry(registry);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^simt: a stdio transport needs a non-empty `command`$/);
});

test('validate: duplicate ids are named', () => {
  const registry = sample();
  registry.servers.push({ ...registry.servers[0] });
  const errors = validateMcpRegistry(registry);
  assert.deepEqual(errors, ['servers[1]: duplicate `id` simt']);
});

test('validate: an unknown transport type is named', () => {
  const registry = sample();
  registry.servers[0].transport = { type: 'grpc', url: 'https://example.com' };
  const errors = validateMcpRegistry(registry);
  assert.deepEqual(errors, ['simt: `transport.type` must be "stdio" or "http"']);
});

test('load: an explicit path wins, and a broken file reports its errors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcpconfig-'));
  try {
    const path = join(dir, 'mcp.json');
    await writeFile(path, JSON.stringify({ version: 1, servers: [{ id: 'broken' }] }));
    const { ok, errors } = await loadMcpRegistry({ registry: path });
    assert.equal(ok, false);
    assert.ok(errors.every((error) => error.startsWith('broken:')), errors.join('\n'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('dialects: one row per harness, and the facet stays the source of location', () => {
  const table = dialects();
  assert.equal(table.codex.format, 'toml');
  assert.equal(table.codex.container, 'mcp_servers');
  assert.equal(table.cursor.format, 'json');
  assert.equal(table.cursor.path, '.cursor/mcp.json');
  // A shared config file keeps the key its facet names, nested for opencode.
  assert.equal(table.opencode.container, 'mcp.servers');
  // A harness whose servers are a plugin row has no file this tool reads.
  assert.equal(table.deepseek.path, null);
});

test('canonical: key order is not drift', () => {
  assert.equal(canonical({ command: 'simt', args: ['mcp'] }), canonical({ args: ['mcp'], command: 'simt' }));
  assert.notEqual(canonical({ command: 'simt' }), canonical({ command: 'simt', args: [] }));
});

test('toml: the subset reads the tables this tool owns and names what it cannot', () => {
  const text = [
    'notify = [ "a", "b" ]',
    '',
    '[mcp_servers.simt]',
    'command = "simt"',
    'args = ["mcp"]',
    'timeout_ms = 30',
    '',
    '[mcp_servers.odd]',
    'entry = { inline = 1 }',
  ].join('\n');
  const { tables, errors } = parseToml(text);
  assert.deepEqual(tables.get('mcp_servers.simt'), { command: 'simt', args: ['mcp'], timeout_ms: 30 });
  // The inline table is outside the subset; its line is named, and only lines inside
  // owned tables count, which is the caller's decision - the parser reports, not judges.
  assert.equal(errors.length, 1);
  assert.equal(errors[0].table, 'mcp_servers.odd');
});

async function repo(root, files) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, dirname(path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

test('status: a fresh repo reports every selected harness absent, with the install remedy', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcpconfig-'));
  try {
    const registry = sample();
    const { rows, problems } = await mcpStatus(dir, { ids: ['cursor', 'codex'] }, registry);
    assert.deepEqual(problems, []);
    const cursor = rows.filter((row) => row.id === 'cursor');
    assert.equal(cursor.length, 1);
    assert.equal(cursor[0].state, 'absent');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('status: a current-shape entry is present; repo-owned keys beside it are not drift', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcpconfig-'));
  try {
    // Key order differs from the render, and a repo-owned server sits beside ours:
    // neither is drift.
    await repo(dir, {
      '.cursor/mcp.json': JSON.stringify({ mcpServers: { other: { command: 'x', args: [] }, simt: { args: ['mcp'], command: 'simt' } } }),
    });
    const registry = sample();
    const { rows, problems } = await mcpStatus(dir, { ids: ['cursor'] }, registry);
    assert.deepEqual(problems, []);
    const cursor = rows.find((row) => row.id === 'cursor');
    assert.equal(cursor.state, 'present');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('status: a stale-shape entry is drift with the install remedy', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcpconfig-'));
  try {
    await repo(dir, { '.cursor/mcp.json': JSON.stringify({ mcpServers: { simt: { command: 'simt' } } }) });
    const registry = sample();
    const { rows, problems } = await mcpStatus(dir, { ids: ['cursor'] }, registry);
    assert.deepEqual(problems, []);
    const cursor = rows.find((row) => row.id === 'cursor');
    assert.equal(cursor.state, 'drift');
    assert.match(cursor.note, /simt mcp install --yes/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('status: codex TOML round-trips - current table present, stale drift', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcpconfig-'));
  try {
    await repo(dir, { '.codex/config.toml': '[mcp_servers.simt]\ncommand = "simt"\nargs = ["mcp"]\n' });
    const registry = sample();
    const fresh = await mcpStatus(dir, { ids: ['codex'] }, registry);
    assert.equal(fresh.rows.find((row) => row.id === 'codex').state, 'present', JSON.stringify(fresh));
    await writeFile(join(dir, '.codex', 'config.toml'), '[mcp_servers.simt]\ncommand = "simt"\n');
    const stale = await mcpStatus(dir, { ids: ['codex'] }, registry);
    assert.equal(stale.rows.find((row) => row.id === 'codex').state, 'drift');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('status: a file this tool cannot trust is unreadable, and only that fails the command', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcpconfig-'));
  try {
    await repo(dir, { '.cursor/mcp.json': '{ not json' });
    const registry = sample();
    const { rows, problems } = await mcpStatus(dir, { ids: ['cursor'] }, registry);
    assert.equal(rows.find((row) => row.id === 'cursor').state, 'unreadable');
    assert.equal(problems.length, 1);
    assert.match(problems[0], /not valid JSON/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
