// ST01: the studio socket is loopback-only, token-guarded and read-only (ADR-212).
//
// The spawn/HTTP harness lives in studio-fixture.mjs, shared with the API parity tests.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { BIN, simt, tempDir } from './fixture.mjs';
import { fixtureRepo, httpReq, session, startStudio, treeDigest } from './studio-fixture.mjs';

test('studio serves the shell on loopback after a one-shot token exchange', async (t) => {
  const root = await fixtureRepo();
  const studio = await startStudio(root);
  t.after(() => studio.stop());
  assert.match(studio.url, /^http:\/\/127\.0\.0\.1:\d+\/\?token=/);

  const anonymous = await httpReq(studio.port);
  assert.equal(anonymous.status, 401);
  const refusal = JSON.parse(anonymous.body);
  assert.equal(refusal.ok, false);
  assert.ok(refusal.error && refusal.remedy);

  const exchange = await httpReq(studio.port, { path: `/?token=${studio.token}` });
  assert.equal(exchange.status, 303);
  assert.equal(exchange.headers.location, '/');
  const cookie = exchange.headers['set-cookie'][0];
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);

  const shell = await httpReq(studio.port, { headers: { cookie: cookie.split(';')[0] } });
  assert.equal(shell.status, 200);
  assert.match(shell.body, /simt studio/);
  const css = await httpReq(studio.port, { path: '/shell.css', headers: { cookie: cookie.split(';')[0] } });
  assert.equal(css.status, 200);
  assert.match(css.headers['content-type'], /text\/css/);
});

test('a replayed, wrong or off-route token query is refused', async (t) => {
  const studio = await startStudio(await fixtureRepo());
  t.after(() => studio.stop());
  await session(studio);
  const replay = await httpReq(studio.port, { path: `/?token=${studio.token}` });
  assert.equal(replay.status, 403);
  const wrong = await httpReq(studio.port, { path: '/?token=not-the-token' });
  assert.equal(wrong.status, 403);
  const offRoute = await httpReq(studio.port, { path: `/shell.css?token=${studio.token}` });
  assert.equal(offRoute.status, 403);
});

test('a foreign Host or Origin header is refused', async (t) => {
  const studio = await startStudio(await fixtureRepo());
  t.after(() => studio.stop());
  const cookie = await session(studio);
  const host = await httpReq(studio.port, { headers: { host: 'evil.example', cookie } });
  assert.equal(host.status, 403);
  assert.equal(JSON.parse(host.body).error, 'STUDIO_FOREIGN_HOST');
  const origin = await httpReq(studio.port, { headers: { origin: 'http://evil.example', cookie } });
  assert.equal(origin.status, 403);
  assert.equal(JSON.parse(origin.body).error, 'STUDIO_FOREIGN_ORIGIN');
  const localhost = await httpReq(studio.port, { headers: { host: `localhost:${studio.port}`, cookie } });
  assert.equal(localhost.status, 200);
});

test('the CSP and nosniff ride on every response, and no CORS header is sent', async (t) => {
  const studio = await startStudio(await fixtureRepo());
  t.after(() => studio.stop());
  const cookie = await session(studio);
  for (const res of [
    await httpReq(studio.port),
    await httpReq(studio.port, { headers: { cookie } }),
  ]) {
    assert.match(res.headers['content-security-policy'], /default-src 'self'/);
    assert.match(res.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['access-control-allow-origin'], undefined);
  }
});

test('unknown routes and write methods are refused in the doors\' shape', async (t) => {
  const studio = await startStudio(await fixtureRepo());
  t.after(() => studio.stop());
  const cookie = await session(studio);
  const missing = await httpReq(studio.port, { path: '/api/not-yet', headers: { cookie } });
  assert.equal(missing.status, 404);
  assert.equal(JSON.parse(missing.body).ok, false);
  const write = await httpReq(studio.port, { method: 'POST', headers: { cookie } });
  assert.equal(write.status, 405);
  assert.equal(JSON.parse(write.body).ok, false);
});

test('SIGINT closes the socket and leaves the repository byte-identical', async (t) => {
  const root = await fixtureRepo();
  const before = await treeDigest(root);
  const studio = await startStudio(root);
  const cookie = await session(studio);
  await httpReq(studio.port, { headers: { cookie } });
  const code = await studio.stop();
  assert.equal(code, 0);
  await assert.rejects(() => httpReq(studio.port), /ECONNREFUSED/);
  assert.equal(await treeDigest(root), before);
});

test('an unconfigured directory is served, not refused', async (t) => {
  const root = await tempDir('simt-studio-bare-');
  await writeFile(join(root, 'notes.txt'), 'no manifest here\n');
  const studio = await startStudio(root);
  t.after(() => studio.stop());
  const cookie = await session(studio);
  const shell = await httpReq(studio.port, { headers: { cookie } });
  assert.equal(shell.status, 200);
});

test('no flag binds a non-loopback address', async () => {
  const root = await fixtureRepo();
  const run = await simt(['studio', '--host', '0.0.0.0', '--no-open'], { cwd: root });
  assert.equal(run.code, 2);
  const output = run.stderr + run.stdout;
  assert.ok(output.includes('unknown flag --host'), output);
});

test('a port outside 0..65535 is a usage error', async () => {
  const root = await fixtureRepo();
  for (const value of ['abc', '70000', '-1']) {
    const run = await simt(['studio', '--port', value, '--no-open'], { cwd: root });
    assert.equal(run.code, 2, `--port ${value}`);
    const output = run.stderr + run.stdout;
    assert.ok(output.includes(`--port must be an integer from 0 to 65535, received ${value}`), output);
  }
});

test('a taken port refuses with a remedy naming --port', async (t) => {
  const root = await fixtureRepo();
  const studio = await startStudio(root);
  t.after(() => studio.stop());
  const run = await simt(['studio', '--port', String(studio.port), '--no-open'], { cwd: root });
  assert.equal(run.code, 1);
  const output = run.stderr + run.stdout;
  assert.ok(output.includes(`port ${studio.port} is already serving`), output);
});

test('a named free port is the port served', async (t) => {
  const root = await fixtureRepo();
  const first = await startStudio(root);
  const port = first.port;
  await first.stop();
  const second = await startStudio(root, ['--port', String(port)]);
  t.after(() => second.stop());
  assert.equal(second.port, port);
});

test('--json reports the URL and port in the envelope when the studio stops', async () => {
  const root = await fixtureRepo();
  const child = spawn(process.execPath, [BIN, 'studio', '--json', '--no-open', '--port', '0'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  // The envelope contract: a document names its exit code, so it is written when the
  // command returns. Give the socket a moment to bind, then stop it and read the answer.
  await new Promise((resolve) => setTimeout(resolve, 500));
  child.kill('SIGINT');
  const code = await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(code, 0);
  const docs = out.trim().split('\n').map((line) => JSON.parse(line));
  const doc = docs.find((d) => typeof d.url === 'string');
  assert.ok(doc, `no start document in: ${out}`);
  assert.match(doc.url, /^http:\/\/127\.0\.0\.1:\d+\/\?token=/);
  assert.equal(typeof doc.port, 'number');
});

test('help and the rendered page name only shipped flags', async () => {
  const run = await simt(['studio', '--help']);
  assert.equal(run.code, 0);
  assert.match(run.stdout, /--port/);
  assert.match(run.stdout, /--open/);
  assert.doesNotMatch(run.stdout, /--host/);
  const page = await readFile(new URL('../docs/commands/studio.md', import.meta.url), 'utf8');
  assert.match(page, /--port/);
  assert.match(page, /--open/);
  assert.doesNotMatch(page, /--host/);
});