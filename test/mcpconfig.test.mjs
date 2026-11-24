import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { loadMcpRegistry, selectServers, validateMcpRegistry } from '../src/mcpconfig/registry.mjs';
import { canonical, dialects, renderEntry } from '../src/mcpconfig/dialects.mjs';
import { parseToml, replaceOwnedTables } from '../src/mcpconfig/toml.mjs';
import { mcpStatus } from '../src/mcpconfig/status.mjs';
import { planMcpInstall } from '../src/mcpconfig/install.mjs';
import { pending } from '../src/write/plan.mjs';
import { git, simt as simtCli } from './fixture.mjs';

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

test('renderEntry: opencode reads the V2 shape, every other harness the pair', () => {
  const server = sample().servers[0];
  assert.deepEqual(renderEntry(server), { command: 'simt', args: ['mcp'] });
  assert.deepEqual(renderEntry(server, 'opencode'), { type: 'local', command: ['simt', 'mcp'] });
  const http = { id: 'x', transport: { type: 'http', url: 'https://m' } };
  assert.deepEqual(renderEntry(http), { url: 'https://m' });
  assert.deepEqual(renderEntry(http, 'opencode'), { type: 'remote', url: 'https://m' });
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

test('toml: replaceOwnedTables rewrites the owned blocks and keeps every other byte', () => {
  const text = [
    'notify = [ "a", "b" ]',
    '',
    '[mcp_servers.simt]',
    'command = "old"',
    '',
    '[other.table]',
    'keep = 1',
  ].join('\n');
  const out = replaceOwnedTables(text, 'mcp_servers', { simt: { command: 'simt', args: ['mcp'] } });
  // The foreign lines stay, in place; the owned block is replaced with the entry.
  assert.match(out, /^notify = \[ "a", "b" \]\n/m);
  assert.match(out, /\[other\.table\]\nkeep = 1/);
  assert.match(out, /\[mcp_servers\.simt\]\ncommand = "simt"\nargs = \["mcp"\]/);
  assert.ok(!out.includes('command = "old"'));
  // The second pass over its own output is a no-op: install idempotence rests on this.
  assert.equal(replaceOwnedTables(out, 'mcp_servers', { simt: { command: 'simt', args: ['mcp'] } }), out);
});

test('install: a fresh repo plans the registry entries into every selected harness', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcpconfig-'));
  try {
    const registry = sample();
    const { changes, notes, problems } = await planMcpInstall(dir, { ids: ['cursor', 'codex'] }, registry);
    assert.deepEqual(problems, []);
    const cursor = changes.find((c) => c.path === '.cursor/mcp.json');
    assert.equal(cursor.before, null);
    assert.deepEqual(JSON.parse(cursor.after).mcpServers.simt, { command: 'simt', args: ['mcp'] });
    const codex = changes.find((c) => c.path === '.codex/config.toml');
    assert.match(codex.after, /\[mcp_servers\.simt\]\ncommand = "simt"\nargs = \["mcp"\]/);
    // The plugin row is reported, not written; a harness out of scope is named skipped.
    assert.ok(notes.some((n) => n.id === 'deepseek' && n.state === 'not-ours'));
    assert.ok(notes.some((n) => n.id === 'gemini' && n.state === 'skipped'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('opencode: install writes the V2 entry, and status reads that shape back', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcpconfig-'));
  try {
    const registry = sample();
    const { changes, problems } = await planMcpInstall(dir, { ids: ['opencode'] }, registry);
    assert.deepEqual(problems, []);
    const change = changes.find((c) => c.path === 'opencode.json');
    assert.deepEqual(JSON.parse(change.after).mcp.servers.simt, { type: 'local', command: ['simt', 'mcp'] });
    // The V2 shape is what status calls present; the old command/args pair is drift.
    await writeFile(join(dir, 'opencode.json'), change.after);
    const fresh = await mcpStatus(dir, { ids: ['opencode'] }, registry);
    assert.equal(fresh.rows.find((r) => r.id === 'opencode').state, 'present');
    await writeFile(join(dir, 'opencode.json'), JSON.stringify({ mcp: { servers: { simt: { command: 'simt', args: ['mcp'] } } } }));
    const stale = await mcpStatus(dir, { ids: ['opencode'] }, registry);
    assert.equal(stale.rows.find((r) => r.id === 'opencode').state, 'drift');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('install: a second install over its own output is unchanged', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcpconfig-'));
  try {
    const registry = sample();
    const first = await planMcpInstall(dir, { ids: ['cursor', 'codex'] }, registry);
    for (const c of first.changes) {
      await mkdir(join(dir, dirname(c.path)), { recursive: true });
      await writeFile(join(dir, c.path), c.after);
    }
    const second = await planMcpInstall(dir, { ids: ['cursor', 'codex'] }, registry);
    assert.equal(pending(second.changes).length, 0, JSON.stringify(second.changes));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('install: a repo-owned key survives with its order, and a drifted ours is replaced in place', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcpconfig-'));
  try {
    await repo(dir, {
      '.cursor/mcp.json': JSON.stringify({ mcpServers: { other: { command: 'x', args: [] }, simt: { command: 'simt' } }, otherTop: 1 }),
    });
    const { changes, problems } = await planMcpInstall(dir, { ids: ['cursor'] }, sample());
    assert.deepEqual(problems, []);
    const parsed = JSON.parse(changes.find((c) => c.path === '.cursor/mcp.json').after);
    assert.deepEqual(Object.keys(parsed), ['mcpServers', 'otherTop']);
    assert.deepEqual(Object.keys(parsed.mcpServers), ['other', 'simt']);
    assert.deepEqual(parsed.mcpServers.simt, { command: 'simt', args: ['mcp'] });
    assert.deepEqual(parsed.mcpServers.other, { command: 'x', args: [] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('install: a scope of one plans one file, and names the rest skipped', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcpconfig-'));
  try {
    const { changes, notes } = await planMcpInstall(dir, { ids: ['cursor'] }, sample());
    assert.deepEqual(changes.map((c) => c.path), ['.cursor/mcp.json']);
    assert.ok(notes.some((n) => n.id === 'codex' && n.state === 'skipped'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('install: a config this tool cannot parse is named, and the plan says refuse', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcpconfig-'));
  try {
    await repo(dir, {
      '.cursor/mcp.json': '{ not json',
      '.codex/config.toml': '[mcp_servers.simt]\ncommand = "simt"\nargs = ["mcp"]\n',
    });
    const { problems } = await planMcpInstall(dir, { ids: ['cursor', 'codex'] }, sample());
    assert.equal(problems.length, 1);
    assert.match(problems[0], /not valid JSON/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('install (CLI): --yes writes every selected harness, and the next run is up to date', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcpconfig-'));
  try {
    await git(['init', '-q', root]);
    const run = (args) => simtCli([...args, '--root', root], { maxBuffer: 8 << 20 });
    const first = await run(['mcp', 'install', '--yes', '--harness', 'cursor']);
    assert.equal(first.code, 0, first.stderr);
    const written = JSON.parse(await readFile(join(root, '.cursor', 'mcp.json'), 'utf8'));
    assert.deepEqual(written.mcpServers.simt, { command: 'simt', args: ['mcp'] });
    const second = await run(['mcp', 'install', '--harness', 'cursor']);
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /up to date/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('install (CLI): a broken config is refused, and no other harness is written', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcpconfig-'));
  try {
    await git(['init', '-q', root]);
    // Surfaces selects both harnesses, so the refusal must hold across a write that
    // would have landed.
    await writeFile(join(root, 'simt.json'), JSON.stringify({ surfaces: ['cursor', 'codex'] }));
    await mkdir(join(root, '.cursor'), { recursive: true });
    await writeFile(join(root, '.cursor', 'mcp.json'), '{ not json');
    const run = (args) => simtCli([...args, '--root', root], { maxBuffer: 8 << 20 });
    const result = await run(['mcp', 'install', '--yes']);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr + result.stdout, /not valid JSON/);
    // The refusal is all-or-nothing: the other harness got nothing.
    assert.equal(existsSync(join(root, '.codex', 'config.toml')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
