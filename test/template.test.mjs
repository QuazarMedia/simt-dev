// The tracker template (review 0003 Q92).
//
// `plan/template.mjs` turns the delivered `templates/plan/tracker.json`, or a repository's
// `plans` overlay on it, into the format every plan command parses with. It had no direct
// test: the plan suite reaches it through `simt plan` in a child process, so a rejected
// template and an accepted one looked the same from there - both produced a plan command
// that said something.
//
// What is asserted here is the validation itself: the overlay replaces only the section it
// names, and every key that would silently index the wrong directory is refused with a
// message a reader can act on.

import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { DEFAULT_DIRECTORIES, loadFormat } from '../src/plan/template.mjs';
import { tempDir } from './fixture.mjs';

async function rootWith(plans = null) {
  const root = await tempDir('template-');
  if (plans !== null) await writeFile(join(root, 'simt.json'), `${JSON.stringify({ id: 'fixture', plans }, null, 2)}\n`);
  return root;
}

test('a repository with no manifest gets the delivered tracker', async () => {
  const { format, error } = await loadFormat(await rootWith());
  assert.equal(error, undefined);
  assert.equal(format.name, 'tracker');
  assert.deepEqual(format.directories.map((d) => d.path), DEFAULT_DIRECTORIES);
  assert.ok(format.known.size > 1, 'the template declares no states');
});

test('a plans key replaces the section it names and leaves the rest delivered', async () => {
  const { format } = await loadFormat(await rootWith({ columns: { state: ['Status'], depends: [] } }));
  // The overlay wins where it speaks...
  assert.deepEqual(format.stateHeaders, ['status']);
  assert.deepEqual(format.dependsHeaders, []);
  // ...and says nothing about the directories, which stay as delivered.
  assert.deepEqual(format.directories.map((d) => d.path), DEFAULT_DIRECTORIES);
});

test('an unknown key is refused rather than ignored', async () => {
  // A key this file does not know is a key that would index nothing while looking applied.
  const { error, remedy } = await loadFormat(await rootWith({ colours: { done: 'green' } }));
  assert.match(error, /unknown colours/);
  assert.match(remedy, /fix the plans key in simt\.json/);
});

test('a template that cannot be ready, parsed or read is refused with its own reason', async () => {
  const cases = [
    [{ states: [] }, /states must list at least one state/],
    [{ ready: 'nowhere' }, /ready must name a state/],
    [{ dependency: { separators: 'abc' } }, /dependency.separators must be punctuation/],
    [{ dependency: { separators: '' } }, /dependency.separators must be one to eight characters/],
    [{ section: { depth: 9 } }, /section.depth must be from 1 to 6/],
    [{ columns: { state: ['bad|header'] } }, /a header containing a pipe or a newline/],
    [{ id: { pattern: '(' } }, /id.pattern is not a valid pattern/],
  ];
  for (const [plans, expected] of cases) {
    const { error } = await loadFormat(await rootWith(plans));
    assert.match(error ?? '', expected, JSON.stringify(plans));
  }
});

test('two directories cannot share a kind, a word or a path', async () => {
  const dupes = [
    [{ kind: 'plan', path: 'docs/plans' }, { kind: 'plan', path: 'docs/other' }],
    [{ kind: 'plan', path: 'docs/plans' }, { kind: 'review', word: 'plan', path: 'docs/reviews' }],
    [{ kind: 'plan', path: 'docs/plans' }, { kind: 'review', path: 'docs/plans' }],
  ];
  for (const directories of dupes) {
    const { error } = await loadFormat(await rootWith({ directories }));
    assert.match(error ?? '', /is listed twice/, JSON.stringify(directories));
  }
});

test('a directory outside the repository is not a directory this tracker can have', async () => {
  for (const path of ['/etc', '../elsewhere', 'docs/../../out', './']) {
    const { error } = await loadFormat(await rootWith({ directories: [{ kind: 'plan', path }] }));
    assert.match(error ?? '', /path must be a directory inside the repository/, path);
  }
});

test('a state cell is read by its longest matching word, and anything else is unknown', async () => {
  const { format } = await loadFormat(await rootWith());
  const [first] = format.order;
  assert.equal(format.readState(`**${format.canonical(first)}**`), first);
  // A note after the state does not make the state unknown.
  assert.equal(format.readState(`${format.canonical(first)} (since Monday)`), first);
  assert.equal(format.readState('a word no state claims'), 'unknown');
  assert.equal(format.readState(''), 'unknown');
  assert.equal(format.canonical('a word no state claims'), null);
});
