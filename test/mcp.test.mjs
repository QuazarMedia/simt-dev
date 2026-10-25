// simt mcp - the line protocol.
//
// `handle()` is pure, so most of this file tests it without a pipe. The end-to-end test at
// the end exists because the failure nobody catches otherwise is a stray byte of prose on
// stdout: the client then shows nothing and reports no error, because from its side the
// stream is simply malformed.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { handle, PROTOCOL_VERSION, RPC, SUPPORTED_VERSIONS, META } from '../src/mcp/server.mjs';
import { TOOLS, toolNames, ERROR_SHAPE } from '../src/mcp/tools.mjs';
import { assertValid } from '../src/mcp/schema.mjs';
import { CLI } from '../src/name.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, '..', 'bin', 'simt.mjs');
const exec = promisify(execFile);

const req = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, params });

// --- protocol ------------------------------------------------------------------

test('mcp: initialize answers with the protocol version and the read-only instruction', async () => {
  const r = await handle(req('initialize', { protocolVersion: PROTOCOL_VERSION }), TOOLS, { packageVersion: '9.9.9' });
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

// --- the version matrix -------------------------------------------------------

/** A request that identifies its revision the way that revision does it. */
const at = (version, method, params = {}, id = 1) =>
  req(method, { ...params, _meta: { [META.PROTOCOL_VERSION]: version } }, id);

test('mcp: every supported revision completes a handshake', async () => {
  // The review's acceptance criterion, one revision at a time. A revision that only
  // works when nobody asks for it is a revision this server does not speak.
  for (const version of SUPPORTED_VERSIONS) {
    const legacy = await handle(req('initialize', { protocolVersion: version }), TOOLS, { packageVersion: '1.2.3' });
    assert.equal(legacy.result.protocolVersion, version, `initialize did not hold ${version}`);
    assert.equal(legacy.result.serverInfo.version, '1.2.3');
    assert.ok(legacy.result.capabilities.tools, `${version}: no tools capability`);

    const list = await handle(at(version, 'tools/list'), TOOLS);
    assert.ok(Array.isArray(list.result.tools), `${version}: tools/list did not answer`);
    assert.ok(list.result.tools.length > 0, `${version}: an empty tool list is not a handshake`);
  }
});

test('mcp: 2026-07-28 is stateless, so a per-request _meta replaces the handshake', async () => {
  // Two consecutive requests at different revisions, with no initialize between them. A
  // server that remembered the first would answer the second with the wrong shape.
  const newest = await handle(at('2026-07-28', 'tools/list'), TOOLS);
  assert.equal(newest.result.resultType, 'complete');
  assert.equal(newest.result._meta[META.SERVER_INFO].name, 'simt-dev');

  const oldest = await handle(at('2025-06-18', 'tools/list'), TOOLS);
  assert.ok(!('resultType' in oldest.result), 'a 2025-06-18 client asked for a pre-2026-07-28 result');
  assert.ok(!('_meta' in oldest.result));
});

test('mcp: a per-request version this server does not speak is refused, by name', async () => {
  // `initialize` answers with its own version because the spec tells it to. A request
  // that names its version in _meta has no fallback left - there is no handshake to
  // renegotiate - so an unsupported one is an error at the one place the client checks.
  const r = await handle(at('2027-01-01', 'tools/list'), TOOLS);
  assert.equal(r.error.code, RPC.UNSUPPORTED_VERSION);
  assert.match(r.error.message, /2027-01-01/);
  for (const v of SUPPORTED_VERSIONS) assert.match(r.error.message, new RegExp(v));
});

test('mcp: an older client keeps the revision it negotiated, without being asked again', async () => {
  // The residue of the removed handshake, and the reason `serve` holds state at all: a
  // 2025-06-18 client negotiates once and then sends bare requests forever after.
  const state = { version: null };
  await handle(req('initialize', { protocolVersion: '2025-06-18' }), TOOLS, { state });
  assert.equal(state.version, '2025-06-18');
  const later = await handle(req('tools/list'), TOOLS, { state });
  assert.ok(!('resultType' in later.result), 'a bare request inherited the newest revision');
});

test('mcp: server/discover advertises the revisions, the capabilities and the identity', async () => {
  // MUST from 2026-07-28, and the stdio way a client finds out which shape it is talking
  // to before committing to one.
  const r = await handle(at('2026-07-28', 'server/discover'), TOOLS, { packageVersion: '1.2.3' });
  assert.deepEqual(r.result.supportedVersions, SUPPORTED_VERSIONS);
  assert.equal(r.result._meta[META.SERVER_INFO].version, '1.2.3');
  assert.ok(r.result.capabilities.tools);
  assert.match(r.result.instructions, /Read-only/);
});

test('mcp: list results carry a cache lifetime from 2026-07-28 and nothing before it', async () => {
  for (const version of ['2026-07-28']) {
    for (const method of ['tools/list', 'server/discover']) {
      const r = await handle(at(version, method), TOOLS);
      assert.ok(Number.isInteger(r.result.ttlMs), `${method} at ${version} has no ttlMs`);
      assert.ok(['public', 'private'].includes(r.result.cacheScope), `${method} at ${version}`);
    }
  }
  const older = await handle(at('2025-11-25', 'tools/list'), TOOLS);
  assert.ok(!('ttlMs' in older.result), 'a field the revision does not define was invented for it');
});

test('mcp: ping answers an older client and is refused to a 2026-07-28 one', async () => {
  for (const version of ['2025-06-18', '2025-11-25']) {
    assert.equal((await handle(at(version, 'ping'), TOOLS)).result.resultType, undefined, version);
  }
  // Removed in 2026-07-28, so a client that still sends it is told that, rather than
  // getting a success it would read as support.
  const gone = await handle(at('2026-07-28', 'ping'), TOOLS);
  assert.equal(gone.error.code, RPC.METHOD);
  assert.match(gone.error.message, /removed in 2026-07-28/);
});

test('mcp: a notification produces no response at all', async () => {
  // Not an empty object, not a null id: no response.
  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }, TOOLS), null);
  // A request with no id is a notification by the spec's own definition, whatever its method.
  assert.equal(await handle({ jsonrpc: '2.0', method: 'ping' }, TOOLS), null);
});

test('mcp: an unknown method is a protocol error, not silence', async () => {
  // Something this server has never heard of. It used to assert `resources/list` here,
  // which is the assertion that had to die when resources landed: a method this server
  // does not implement, not one it does.
  const r = await handle(req('resources/subscribe', { uri: 'simt://rules/core' }), TOOLS);
  assert.equal(r.error.code, RPC.METHOD);
  assert.match(r.error.message, /unknown method "resources\/subscribe"/);
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
        throw Object.assign(new Error('no region'), { remedy: `run: ${CLI} sync` });
      },
    },
  ];
  const r = await handle(req('tools/call', { name: 'boom', arguments: {} }), tools);
  assert.equal(r.error, undefined);
  assert.equal(r.result.isError, true);
  const payload = JSON.parse(r.result.content[0].text);
  assert.equal(payload.error, 'no region');
  assert.equal(payload.remedy, `run: ${CLI} sync`);
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
      resolve(ROOT, 'bin', 'simt.mjs'),
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

// --- resources ------------------------------------------------------------------
//
// Every rule and every decision record is readable over `simt://`. The interesting part
// is not that the URIs work — it is that each revision answers in its OWN shape, because
// the two specifications disagree about what a missing resource is. That is why these
// tests run the matrix rather than asserting one behaviour.

test('mcp: the resources capability is declared without subscriptions', async () => {
  const r = await handle(req('initialize'), TOOLS, { packageVersion: '9.9.9' });
  // The empty object says "resources, but nothing that changes". A server advertising
  // subscribe or listChanged here would be promising a stream it cannot produce.
  assert.deepEqual(r.result.capabilities.resources, {});
  assert.equal(r.result.capabilities.resources.subscribe, undefined);
  assert.equal(r.result.capabilities.resources.listChanged, undefined);
});

test('mcp: every revision lists rules and decisions', async () => {
  for (const version of SUPPORTED_VERSIONS) {
    const r = await handle(at(version, 'resources/list'), TOOLS);
    const { resources } = r.result;
    assert.ok(resources.length > 20, `${version} listed ${resources.length}`);
    // Sorted, so a client diffing two listings sees a change rather than a reshuffle.
    assert.deepEqual(resources.map((x) => x.uri), [...resources.map((x) => x.uri)].sort());
    for (const entry of resources) {
      assert.match(entry.uri, /^simt:\/\/(rules|decisions)\//);
      assert.ok(entry.name && entry.mimeType === 'text/markdown' && Number.isInteger(entry.size));
    }
    assert.ok(resources.some((x) => x.uri === 'simt://rules/core'));
    assert.ok(resources.some((x) => x.uri.startsWith('simt://decisions/')));
  }
});

test('mcp: only the newest revision carries the cache fields on a list', async () => {
  // 2026-07-28 requires ttlMs and cacheScope on results; the two older revisions have
  // no such field, so sending one is a payload a client of that revision cannot parse
  // against the schema it knows.
  const newest = await handle(at('2026-07-28', 'resources/list'), TOOLS);
  assert.ok(newest.result.ttlMs > 0 && newest.result.cacheScope === 'private');
  for (const version of ['2025-11-25', '2025-06-18']) {
    const older = await handle(at(version, 'resources/list'), TOOLS);
    assert.equal(older.result.ttlMs, undefined, `${version} must not receive ttlMs`);
    assert.equal(older.result.cacheScope, undefined, `${version} must not receive cacheScope`);
  }
});

test('mcp: templates are listed, and they name the two schemes', async () => {
  for (const version of SUPPORTED_VERSIONS) {
    const r = await handle(at(version, 'resources/templates/list'), TOOLS);
    const uris = r.result.resourceTemplates.map((t) => t.uriTemplate);
    assert.deepEqual(uris.sort(), ['simt://decisions/{adr}', 'simt://rules/{id}']);
  }
});

test('mcp: a rule is readable, with its frontmatter reconstructed', async () => {
  const r = await handle(at('2026-07-28', 'resources/read', { uri: 'simt://rules/core' }), TOOLS);
  const [content] = r.result.contents;
  assert.equal(content.uri, 'simt://rules/core');
  assert.equal(content.mimeType, 'text/markdown');
  // The file on disk has frontmatter; a resource has none, so it is rebuilt or the
  // reader loses the identity it just listed. The keys are unprefixed: `simt-` is this
  // tool's own namespace, and a resource is read by a client that knows nothing about it.
  assert.match(content.text, /^---\n/);
  assert.match(content.text, /^id: core$/m);
  assert.match(content.text, /^priority: hard$/m);
  // Not the H1: `loadRules` hands back a body that no longer carries it, and the
  // identity the H1 carried is in the frontmatter above.
  assert.match(content.text, /^title: Shared rules$/m);
  assert.match(content.text, /^## Truth$/m);
});

test('mcp: a decision record is readable and carries no estate name', async () => {
  const listed = await handle(at('2026-07-28', 'resources/list'), TOOLS);
  const first = listed.result.resources.find((x) => x.uri.startsWith('simt://decisions/'));
  const r = await handle(at('2026-07-28', 'resources/read', { uri: first.uri }), TOOLS);
  const [content] = r.result.contents;
  assert.equal(content.mimeType, 'text/markdown');
  assert.match(content.text, /^# ADR-\d{3} /m);
  assert.match(content.text, /^Status: /m);
  assert.doesNotMatch(content.text, /docs\/decisions\//, 'a reader outside this estate cannot resolve that path');
});

test('mcp: a missing resource is the error its revision specifies', async () => {
  // The whole reason this surface is versioned per revision: 2026-07-28 makes -32602
  // mandatory and keeps -32002 only for clients that already accept it, while
  // 2025-06-18 says the opposite.
  const newest = await handle(at('2026-07-28', 'resources/read', { uri: 'simt://rules/nope' }), TOOLS);
  assert.equal(newest.error.code, RPC.RESOURCE_NOT_FOUND);
  const oldest = await handle(at('2025-06-18', 'resources/read', { uri: 'simt://rules/nope' }), TOOLS);
  assert.equal(oldest.error.code, RPC.RESOURCE_NOT_FOUND_LEGACY);
  // Never an empty contents array: the newest specification forbids it precisely
  // because a client cannot tell it from a resource with no content.
  for (const version of SUPPORTED_VERSIONS) {
    const r = await handle(at(version, 'resources/read', { uri: 'simt://rules/nope' }), TOOLS);
    assert.ok(r.error, `${version} returned a result instead of an error`);
    assert.equal(r.result, undefined);
  }
});

test('mcp: a uri that is not ours, or tries to escape, is refused', async () => {
  // The specification requires a server to validate resource URIs and to sanitise paths
  // so a client cannot read outside what it listed.
  for (const uri of [
    'file:///etc/passwd',
    'simt://rules/../../etc/passwd',
    'simt://rules/',
    'simt://skills/build-system',
    'simt://rules/a/b',
    42,
    null,
  ]) {
    const r = await handle(at('2026-07-28', 'resources/read', { uri }), TOOLS);
    assert.ok(r.error, `refused to refuse ${JSON.stringify(uri)}`);
    assert.equal(r.error.code, RPC.RESOURCE_NOT_FOUND);
  }
});

// --- end to end over a real pipe ------------------------------------------------

/**
 * Feed lines to `simt mcp` and collect the session.
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
  assert.equal(byDecision.readWith, `${CLI} rules why ADR-006`);

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
  const { stdout } = await converse('not json\n{"jsonrpc":"2.0","id":9,"method":"server/discover"}\n');
  const messages = stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(messages[0].error.code, RPC.PARSE);
  // The session survived the bad line and answered the next request, which is the whole
  // claim. `server/discover` rather than `ping` because the default revision no longer
  // has the latter.
  assert.deepEqual(messages[1].result.supportedVersions, SUPPORTED_VERSIONS);
});

test('mcp: every tool answers, and every answer matches the schema it declared', async () => {
  // The review's second acceptance criterion, and the one that catches a payload that
  // grew a field nobody wrote down. Minimal arguments only (S20): a tool that cannot be
  // called with the least a client would send is a tool whose schema describes a call
  // no client makes.
  const state = { version: null };
  await handle(req('initialize', { protocolVersion: '2025-11-25' }), TOOLS, { state });

  // The arguments a client sends when it knows nothing: the required ones and nothing else.
  const minimal = {
    skills_brief: { task: 'write a test' },
    skills_show: { name: 'nonexistent-skill' },
    skills_why: { name: 'core' },
    skills_find: { query: 'test' },
    rules_why: { what: 'ADR-001' },
    plan_done: { id: 'no-such-slice' },
    federation_query: { query: 'what calls the keep helper' },
  };

  for (const tool of TOOLS) {
    const args = minimal[tool.name] ?? {};
    // The arguments must be the ones the schema requires and no more.
    for (const key of tool.inputSchema.required ?? []) {
      assert.ok(key in args, `${tool.name} needs "${key}", and this test cannot guess it`);
    }
    assert.ok(tool.outputSchema, `${tool.name} declares no outputSchema, so nothing can check its answer`);

    const r = await handle(req('tools/call', { name: tool.name, arguments: args }, 7), TOOLS, { state });
    assert.ok(r.result, `${tool.name} returned a protocol error: ${JSON.stringify(r.error)}`);
    assert.ok('structuredContent' in r.result, `${tool.name} returned text only`);
    // Both blocks describe one call. A client reading the text and a client reading the
    // structure must not be able to see two different answers.
    const text = JSON.parse(r.result.content[0].text.replace(/\\nTRUNCATED .*$/, ''));
    assert.deepEqual(text, r.result.structuredContent, `${tool.name}: text and structuredContent disagree`);

    if (r.result.isError) {
      assertValid(r.result.structuredContent, ERROR_SHAPE, `${tool.name} failure`);
      continue;
    }
    assertValid(r.result.structuredContent, tool.outputSchema, `${tool.name} success`);
  }
});

test('mcp: the annotations say what the tools are', async () => {
  // All ten are readers, and the declaration is per tool because the next tool may not
  // be one. A client that believes a tool is read-only will cache its answer.
  const state = { version: null };
  await handle(req('initialize', { protocolVersion: '2025-11-25' }), TOOLS, { state });
  const list = await handle(req('tools/list'), TOOLS, { state });
  for (const t of list.result.tools) {
    assert.equal(t.annotations?.readOnlyHint, true, `${t.name} does not declare itself read-only`);
    assert.equal(t.annotations?.idempotentHint, true, `${t.name} does not declare itself idempotent`);
  }
});

test('mcp: --list answers without reading stdin', async () => {
  // An editor that has misconfigured the command has to be able to ask what it exposes
  // without hanging on a pipe nobody is writing to.
  const { stdout } = await exec('node', [BIN, 'mcp', '--list'], { input: '' });
  assert.match(stdout, /read-only tools/);
  assert.match(stdout, /No tool here writes/);
});

test('mcp: brief reads the index and never builds one', async () => {
  // `brief` is the one tool every argument of which is optional, so the generic loop above
  // reaches it with `{}` and a root of the process's cwd. That is exactly how a read-only
  // tool can quietly write: the packet assembly builds an index when it finds none, and a
  // call would then leave a cache in whatever repository the editor happened to sit in.
  // The declaration and the behaviour have to agree, so this test warms a fixture by
  // hand and asserts that the cold call wrote nothing.
  const dir = await mkdtemp(join(tmpdir(), 'simt-brief-'));
  await writeFile(join(dir, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n');
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src', 'keep.mjs'), 'export function keep(value) { return value; }\n');
  await exec('git', ['init', '-q', dir]);
  await exec('git', ['-C', dir, 'add', '-A']);
  await exec('git', [
    '-C', dir,
    '-c', 'user.email=tests@simt.invalid',
    '-c', 'user.name=simt-dev tests',
    '-c', 'commit.gpgsign=false',
    'commit', '-qm', 'initial',
  ]);

  const state = { version: null };
  await handle(req('initialize', { protocolVersion: '2025-11-25' }), TOOLS, { state });
  const call = (id) => handle(req('tools/call', { name: 'brief', arguments: { root: dir, task: 'fix src/keep.mjs' } }, id), TOOLS, { state });

  const cold = await call(2);
  assert.equal(cold.result.isError, true, 'an index-less repository is a stated failure, not an empty packet');
  assertValid(cold.result.structuredContent, ERROR_SHAPE, 'brief failure');
  assert.match(cold.result.structuredContent.remedy, new RegExp(`${CLI} index`));
  await assert.rejects(
    access(join(dir, '.simt')),
    'brief built an index, which no tool here may do',
  );

  // Warm it the way a person would, then ask again.
  await exec('node', [BIN, 'index', '--root', dir]);

  const warm = await call(3);
  assert.equal(warm.result.isError, false, JSON.stringify(warm.result));
  const brief = TOOLS.find((t) => t.name === 'brief');
  assertValid(warm.result.structuredContent, brief.outputSchema, 'brief success');
  const packet = warm.result.structuredContent;
  assert.match(packet.text, /src\/keep\.mjs/, 'the packet names the file the task mentions');
  assert.ok(packet.bytes > 0 && packet.bytes <= 2048, `packet was ${packet.bytes} bytes`);
});