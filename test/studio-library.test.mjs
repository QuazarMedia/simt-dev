// ST13: the Library renders `lessons list` and `skills index` as shelves and a catalog,
// and `skills show` as a reading pane (ADR-212, ADR-226).
//
// The assertions are about shape and provenance: candidates and promoted lessons stay on
// separate shelves, a byte label is the registry's own number, and the pane's body is the
// body `skills show --json` returned - not a second copy.

import test from 'node:test';
import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';

import { simt } from './fixture.mjs';
import { fixtureRepo, httpReq, session, startStudio, treeDigest } from './studio-fixture.mjs';
import { catalogHtml, filterLibrary, formatBytes, lessonShelfHtml, skillPane } from '../src/studio/public/library.js';
import { librarySkill } from '../src/studio/library.mjs';

const PAYLOAD = {
  ok: true,
  lessons: {
    ok: true,
    candidates: [
      { id: 'candidate-1', status: 'candidate', kind: 'fail-then-fix', errorLine: 'Error: restage failed', fixDiff: '-old\n+new', signature: 'sha256-abc' },
      { id: 'candidate-2', status: 'promoted', kind: 'revert', errorLine: 'Error: already fixed' },
    ],
    promoted: [{ id: '0001-one', title: 'One lesson', summary: 'a promoted lesson', expires: '2027-01-01' }],
  },
  skills: {
    ok: true,
    skills: [
      { name: 'alpha', bytes: 2048, deferred: false, summary: 'first', capabilities: ['build'], stack: ['node'] },
      { name: 'beta', bytes: 99, deferred: true, summary: 'second', capabilities: ['deploy'], stack: ['node'] },
    ],
  },
};

test('candidate and promoted shelves stay separate, and the candidate names its review command', () => {
  const html = lessonShelfHtml(PAYLOAD);
  const candidates = html.indexOf('>Candidates<');
  const promoted = html.indexOf('>Promoted lessons<');
  assert.ok(candidates >= 0 && promoted > candidates);
  const candidateShelf = html.slice(candidates, promoted);
  assert.match(candidateShelf, /candidate-1/);
  assert.match(candidateShelf, /Error: restage failed/);
  assert.match(candidateShelf, /simt lessons review candidate-1 --yes/);
  assert.doesNotMatch(candidateShelf, /one lesson/i, 'a promoted lesson leaked onto the candidate shelf');
  assert.match(html.slice(promoted), /0001-one/);
  assert.match(html.slice(promoted), /a promoted lesson/);
  assert.doesNotMatch(html, /candidate-2/, 'an already-promoted candidate was listed as a candidate');
});

test('filtering is client-side over the fetched rows, with no re-ranking', () => {
  assert.deepEqual(filterLibrary(PAYLOAD, 'alpha').skills.map((s) => s.name), ['alpha']);
  assert.deepEqual(filterLibrary(PAYLOAD, 'deploy').skills.map((s) => s.name), ['beta']);
  assert.deepEqual(filterLibrary(PAYLOAD, 'one lesson').promoted.map((l) => l.id), ['0001-one']);
  assert.deepEqual(filterLibrary(PAYLOAD, 'restage').candidates.map((c) => c.id), ['candidate-1']);
  const unfiltered = filterLibrary(PAYLOAD, '');
  assert.deepEqual(unfiltered.skills.map((s) => s.name), ['alpha', 'beta'], 'the catalog was reordered');
});

test('byte labels are the registry bytes, and the catalog names the deferred flag', () => {
  assert.equal(formatBytes(2048), '2048 B');
  const html = catalogHtml(PAYLOAD);
  assert.match(html, /alpha[\s\S]*2048 B/);
  assert.match(html, /beta[\s\S]*99 B[\s\S]*deferred/);
  assert.match(html, /data-skill="alpha"/);
});

test('the reading pane is the body skills show returned, escaped', () => {
  const html = skillPane({ ok: true, bodyFrom: 'repo', body: 'SKILL.md', skill: { name: 'alpha', bytes: 2048, summary: 'first' }, bodyText: '<script>alert(1)</script>\nbody' });
  assert.match(html, /alpha/);
  assert.match(html, /2048 B/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;\nbody/);
  assert.doesNotMatch(html, /<script>/);
  const refused = skillPane({ ok: false, error: 'no skill', remedy: 'choose one' });
  assert.match(refused, /Refused/);
  assert.match(refused, /no skill/);
});

test('the library route serves both CLI documents and writes nothing', async (t) => {
  const root = await realpath(await fixtureRepo());
  const before = await treeDigest(root);
  const lessons = await simt(['lessons', 'list', '--json'], { cwd: root });
  const skills = await simt(['skills', 'index', '--json'], { cwd: root });
  assert.equal(lessons.code, 0, lessons.stderr);
  assert.equal(skills.code, 0, skills.stderr);

  const studio = await startStudio(root);
  t.after(() => studio.stop());
  const cookie = await session(studio);
  const route = await httpReq(studio.port, { path: '/api/library', headers: { cookie } });
  assert.equal(route.status, 200, route.body);
  const served = JSON.parse(route.body);
  assert.deepEqual(served.lessons, JSON.parse(lessons.stdout));
  // The workspace label is resolved from the process that asks; the catalog itself is
  // the registry's answer, and that is what the view copies.
  assert.deepEqual(served.skills.skills, JSON.parse(skills.stdout).skills);
  assert.equal(served.skills.command, 'skills index');
  assert.equal(await treeDigest(root), before);

  const name = served.skills.skills[0].name;
  const pane = await httpReq(studio.port, { path: `/api/library/skill?name=${encodeURIComponent(name)}`, headers: { cookie } });
  assert.equal(pane.status, 200, pane.body);
  const shown = await simt(['skills', 'show', name, '--json'], { cwd: root });
  assert.equal(shown.code, 0, shown.stderr);
  assert.deepEqual(JSON.parse(pane.body), JSON.parse(shown.stdout));
  assert.equal(JSON.parse(pane.body).bodyText, JSON.parse(shown.stdout).bodyText);
});

test('a skill request without a name is a refusal, not an empty pane', async () => {
  const refused = await librarySkill(await fixtureRepo(), '');
  assert.equal(refused.ok, false);
  assert.match(refused.error, /skill name/);
});
