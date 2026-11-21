// ST01: the studio socket is loopback-only, token-guarded and read-only (ADR-212).
//
// The server is a long-running child, so these tests spawn the binary and speak HTTP
// to it rather than using the fixture's wait-for-exit runner. Host-header refusal is
// asserted with raw node:http requests, because fetch derives Host from the URL and
// cannot present the foreign name the defense exists for.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { BIN, git, simt, tempDir } from './fixture.mjs';

const URL_LINE = /open (http:\/\/127\.0\.0\.1:(\d+)\/\?token=(\S+))/;

function httpReq(port, { path = '/', method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function startStudio(cwd, extra = []) {
  const args = ['studio', '--no-open', ...(extra.includes('--port') ? [] : ['--port', '0']), ...extra];
  const child = spawn(process.execPath, [BIN, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const started = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`studio did not start: ${out} ${err}`)), 10000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`studio exited ${code} before printing a URL: ${out} ${err}`));
    });
    const poll = setInterval(() => {
      const m = out.match(URL_LINE);
      if (m) {
        clearTimeout(timer);
        clearInterval(poll);
        resolve({ url: m[1], port: Number(m[2]), token: m[3] });
      }
    }, 25);
  });
  const stop = async () => {
    if (child.exitCode !== null) return child.exitCode;
    child.kill('SIGINT');
    return new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(-1); }, 5000);
      child.on('exit', (code) => { clearTimeout(timer); resolve(code); });
    });
  };
  return { child, stop, ...started, base: `http://127.0.0.1:${started.port}` };
}

/** Exchange the one-time token for the session cookie, the way the first page load does. */
async function session(studio) {
  const res = await httpReq(studio.port, { path: `/?token=${studio.token}` });
  assert.equal(res.status, 303);
  return res.headers['set-cookie'][0].split(';')[0];
}

async function fixtureRepo() {
  const root = await tempDir('simt-studio-');
  await writeFile(join(root, 'README.md'), '# studio fixture\n');
  await git(['init', '-q'], { cwd: root });
  await git(['add', 'README.md'], { cwd: root });
  await git(['commit', '-qm', 'fixture'], { cwd: root });
  return root;
}

async function treeDigest(root) {
  const out = [];
  const walk = async (dir, rel) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const name = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path, name);
      else out.push(`${name} ${createHash('sha256').update(await readFile(path)).digest('hex')}`);
    }
  };
  await walk(root, '');
  return out.sort().join('\n');
}

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
  assert.match(run.stderr + run.stdout, /--host/);
});

test('a port outside 0..65535 is a usage error', async () => {
  const root = await fixtureRepo();
  for (const value of ['abc', '70000', '-1']) {
    const run = await simt(['studio', '--port', value, '--no-open'], { cwd: root });
    assert.equal(run.code, 2, `--port ${value}`);
    assert.match(run.stderr + run.stdout, /--port/);
  }
});

test('a taken port refuses with a remedy naming --port', async (t) => {
  const root = await fixtureRepo();
  const studio = await startStudio(root);
  t.after(() => studio.stop());
  const run = await simt(['studio', '--port', String(studio.port), '--no-open'], { cwd: root });
  assert.equal(run.code, 1);
  assert.match(run.stderr + run.stdout, /--port/);
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