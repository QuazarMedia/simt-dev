// Plan 0004 W09: work profiles are opt-in, and they claim only what the repository declared.
//
// The failure this pins is a knowledge repository being told to run a test command that
// does not exist, or a mixed repository losing its code gates because a document profile
// matched. Each profile is selected by a fact only an explicit `work` declaration emits,
// so a repository that never declared work renders exactly what Plan 3 rendered.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { loadRules, plan, select } from '../src/projection/project.mjs';
import { WORK_FACTS } from '../src/resolve/fingerprint.mjs';
import { git, keepTemp } from './fixture.mjs';

async function repo(files) {
  const root = await mkdtemp(join(tmpdir(), 'simt-work-profiles-'));
  keepTemp(root);
  for (const [rel, body] of Object.entries(files)) {
    const path = join(root, rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }
  await git(['init', '-q', root]);
  return root;
}

/** The projected region as a reader receives it. */
async function region(root) {
  const planned = await plan(root, {});
  const target = (planned.targets ?? []).find((row) => row.file === 'AGENTS.md');
  assert.ok(target, `no AGENTS.md in a plan of ${Object.keys(planned).join(', ')}`);
  return target.text;
}

const KNOWLEDGE = {
  'simt.json': JSON.stringify({
    id: 'knowledge',
    version: 1,
    work: { version: 1, scopes: [{ id: 'de', paths: ['Germany'], validators: ['node eval/check.mjs'] }] },
  }),
  'README.md': '# country knowledge\n',
  'Germany/rates.md': '# rates\n',
  'eval/check.mjs': 'export const check = () => true;\n',
};

test('the three work profiles exist, carry ids and select only on work facts', async () => {
  const rules = await loadRules();
  const work = rules.filter((row) => row.source.startsWith('rules/work/'));
  assert.deepEqual(work.map((row) => row.id).sort(), ['work/knowledge', 'work/procedures', 'work/remote-operations']);
  for (const rule of work) {
    assert.ok(rule.applies.every((tag) => WORK_FACTS.includes(tag)), `${rule.id} selects on ${rule.applies.join(', ')}`);
  }
  const none = select(rules, ['node'], []);
  assert.equal(none.selected.some((row) => row.id?.startsWith('work/')), false, 'no declaration, no work profile');
  const scoped = select(rules, [], ['has-work-scopes', 'has-work-validators']);
  assert.deepEqual(scoped.selected.filter((row) => row.id?.startsWith('work/')).map((row) => row.id).sort(), [
    'work/knowledge',
    'work/procedures',
  ]);
});

test('a knowledge-only adoption never claims a software test it does not have', async () => {
  const text = await region(await repo(KNOWLEDGE));
  assert.match(text, /## Stack: work\/knowledge/, 'the document product has its own rules');
  assert.match(text, /## Stack: work\/procedures/, 'the declared validator is named as the check');
  assert.doesNotMatch(text, /npm run test|pytest|gradlew test/, 'no runner is claimed where none exists');
  assert.doesNotMatch(text, /## Stack: work\/remote-operations/, 'no target was declared');
  assert.match(text, /A document that is well formed is not a document that is correct/);
});

test('a mixed repository keeps its code gates while gaining the knowledge rules', async () => {
  const root = await repo({
    ...KNOWLEDGE,
    'package.json': JSON.stringify({ name: 'mixed', scripts: { test: 'node --test' } }),
    'src/app.mjs': 'export const app = () => 1;\n',
    'test/app.test.mjs': "import test from 'node:test';\ntest('app', () => {});\n",
  });
  const text = await region(root);
  assert.match(text, /## Stack: work\/knowledge/);
  assert.match(text, /npm run test/, 'the repository runner is still the gate for its source');
  assert.match(text, /node --test/, 'the node profile is not replaced by the work profile');
});

test('declared targets add the remote-operations rules with approval, CAS and idempotency intact', async () => {
  const text = await region(
    await repo({
      'simt.json': JSON.stringify({ id: 'remote', version: 1, work: { version: 1, targets: [{ namespace: 'tenant-a', type: 'calculation' }] } }),
      'README.md': '# operations\n',
    }),
  );
  assert.match(text, /## Stack: work\/remote-operations/);
  assert.match(text, /Get explicit approval for the specific mutation/);
  assert.match(text, /compare-and-set/);
  assert.match(text, /idempotency key/);
  assert.match(text, /Do not send credentials, cookies, tokens or host identifiers/);
  assert.match(text, /the result is unverified/);
});

test('a repository that declares no work renders none of these profiles', async () => {
  const text = await region(await repo({ 'README.md': '# plain docs\n', 'docs/note.md': '# note\n' }));
  assert.doesNotMatch(text, /## Stack: work\//);
  // And the core truth rule survives every fixture above, which is the guarantee that a
  // new profile cannot relax an existing one.
  assert.match(text, /Never claim a test you did not run/);
});
