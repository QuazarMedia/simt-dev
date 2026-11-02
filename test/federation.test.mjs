// Federation with an external code-graph server (R26).
//
// The slice's accept arm is one sentence: a fake MCP server answers, and the brief cites it
// as the source. So the fake server here is a real child process over real pipes, spoken to
// with real newline-delimited JSON-RPC — a stub of the client would have exercised neither
// the framing nor the lifetime, which are the two things that break first.
//
// Three properties are held here beside the accept arm, because each one is a way the
// feature could be worse than absent: a malformed manifest costs a caution and not a
// failure, a server that never answers costs a bounded wait and not a hang, and a repository
// that declared nothing pays nothing at all.

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { callTool, DEFAULT_TIMEOUT_MS } from '../src/federation/client.mjs';
import { federationAccess, federationServers } from '../src/federation/config.mjs';
import { CONFIG_DIR, CONFIG_FILE } from '../src/workspace.mjs';
import { TOOLS } from '../src/mcp/tools.mjs';
import { git, simt as simtCli } from './fixture.mjs';


/**
 * The timeout is on the child, not the test.
 *
 * If the client failed to bound its wait, this call would never return and the suite would
 * hang rather than fail — and a hang is the one failure mode that reports nothing.
 */
const run = (root, args) => simtCli([...args, '--root', root], { maxBuffer: 8 << 20, timeout: 30000 });

/** A minimal MCP server: it initializes, and it answers any tool call with fixed text. */
const ANSWERING_SERVER = `
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let index = buffer.indexOf('\\n');
  while (index !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf('\\n');
    if (line.length === 0) continue;
    const message = JSON.parse(line);
    if (message.id === undefined) continue;
    if (message.method === 'tools/call') {
      const query = message.params && message.params.arguments ? message.params.arguments.query : '';
      reply(message.id, { content: [{ type: 'text', text: 'fixture knows about ' + query }] });
    } else {
      reply(message.id, { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fixture-graph', version: '1.0.0' } });
    }
  }
});
function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
}
`;

/** A server that reads but never answers: the timeout's only job is to bound it. */
const SILENT_SERVER = `
process.stdin.resume();
`;

/** A repository with one source file, one test, and the two fixture servers on disk. */
async function fixture(federation) {
  const root = await mkdtemp(join(tmpdir(), 'federation-'));
  await git(['init', '-q', root]);
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'test'), { recursive: true });
  await writeFile(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'fixture', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`,
  );
  await writeFile(join(root, 'README.md'), '# fixture\n');
  await writeFile(join(root, 'src', 'keep.mjs'), 'export function keep(value) {\n  return value;\n}\n');
  await writeFile(
    join(root, 'test', 'keep.test.mjs'),
    "import assert from 'node:assert/strict';\nimport { keep } from '../src/keep.mjs';\n\ntest('keep', () => assert.equal(keep(1), 1));\n",
  );
  await writeFile(join(root, 'server.mjs'), ANSWERING_SERVER);
  await writeFile(join(root, 'silent.mjs'), SILENT_SERVER);
  if (federation !== undefined) {
    await writeFile(join(root, 'simt.json'), `${JSON.stringify({ federation }, null, 2)}\n`);
  }
  await git(['-C', root, 'add', '-A']);
  await git(['-C', root, 'commit', '-qm', 'initial']);
  return root;
}

/** The manifest entry that starts the answering fixture server. */
function answeringEntry(extra = {}) {
  return { name: 'fixture-graph', command: process.execPath, args: ['server.mjs'], tool: 'query', ...extra };
}

test('a well-formed server keeps its shape and gets the two defaults', () => {
  const { servers, findings } = federationServers({
    federation: { servers: [{ name: 'serena', command: 'uvx', args: ['serena'], languages: ['python'] }] },
  });
  assert.deepEqual(findings, []);
  assert.deepEqual(servers, [
    {
      name: 'serena',
      command: 'uvx',
      args: ['serena'],
      tool: 'query',
      argument: 'query',
      languages: ['python'],
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
  ]);
});

test('a malformed block names what is wrong instead of throwing', () => {
  assert.deepEqual(federationServers({}).servers, []);
  assert.deepEqual(federationServers({ federation: {} }).servers, []);
  assert.deepEqual(federationServers({ federation: { servers: 'serena' } }).findings, ['`federation.servers` must be a list']);
  assert.deepEqual(federationServers({ federation: 'serena' }).findings, ['`federation` must be an object']);

  const broken = federationServers({
    federation: {
      servers: [
        { name: 'no-command' },
        { name: 'no-clock', command: 'x', timeoutMs: 0 },
        { name: 'no-clock', command: 'y' },
        { command: 'z' },
      ],
    },
  });
  assert.deepEqual(broken.servers, []);
  assert.deepEqual(broken.findings, [
    'the `no-command` server needs a `command`',
    "the `no-clock` server's `timeoutMs` must be a positive whole number",
    'two federation servers are named `no-clock`',
    'a federation server needs a `name`',
  ]);
});

test('a declared server answers and the brief cites it as the source', async (t) => {
  const root = await fixture({ servers: [answeringEntry({ languages: ['python'] })] });
  t.after(() => rm(root, { recursive: true, force: true }));

  const text = await run(root, ['brief', 'fix the keep helper']);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /^FEDERATION$/m);
  assert.match(text.stdout, /fixture-graph — fixture knows about fix the keep helper/);
  assert.match(text.stdout, /fixture-graph covers python/);

  const json = await run(root, ['brief', 'fix the keep helper', '--json']);
  assert.equal(json.code, 0, json.stderr);
  const payload = JSON.parse(json.stdout.trim());
  assert.equal(payload.ok, true);
  const federation = payload.sections.FEDERATION ?? [];
  assert.ok(
    federation.includes('fixture-graph — fixture knows about fix the keep helper'),
    `the packet did not cite the server: ${JSON.stringify(federation)}`,
  );
  assert.ok(federation.includes('fixture-graph covers python'), `the packet did not record coverage: ${JSON.stringify(federation)}`);
});

test('a malformed entry is a caution, and the servers beside it still answer', async (t) => {
  const root = await fixture({ servers: [{ name: 'broken' }, answeringEntry()] });
  t.after(() => rm(root, { recursive: true, force: true }));

  const { code, stdout, stderr } = await run(root, ['brief', 'fix the keep helper']);
  assert.equal(code, 0, stderr);
  assert.match(stdout, /federation: the .broken. server needs a .command./);
  assert.match(stdout, /fixture knows about fix the keep helper/);
});

test('a server that never answers costs a bounded wait, not the brief', async (t) => {
  const root = await fixture({ servers: [{ name: 'slow', command: process.execPath, args: ['silent.mjs'], timeoutMs: 300 }] });
  t.after(() => rm(root, { recursive: true, force: true }));

  const started = Date.now();
  const { code, stdout, stderr } = await run(root, ['brief', 'fix the keep helper']);
  const elapsed = Date.now() - started;
  assert.equal(code, 0, stderr);
  assert.match(stdout, /federation: the .slow. server did not answer/);
  assert.match(stdout, /no answer within 300 ms/);
  assert.ok(elapsed < 20000, `the brief waited ${elapsed} ms on a silent server`);
});

test('a repository that declared nothing pays nothing', async (t) => {
  const root = await fixture(undefined);
  t.after(() => rm(root, { recursive: true, force: true }));

  const { code, stdout } = await run(root, ['brief', 'fix the keep helper']);
  assert.equal(code, 0);
  assert.ok(!stdout.includes('FEDERATION'), 'a packet with no federation declaration mentions federation');
});

/** The tool the surface exposes, looked up once so a rename fails loudly here. */
function federationTool() {
  const tool = TOOLS.find((entry) => entry.name === 'federation_query');
  assert.ok(tool, 'the mcp surface has no federation_query tool');
  return tool;
}

/**
 * The operator's side of the trust contract (Q13): the workspace this server was
 * started in, and a user config naming the servers it may start. Spawning repo
 * commands is authorised by the operator's file, never by the repo manifest alone.
 */
async function withOperator(root, userFederation, body) {
  const home = await mkdtemp(join(tmpdir(), 'federation-home-'));
  await mkdir(join(home, CONFIG_DIR), { recursive: true });
  await writeFile(join(home, CONFIG_DIR, CONFIG_FILE), `${JSON.stringify({ federation: userFederation }, null, 2)}\n`);
  const previous = { workspace: process.env.SIMT_DEV_WORKSPACE, xdg: process.env.XDG_CONFIG_HOME };
  process.env.SIMT_DEV_WORKSPACE = dirname(root);
  process.env.XDG_CONFIG_HOME = home;
  try {
    return await body(join(home, CONFIG_DIR, CONFIG_FILE));
  } finally {
    if (previous.workspace === undefined) delete process.env.SIMT_DEV_WORKSPACE;
    else process.env.SIMT_DEV_WORKSPACE = previous.workspace;
    if (previous.xdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous.xdg;
    await rm(home, { recursive: true, force: true });
  }
}

test('the federation tool forwards a query and names the server that answered', async (t) => {
  const root = await fixture({ servers: [answeringEntry()] });
  t.after(() => rm(root, { recursive: true, force: true }));

  const answer = await withOperator(root, { servers: ['fixture-graph'] }, () =>
    federationTool().run({ root, query: 'what calls keep' }));
  assert.deepEqual(answer.servers, ['fixture-graph']);
  assert.equal(answer.answers.length, 1);
  assert.equal(answer.answers[0].server, 'fixture-graph');
  assert.equal(answer.answers[0].tool, 'query');
  assert.match(answer.answers[0].text, /fixture knows about what calls keep/);
  assert.deepEqual(answer.findings, []);
});

test('the federation tool refuses a root outside the server workspace (Q13)', async (t) => {
  // A model-supplied root can point at a directory with a crafted manifest whose
  // `command` this tool would otherwise spawn. Outside the server's own ground —
  // its cwd or the resolved workspace — the call is refused before anything runs.
  const root = await fixture({ servers: [answeringEntry()] });
  t.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(() => federationTool().run({ root, query: 'anything' }), (error) => {
    assert.match(error.message, /outside the server workspace/);
    assert.match(error.remedy, /workspace this server was started in/);
    return true;
  });
});

test('the federation tool refuses a server the user config does not name (Q13)', async (t) => {
  // The repo manifest declares; the operator authorises. A server nobody named in
  // their own file is a spawn nobody approved, however the repo asks.
  const root = await fixture({ servers: [answeringEntry()] });
  t.after(() => rm(root, { recursive: true, force: true }));

  await withOperator(root, { servers: ['someone-else'] }, async (configPath) => {
    await assert.rejects(() => federationTool().run({ root, query: 'anything' }), (error) => {
      assert.match(error.message, /not named in the user config/);
      assert.ok(error.remedy.includes(configPath), `the remedy names the operator file: ${error.remedy}`);
      return true;
    });
  });
});

test('federationAccess is the two gates in one pure function (Q13)', () => {
  const base = { cwd: '/srv/app', workspaceRoot: '/srv/ws', serverNames: ['g'], userConfig: { federation: { servers: ['g'] } }, configPath: '/home/op/.config/simt-dev/config.json' };
  assert.equal(federationAccess({ ...base, root: '/srv/ws/repo' }), null);
  assert.equal(federationAccess({ ...base, root: '/srv/app' }), null);
  assert.equal(federationAccess({ ...base, root: '/srv/app', workspaceRoot: null }), null);
  const outside = federationAccess({ ...base, root: '/tmp/evil' });
  assert.match(outside.message, /outside the server workspace/);
  const unnamed = federationAccess({ ...base, root: '/srv/ws/repo', serverNames: ['evil'] });
  assert.match(unnamed.message, /not named in the user config/);
  assert.ok(unnamed.remedy.includes(base.configPath));
  assert.equal(federationAccess({ ...base, root: '/srv/ws/repo', userConfig: { federation: { allow: true } }, serverNames: ['anything'] }), null);
});

test('the federation tool says so when the repository declared nothing', async (t) => {
  const root = await fixture(undefined);
  t.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(() => federationTool().run({ root, query: 'anything' }), (error) => {
    assert.match(error.message, /declares no federation server/);
    assert.match(error.remedy, /simt\.json/);
    return true;
  });
});

test('the federation tool asks only the server it was named', async (t) => {
  const root = await fixture({ servers: [answeringEntry()] });
  t.after(() => rm(root, { recursive: true, force: true }));

  const answer = await withOperator(root, { servers: ['fixture-graph'] }, () =>
    federationTool().run({ root, query: 'keep', server: 'fixture-graph' }));
  assert.deepEqual(answer.servers, ['fixture-graph']);

  await assert.rejects(() => federationTool().run({ root, query: 'keep', server: 'absent' }), (error) => {
    assert.match(error.message, /no declared federation server is named absent/);
    assert.match(error.remedy, /fixture-graph/);
    return true;
  });
});

/** A server that refuses `initialize`: the client must report that, not the tool call after it. */
const REFUSING_SERVER = `
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let index = buffer.indexOf('\\n');
  while (index !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf('\\n');
    if (line.length === 0) continue;
    const message = JSON.parse(line);
    if (message.id === undefined) continue;
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'unsupported protocol version' } }) + '\\n');
  }
});
`;

/** A server whose answer is far longer than a packet line can hold. */
const VERBOSE_SERVER = `
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let index = buffer.indexOf('\\n');
  while (index !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf('\\n');
    if (line.length === 0) continue;
    const message = JSON.parse(line);
    if (message.id === undefined) continue;
    const text = message.method === 'tools/call' ? 'a'.repeat(5000) : { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'verbose', version: '1' } };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: typeof text === 'string' ? { content: [{ type: 'text', text }] } : text }) + '\\n');
  }
});
`;

/** A server that forks a helper of its own and then never answers. */
const FORKING_SERVER = `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
writeFileSync('helper.pid', String(helper.pid));
process.stdin.resume();
`;

test('a server that refuses initialize is reported, not asked again (Q84)', async (t) => {
  const root = await fixture({ servers: [{ name: 'refusing', command: process.execPath, args: ['refusing.mjs'], timeoutMs: 2000 }] });
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'refusing.mjs'), REFUSING_SERVER);

  const { code, stdout } = await run(root, ['brief', 'fix the keep helper']);
  assert.equal(code, 0);
  assert.match(stdout, /federation: the .refusing. server did not answer/);
  assert.match(stdout, /refused .initialize./);
  assert.match(stdout, /unsupported protocol version/);
});

test('an oversized answer is capped, with the cut named (Q84)', async (t) => {
  const root = await fixture(undefined);
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'verbose.mjs'), VERBOSE_SERVER);

  // Straight at the client. Through the brief, the packet's own 2048-character budget cuts
  // the whole section first, which says nothing about whether the cap works.
  const answer = await callTool({
    command: process.execPath,
    args: ['verbose.mjs'],
    cwd: root,
    tool: 'query',
    query: 'anything',
    timeoutMs: DEFAULT_TIMEOUT_MS,
  });
  assert.match(answer.text, /^a{600}\.\.\. \(4400 more characters\)$/);
});

test('a server that forked a helper does not leave it running (Q84)', async (t) => {
  const root = await fixture({ servers: [{ name: 'forking', command: process.execPath, args: ['forking.mjs'], timeoutMs: 500 }] });
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'forking.mjs'), FORKING_SERVER);

  const { code, stdout } = await run(root, ['brief', 'fix the keep helper']);
  assert.equal(code, 0);
  assert.match(stdout, /federation: the .forking. server did not answer/);

  const helperPid = Number(await readFile(join(root, 'helper.pid'), 'utf8'));
  assert.ok(Number.isInteger(helperPid) && helperPid > 0, 'the fixture server did not report its helper');
  let alive = true;
  for (let attempt = 0; attempt < 40 && alive; attempt += 1) {
    try {
      process.kill(helperPid, 0);
    } catch {
      alive = false;
      break;
    }
    await new Promise((wait) => setTimeout(wait, 50));
  }
  if (alive) {
    try {
      process.kill(helperPid, 'SIGKILL');
    } catch {
      // Nothing to clean up if it exited between the check and the kill.
    }
  }
  assert.equal(alive, false, `the server's helper ${helperPid} outlived the brief`);
});
