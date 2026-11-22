// ST03: the shell is same-origin, under budget, and renders refusals (ADR-075, ADR-212).
//
// The asset scan reads the shipped files themselves, not a list of names: a new asset
// arrives under the same assertions without a second edit. Components are pure string
// builders, so their rendering is asserted here in node; the router and client are
// exercised in the browser against the running socket.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { badge, emptyState, escapeHtml, refusalPanel, table } from '../src/studio/public/components.js';
import { bench } from '../src/studio/public/bench.js';
import { control, controlPreview } from '../src/studio/public/control.js';
import { library, skillPane } from '../src/studio/public/library.js';
import { fixtureRepo, httpReq, session, startStudio } from './studio-fixture.mjs';

const PUBLIC_DIR = fileURLToPath(new URL('../src/studio/public/', import.meta.url));

async function assets() {
  const out = [];
  for (const name of (await readdir(PUBLIC_DIR)).sort()) {
    out.push({ name, body: await readFile(join(PUBLIC_DIR, name), 'utf8') });
  }
  return out;
}

test('no shipped asset references anything outside the origin', async () => {
  for (const { name, body } of await assets()) {
    assert.doesNotMatch(body, /https?:\/\//i, `${name} names an absolute URL`);
    assert.doesNotMatch(body, /@import/i, `${name} imports a stylesheet`);
    assert.doesNotMatch(body, /url\(\s*['"]?(?:https?:)?\/\//i, `${name} fetches through url()`);
    assert.doesNotMatch(body, /rel=["']?(?:preconnect|dns-prefetch|prefetch)/i, `${name} hints at another origin`);
  }
});

test('the shell stays under the 120 KB asset budget and the file-line ceiling', async () => {
  const all = await assets();
  const bytes = all.reduce((sum, a) => sum + Buffer.byteLength(a.body), 0);
  assert.ok(bytes < 120 * 1024, `assets total ${bytes} bytes`);
  for (const { name, body } of all) {
    const lines = body.split('\n').length;
    assert.ok(lines <= 400, `${name} is ${lines} lines`);
  }
});

test('the page carries no inline script or style the CSP would refuse', async () => {
  const html = (await assets()).find((a) => a.name === 'index.html').body;
  assert.doesNotMatch(html, /<script\b(?![^>]*\bsrc=)[^>]*>/i, 'inline script');
  assert.doesNotMatch(html, /<style\b/i, 'inline stylesheet');
  assert.doesNotMatch(html, /\sstyle\s*=/i, 'inline style attribute');
  assert.match(html, /<script type="module" src="\/app\.js">/);
});

test('both themes, the system preference and reduced motion are in the stylesheet', async () => {
  const css = (await assets()).find((a) => a.name === 'shell.css').body;
  assert.match(css, /@media \(prefers-color-scheme: light\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /\[data-theme="light"\]/);
  assert.match(css, /:focus-visible/);
});

test('the control, library and Bench views keep their shared layout hooks', async () => {
  const css = (await assets()).find((a) => a.name === 'shell.css').body;
  const libraryPayload = {
    ok: true,
    lessons: {
      ok: true,
      candidates: [{ id: 'candidate-1', status: 'candidate', kind: 'fail-then-fix', errorLine: 'boom' }],
      promoted: [{ id: 'lesson-1', title: 'Lesson', summary: 'promoted' }],
    },
    skills: { ok: true, skills: [{ name: 'alpha', bytes: 10, summary: 'first' }] },
  };

  const controlView = control({ ok: true, commands: ['sync'] });
  assert.match(controlView, /class="control-form"/);
  assert.match(controlView, /id="control-result"/);
  assert.match(
    controlPreview({ ok: true, digest: 'sha256-x', plan: { files: ['a'], diff: [{ path: 'a', before: 'old', after: 'new' }] } }),
    /class="control-side"/,
  );
  for (const hook of ['control-form', 'control-side']) {
    assert.match(css, new RegExp(`\\.${hook}(?![\\w-])`), `${hook} has no shared stylesheet rule`);
  }
  assert.match(css, /#control-result\b/);

  const libraryView = library(libraryPayload);
  for (const hook of ['library', 'library-search', 'library-shelf', 'library-catalog', 'skill-card']) {
    assert.match(libraryView, new RegExp(`class="[^"]*\\b${hook}(?=\\s|")`), `${hook} is missing from the library view`);
    assert.match(css, new RegExp(`\\.${hook}(?![\\w-])`), `${hook} has no shared stylesheet rule`);
  }
  const pane = skillPane({ ok: true, bodyFrom: 'repo', skill: { name: 'alpha', bytes: 10 }, bodyText: 'body' });
  assert.match(pane, /class="card skill-reading"/);
  assert.match(pane, /class="skill-body"/);
  for (const hook of ['skill-reading', 'skill-body']) {
    assert.match(css, new RegExp(`\\.${hook}(?![\\w-])`), `${hook} has no shared stylesheet rule`);
  }

  const benchView = bench({ ok: true, runCount: 1, arms: [{ arm: 'bare', R: 0.5 }], failures: [], mapRecall: { measured: false, reason: 'not run' } });
  assert.match(benchView, /<section class="bench">/);
  assert.match(benchView, /class="card"/);
  assert.match(benchView, /class="empty"/);
  assert.match(benchView, /<progress/);
  assert.match(css, /\.card\b/);
  assert.match(css, /\.empty\b/);
});

test('the refusal panel renders the door payload, escaped', () => {
  const panel = refusalPanel({ ok: false, error: 'STUDIO_TOKEN_REFUSED', remedy: 'open the fresh URL', exitCode: 2 });
  assert.match(panel, /role="alert"/);
  assert.match(panel, /STUDIO_TOKEN_REFUSED/);
  assert.match(panel, /open the fresh URL/);
  assert.match(panel, /exit 2/);

  const hostile = refusalPanel({ ok: false, error: '<script>alert(1)</script>', remedy: 'a & b "quoted"' });
  assert.doesNotMatch(hostile, /<script>/);
  assert.match(hostile, /&lt;script&gt;/);
  assert.match(hostile, /a &amp; b &quot;quoted&quot;/);

  const envelope = refusalPanel({ ok: false, error: { code: 'MAX_BYTES', message: 'output exceeded the ceiling' } });
  assert.match(envelope, /output exceeded the ceiling/);
});

test('badges, tables and empty states escape their data', () => {
  assert.match(badge('green', 'ok'), /badge-ok/);
  assert.match(badge('x', 'not-a-tone'), /badge-neutral/);
  const t = table({ columns: ['file'], rows: [['<img src=x onerror=alert(1)>']] });
  assert.doesNotMatch(t, /<img/);
  assert.match(t, /&lt;img/);
  assert.match(emptyState({ title: 'Nothing', hint: 'a & b' }), /a &amp; b/);
  assert.equal(escapeHtml(null), 'null');
});

test('the server serves every asset with its type and the CSP', async (t) => {
  const studio = await startStudio(await fixtureRepo());
  t.after(() => studio.stop());
  const cookie = await session(studio);
  const types = { '.html': /text\/html/, '.css': /text\/css/, '.js': /text\/javascript/ };
  for (const { name } of await assets()) {
    const res = await httpReq(studio.port, { path: `/${name}`, headers: { cookie } });
    assert.equal(res.status, 200, name);
    assert.match(res.headers['content-type'], types[extname(name)], name);
    assert.match(res.headers['content-security-policy'], /default-src 'self'/);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
  }
  const root = await httpReq(studio.port, { headers: { cookie } });
  assert.equal(root.status, 200);
  assert.match(root.body, /simt studio/);
});

test('a crafted path out of the public directory is refused', async (t) => {
  const studio = await startStudio(await fixtureRepo());
  t.after(() => studio.stop());
  const cookie = await session(studio);
  for (const path of ['/%2e%2e/server.mjs', '/%2e%2e/%2e%2e/package.json', '/nope.js', '/%zz']) {
    const res = await httpReq(studio.port, { path, headers: { cookie } });
    assert.equal(res.status, 404, path);
    assert.equal(JSON.parse(res.body).ok, false, path);
  }
});