// ST01: the studio socket is loopback-only, token-guarded and read-only (ADR-212).
//
// The spawn/HTTP harness lives in studio-fixture.mjs, shared with the API parity tests.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { STUDIO_READ_ROUTES } from '../src/studio/server.mjs';
import { BIN, simt, tempDir } from './fixture.mjs';
import { fixtureRepo, httpReq, session, startStudio, treeDigest } from './studio-fixture.mjs';

const PLAN = `# fixture plan

## 3. Tracker

| ID | Slice | Depends on | State | SHA / evidence |
| --- | --- | --- | --- | --- |
| F01 | first | — | Queued | |
| F02 | second | F01 | Queued | |

### F01 — first

**Finding.** the first slice

### F02 — second

**Finding.** the second slice
`;

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

test('read routes stay inside the suite latency ceilings', async (t) => {
  const root = await fixtureRepo({
    'docs/plans/0001-fixture.md': PLAN,
    'session.jsonl': '{"type":"user","message":{"role":"user","content":"hi"}}\n',
  });
  const studio = await startStudio(root);
  t.after(() => studio.stop());
  const cookie = await session(studio);
  // The read ceiling sizes to the slowest qualifying host, not the authoring
  // machine (ADR-255): on an M4 Max development host, light routes spike to
  // 303.2 ms (`/api/helm?path=status`) under concurrent suite load, and the
  // evidence family settles at 446.7 ms (`/api/evidence/chains?claim=F01`)
  // under sustained full-suite load - the sustained regime runs ~1.5x hotter
  // than the partial one, and which route spikes is per-run - so the shared
  // ceiling absorbs the spike class (650 ms) rather than tiering each route
  // that happens to spike. The two routes whose own work is larger keep their
  // own ceilings, sized the same way: `/api/check` settles at 789.5 ms under
  // sustained full-suite load (superseding the 300 ms ADR-254 settled from a
  // 216.4 ms 2-vCPU CI measurement) and the multi-slot `/api/status` snapshot
  // at 779.8 ms - at parity on this host, so both take 1100.
  // ADR-255 supersedes the numbers in ADR-254 and ADR-228.
  const READ_CEILING = 650;
  const GATE_CEILING = 1100;
  const STATUS_CEILING = 1100;
  const routes = [
    '/', '/shell.css', '/app.js',
    '/api/status',
    '/api/tokens', '/api/tokens/session?session=session.jsonl',
    '/api/check',
    '/api/plan', '/api/plan/next', '/api/plan/next?id=F01', '/api/board',
    '/api/evidence', '/api/evidence/chains', '/api/evidence/chains?claim=F01',
    '/api/harness', '/api/helm', '/api/helm?path=status',
    '/api/knowledge/graph', '/api/knowledge/why?scope=x&id=y', '/api/knowledge/rank?query=fixture&scope=x',
    '/api/work', '/api/library', '/api/library/skill?name=nope',
    '/api/bench', '/api/bench/replay?input=nope.json', '/api/bench/calibrate?input=nope.json',
    '/api/control',
  ];
  const ceiling = (path) => {
    if (path === '/api/check') return GATE_CEILING;
    if (path === '/api/status') return STATUS_CEILING;
    return READ_CEILING;
  };
  const median = (times) => [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)];
  const measure = async (path) => {
    const times = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const started = performance.now();
      await httpReq(studio.port, { path, headers: { cookie } });
      times.push(performance.now() - started);
    }
    return median(times);
  };

  for (const path of routes) {
    // Warm the route once: the first request to a route may build a cache or load a module.
    await httpReq(studio.port, { path, headers: { cookie } });
    let ms = await measure(path);
    if (ms >= ceiling(path)) {
      // A transient machine load can push the median of three. One settled re-measure
      // separates a busy moment from a slow route; a persistent overage fails it too.
      await httpReq(studio.port, { path, headers: { cookie } });
      ms = await measure(path);
    }
    assert.ok(ms < ceiling(path), `${path} median ${ms.toFixed(1)} ms exceeds its ${ceiling(path)} ms suite ceiling`);
  }

  // Every read path in the server's inventory is in this set, so a new GET route cannot
  // arrive without a latency assertion. The SSE route has its own first-byte check below.
  const measured = new Set(routes.map((path) => new URL(path, 'http://studio').pathname));
  for (const route of STUDIO_READ_ROUTES) {
    if (route === '/api/events') continue;
    assert.ok(measured.has(route), `${route} is not covered by the read-route latency test`);
  }

  // SSE is a read that never finishes, so its latency is the time to first byte, not a
  // completed response. The stream is aborted after the directive arrives.
  const started = performance.now();
  const firstByte = await new Promise((resolve, reject) => {
    const stream = request({
      host: '127.0.0.1',
      port: studio.port,
      path: '/api/events',
      headers: { cookie, accept: 'text/event-stream' },
    }, (res) => {
      res.once('data', () => {
        const ms = performance.now() - started;
        stream.destroy();
        resolve({ status: res.statusCode, ms });
      });
    });
    stream.on('error', reject);
    stream.end();
  });
  assert.equal(firstByte.status, 200);
  assert.ok(firstByte.ms < READ_CEILING, `/api/events first byte ${firstByte.ms.toFixed(1)} ms exceeds the ${READ_CEILING} ms suite ceiling`);
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
  // The envelope contract: a document names its exit code, so the dispatcher holds every
  // JSON document until the command returns - under --json, stdout is silent before the
  // stop. The readiness signal is therefore the socket: it binds before the signal
  // handler, microseconds later, and a fixed sleep raced Node's startup under load, and
  // a SIGINT that arrived first reached the default handler and exited with a null code.
  const probe = createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  const child = spawn(process.execPath, [BIN, 'studio', '--json', '--no-open', '--port', String(port)], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`studio never bound port ${port}; output: ${out}`)), 15000);
      const poll = setInterval(() => {
        httpReq(port).then(
          () => { clearTimeout(timer); clearInterval(poll); resolve(); },
          (error) => {
            if (error.code !== 'ECONNREFUSED') { clearTimeout(timer); clearInterval(poll); reject(error); }
          },
        );
      }, 50);
    });
    child.kill('SIGINT');
    // Bounded: a SIGINT that the handler swallows must fail the test, not wait for it.
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`studio did not exit 10000 ms after SIGINT; output: ${out}`));
      }, 10000);
      child.on('exit', (c) => { clearTimeout(timer); resolve(c); });
    });
    assert.equal(code, 0);
    const docs = out.trim().split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
    const doc = docs.find((d) => typeof d.url === 'string');
    assert.ok(doc, `no envelope document in: ${out}`);
    assert.match(doc.url, /^http:\/\/127\.0\.0\.1:\d+\/\?token=/);
    assert.equal(doc.port, port);
    assert.equal(doc.exitCode, 0);
    assert.equal(doc.ok, true);
  } finally {
    // A child alive when the test ends holds its pipes open, and a pipe held open keeps
    // the test process alive after the last test: one leak hung the whole run.
    if (child.exitCode === null) child.kill('SIGKILL');
  }
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