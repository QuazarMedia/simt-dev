// simt-dev mcp - the line protocol.
//
// `handle()` is pure, so most of this file tests it without a pipe. The end-to-end test at
// the end exists because the failure nobody catches otherwise is a stray byte of prose on
// stdout: the client then shows nothing and reports no error, because from its side the
// stream is simply malformed.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { handle, PROTOCOL_VERSION, RPC } from '../src/mcp/server.mjs';
import { TOOLS, toolNames } from '../src/mcp/tools.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, '..', 'bin', 'simt-dev.mjs');
const exec = promisify(execFile);

const req = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, params });

// --- protocol ------------------------------------------------------------------

test('mcp: initialize answers with the protocol version and the read-only instruction', async () => {
  const r = await handle(req('initialize', { protocolVersion: PROTOCOL_VERSION }), TOOLS, { version: '9.9.9' });
  assert.equal(r.result.protocolVersion, PROTOCOL_VERSION);
  assert.equal(r.result.serverInfo.version, '9.9.9');
  assert.match(r.result.instructions, /Read-only/);
});

test('mcp: an unsupported protocol version gets ours, not an echo of theirs', async () => {
  // Echoing a version we do not implement is a lie the client cannot detect until a
  // feature silently misbehaves.
  const r = await handle(req('initialize', { protocolVersion: '1999-01-01' }), TOOLS);
  assert.equal(r.result.protocolVersion, PROTOCOL_VERSION);
});

test('mcp: a notification produces no response at all', async () => {
  // Not an empty object, not a null id: no response.
  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }, TOOLS), null);
  // A request with no id is a notification by the spec's own definition, whatever its method.
  assert.equal(await handle({ jsonrpc: '2.0', method: 'ping' }, TOOLS), null);
});

test('mcp: an unknown method is a protocol error, not silence', async () => {
  const r = await handle(req('resources/list'), TOOLS);
  assert.equal(r.error.code, RPC.METHOD);
  assert.match(r.error.message, /unknown method "resources\/list"/);
});

test('mcp: a malformed request is a request error', async () => {
  for (const bad of [null, 'string', [], { jsonrpc: '2.0', id: 1 }]) {
    const r = await handle(bad, TOOLS);
    assert.equal(r.error.code, RPC.REQUEST, `expected a request error for ${JSON.stringify(bad)}`);
  }
});

test('mcp: an unknown tool is a method error naming the way to discover it', async () => {
  const r = await handle(req('tools/call', { name: 'nope', arguments: {} }), TOOLS);
  assert.equal(r.error.code, RPC.METHOD);
  assert.match(r.error.message, /tools\/list/);
});

test('mcp: a tool that fails is a RESULT with isError, never a protocol error', async () => {
  // An MCP client renders an exception as an error dialog and never shows the answer.
  // "this repo has no region" is an answer, and the useful part of it.
  const tools = [
    {
      name: 'boom',
      description: 'always fails',
      inputSchema: { type: 'object' },
      async run() {
        throw Object.assign(new Error('no region'), { remedy: 'run: simt-dev sync' });
      },
    },
  ];
  const r = await handle(req('tools/call', { name: 'boom', arguments: {} }), tools);
  assert.equal(r.error, undefined);
  assert.equal(r.result.isError, true);
  const payload = JSON.parse(r.result.content[0].text);
  assert.equal(payload.error, 'no region');
  assert.equal(payload.remedy, 'run: simt-dev sync');
});

test('mcp: truncation is announced in the text, never silent', async () => {
  const tools = [{ name: 'big', description: 'x', inputSchema: { type: 'object' }, async run() { return { blob: 'y'.repeat(500), maxBytes: 100 }; } }];
  const r = await handle(req('tools/call', { name: 'big', arguments: {} }), tools);
  assert.match(r.result.content[0].text, /^TRUNCATED \d+ bytes omitted; raise maxBytes$/m);
});

test('mcp: every tool declares a usable schema', () => {
  for (const tool of TOOLS) {
    assert.match(tool.name, /^[a-z][a-z_]*$/, `${tool.name} is not a snake_case tool name`);
    assert.ok(tool.description.length > 40, `${tool.name} needs a description worth reading`);
    assert.equal(tool.inputSchema.type, 'object');
    assert.ok(Array.isArray(tool.inputSchema.required));
    assert.equal(typeof tool.run, 'function');
  }
});

test('mcp: skills_brief and `skills brief` answer the same question identically', async () => {
  // The row's headline: the budget arithmetic was written twice and the copies had
  // already drifted. This one checked `deferred` *after* the budget and inlined a
  // deferred dependency; `skills brief` checked it first and did not. A caller reaching
  // for the tool and a caller reaching for the command got different answers, and
  // neither could see the other.
  //
  // Both sides run the same resolver over the same registry at the same budget, and the
  // answer is compared skill for skill. Two budgets, because one of them proves the
  // budget is doing something: 2,000 for a group of 13,503 and 20,000 for the same one.
  const brief = TOOLS.find((t) => t.name === 'skills_brief');
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

  for (const budget of [2000, 20000]) {
    const mcp = await brief.run({ budget, skill: 'parallel-feature-team', root: ROOT });
    const { stdout } = await exec('node', [
      resolve(ROOT, 'bin', 'simt-dev.mjs'),
      'skills', 'brief', '--root', ROOT, '--skill', 'parallel-feature-team',
      '--budget', String(budget), '--json',
    ]);
    const cli = JSON.parse(stdout);

    assert.deepEqual(
      mcp.selected.map((s) => s.name),
      cli.resolved.map((r) => r.name),
      `budget ${budget}: the two surfaces selected different skills`,
    );
    assert.deepEqual(
      mcp.deferred.map((s) => s.name),
      cli.deferred.map((d) => d.name),
      `budget ${budget}: the two surfaces deferred different skills`,
    );
    assert.equal(
      mcp.inlineBytes,
      cli.resolved.reduce((n, r) => n + r.bytes, 0),
      `budget ${budget}: the two surfaces report different bytes`,
    );
    // And the budget is real in both, which is the property the two copies used to share
    // only by accident.
    assert.ok(mcp.inlineBytes <= budget, `${mcp.inlineBytes} bytes against a ${budget}-byte budget`);
  }
});

test('mcp: no mutating command is exposed as a tool', () => {
  // The load-bearing invariant of this file. Each of these writes, and each is meant to be
  // read as a diff by a human first (ADR-001, ADR-004). A model can call a tool; a model
  // cannot review a diff it never showed you.
  const FORBIDDEN = ['init', 'sync', 'upgrade', 'install', 'write', 'apply', 'commit', 'push', 'edit', 'create'];
  for (const name of toolNames()) {
    for (const banned of FORBIDDEN) {
      assert.ok(!name.includes(banned), `${name} looks mutating ("${banned}"); read-only surface only`);
    }
  }
});

test('mcp: every command that writes is reachable only from the CLI', async () => {
  const { stdout } = await exec('node', [BIN, 'mcp', '--list', '--json']);
  const { tools } = JSON.parse(stdout);
  const names = tools.map((t) => t.name);
  for (const mutating of ['init', 'sync', 'upgrade', 'skills install', 'hooks install']) {
    assert.ok(!names.includes(mutating), `${mutating} is exposed over MCP`);
  }
  assert.ok(names.includes('check') && names.includes('compare'), 'the read commands must be exposed');
});

// --- end to end over a real pipe ------------------------------------------------

/**
 * Feed lines to `simt-dev mcp` and collect the session.
 *
 * `spawn` rather than `execFile` with an `input` option, because there is no such option:
 * the child's stdin would never be closed, the server would wait forever for EOF, and the
 * test would hang rather than fail. Ending stdin explicitly is what makes EOF arrive.
 */
function converse(raw) {
  return new Promise((res, rej) => {
    const child = spawn('node', [BIN, 'mcp']);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', rej);
    child.on('close', () => res({ stdout, stderr }));
    child.stdin.end(raw);
  });
}

test('mcp: a real session answers on the protocol channel and nothing else', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'simt-mcp-'));
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'requirements.txt'), 'flask\n');
  await writeFile(join(dir, 'pyproject.toml'), '[project]\nname = "x"\n');
  await writeFile(join(dir, 'src', 'main.py'), 'x = 1\n');

  const { stdout, stderr } = await converse(
    [
      req('initialize', { protocolVersion: PROTOCOL_VERSION }, 1),
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      req('tools/list', {}, 2),
      req('tools/call', { name: 'doctor', arguments: { root: dir } }, 3),
      req('tools/call', { name: 'check', arguments: { root: dir } }, 4),
      req('tools/call', { name: 'rules_list', arguments: { root: dir } }, 5),
    ].map((l) => JSON.stringify(l)).join('\n') + '\n',
  );
  // Every line parsed as JSON, so stdout carried no prose. This is the assertion that
  // catches a stray note() or emit() in the transport.
  const messages = stdout.trim() === '' ? [] : stdout.trim().split('\n').map((l) => JSON.parse(l));

  assert.equal(messages.length, 5, 'the notification must not produce a response');
  assert.deepEqual(messages.map((m) => m.id), [1, 2, 3, 4, 5], 'responses must be in request order');
  assert.equal(stderr, '', 'diagnostics belong on stderr, and there should be none here');

  assert.equal(messages[1].result.tools.length, TOOLS.length);

  const doctor = JSON.parse(messages[2].result.content[0].text);
  assert.ok(doctor.stack.includes('python'), 'doctor must classify the fixture repo');
  assert.ok(Object.prototype.hasOwnProperty.call(doctor.facts, 'has-pyproject'));

  // check on an unadopted repo: a successful call whose answer says unmanaged.
  assert.equal(messages[3].result.isError, false);
  const check = JSON.parse(messages[3].result.content[0].text);
  assert.equal(check.ok, false);
  assert.equal(check.findings[0].status, 'absent');

  const rules = JSON.parse(messages[4].result.content[0].text);
  assert.ok(rules.rules.some((r) => r.id === 'python' && r.selected));
  assert.ok(rules.rules.every((r) => Array.isArray(r.adrs)));
});

test('mcp: rules_why answers both directions, over a real session', async () => {
  // review 0001 S05: `rules_why` destructured `{ rules }` from `loadRules`, which returns
  // an ARRAY. Every call died on the first `.filter`, for every argument shape - a P0 that
  // stayed open because this file exercised only 3 of the 10 tools, and not this one.
  // Driven over the protocol rather than through `run()` because the crash was reachable
  // from a real editor: an isError result that looks like a broken server.
  const { stdout, stderr } = await converse(
    [
      req('initialize', { protocolVersion: PROTOCOL_VERSION }, 1),
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      // by decision: which rules rest on it
      req('tools/call', { name: 'rules_why', arguments: { what: 'ADR-006' } }, 2),
      // by rule: which decisions settle it
      req('tools/call', { name: 'rules_why', arguments: { what: 'python' } }, 3),
      // a rule citing no decision reports that, rather than an empty answer
      req('tools/call', { name: 'rules_why', arguments: { what: 'container' } }, 4),
      // and a name that exists nowhere is an error naming the way to find the real ones
      req('tools/call', { name: 'rules_why', arguments: { what: 'nope' } }, 5),
      req('tools/call', { name: 'rules_why', arguments: { what: 'ADR-999' } }, 6),
    ].map((l) => JSON.stringify(l)).join('\n') + '\n',
  );
  assert.equal(stderr, '', 'diagnostics belong on stderr, and there should be none here');
  const messages = stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(messages.map((m) => m.id), [1, 2, 3, 4, 5, 6], 'every request must be answered');

  // A thrown Error becomes isError with `remedy: null`. Asserting isError false on all
  // three real lookups is the assertion that would have caught S05: the crash arrived as
  // isError, not as a hang or an empty payload, so only an explicit check finds it.
  for (const id of [2, 3, 4]) {
    assert.equal(messages[id - 1].result.isError, false, `request ${id} failed: ${messages[id - 1].result.content[0].text}`);
  }

  const byDecision = JSON.parse(messages[1].result.content[0].text);
  assert.equal(byDecision.direction, 'decision');
  assert.equal(byDecision.id, 'ADR-006');
  assert.ok(byDecision.rules.includes('core'), 'ADR-006 is cited by core');
  // The record ships inside the package, so the answer must not hand back a path that
  // resolves against the consuming repo.
  assert.equal(byDecision.readWith, 'simt-dev rules why ADR-006');

  const byRule = JSON.parse(messages[2].result.content[0].text);
  assert.equal(byRule.direction, 'rule');
  assert.equal(byRule.id, 'python');
  assert.equal(byRule.uncited, false);
  assert.deepEqual(byRule.decisions.map((d) => d.id), ['ADR-006']);
  assert.ok(byRule.decisions.every((d) => d.missing === undefined), 'every citation must resolve to a record');

  const uncited = JSON.parse(messages[3].result.content[0].text);
  assert.equal(uncited.uncited, true, 'a rule citing no decision reports that, not silence');

  for (const [index, wanted] of [[4, /no rule with id/], [5, /no decision record ADR-999/]]) {
    assert.equal(messages[index].result.isError, true, `request ${index + 1} should be an error`);
    const payload = JSON.parse(messages[index].result.content[0].text);
    assert.match(payload.error, wanted);
  }
});

test('mcp: invalid JSON is answered, and the session continues', async () => {
  // A parse error must not end the session; a client that sends one bad line should get
  // an error for that line and keep working.
  const { stdout } = await converse('not json\n{"jsonrpc":"2.0","id":9,"method":"ping"}\n');
  const messages = stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(messages[0].error.code, RPC.PARSE);
  assert.deepEqual(messages[1].result, {});
});

test('mcp: --list answers without reading stdin', async () => {
  // An editor that has misconfigured the command has to be able to ask what it exposes
  // without hanging on a pipe nobody is writing to.
  const { stdout } = await exec('node', [BIN, 'mcp', '--list'], { input: '' });
  assert.match(stdout, /read-only tools/);
  assert.match(stdout, /No tool here writes/);
});