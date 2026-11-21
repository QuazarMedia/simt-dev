// Plan 0004 W44: procedure graduation and semantic conformance.
//
// What the suite pins: three validated independent runs are the minimum and are evidence to review
// rather than proof; a run that is not validated or not independent does not count; the proposal
// names common steps, branches and the environment-local values to parameterise; promotion needs a
// held-out variant and a failure path; the comparison is semantic, not transport; and one
// environment cannot establish portability whatever the hostname is called.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { git, simt, tempDir } from './fixture.mjs';

import {
  MIN_RUNS,
  PROPOSAL_STATES,
  differentialReplay,
  portability,
  promotionReady,
  proposeGraduation,
} from '../src/memory/graduation.mjs';

const trace = (environment = 'env-1', over = {}) => ({
  goal: 'publish',
  capability: 'rest',
  validated: true,
  environment,
  steps: ['read', 'write', 'verify'],
  values: ['77', 'rates.example.test'],
  ...over,
});

const three = () => [trace('env-1'), trace('env-2'), trace('env-3')];

test('the minimum and the proposal states are named', () => {
  assert.equal(MIN_RUNS, 3);
  assert.deepEqual(PROPOSAL_STATES, ['proposable', 'insufficient-evidence', 'blocked']);
});

test('two validated runs are not enough, and the reason says what would be', () => {
  const proposal = proposeGraduation({ traces: [trace('env-1'), trace('env-2')] }).proposals[0];
  assert.equal(proposal.state, 'insufficient-evidence');
  assert.equal(proposal.validated, 2);
  assert.match(proposal.reason, /3 are needed, and even 3 is evidence to review/);
});

test('an unvalidated or dependent run does not count', () => {
  const traces = [trace('env-1'), trace('env-2'), trace('env-3', { validated: false }), trace('env-4', { independent: false })];
  assert.equal(proposeGraduation({ traces }).proposals[0].validated, 2);
});

test('three runs propose the common steps, the branches and the parameters', () => {
  const traces = [trace('env-1'), trace('env-2'), trace('env-3', { steps: ['read', 'write', 'verify', 'compensate'], values: ['91'] })];
  const proposal = proposeGraduation({ traces }).proposals[0];
  assert.equal(proposal.state, 'proposable');
  assert.deepEqual(proposal.common, ['read', 'write', 'verify']);
  assert.deepEqual(proposal.branches, ['compensate']);
  assert.deepEqual(proposal.parameters, ['77', '91', 'rates.example.test']);
  assert.equal(proposal.requiresHeldOut, true);
  assert.equal(proposal.requiresFailurePath, true);
  assert.equal(proposal.humanReview, true);
});

test('promotion needs a held-out variant and a failure path', () => {
  const proposal = proposeGraduation({ traces: three() }).proposals[0];
  assert.equal(promotionReady({ proposal, heldOut: { passed: true }, failurePath: { passed: true } }).ready, true);

  const blocked = promotionReady({ proposal, heldOut: { passed: true }, failurePath: null });
  assert.equal(blocked.ready, false);
  assert.equal(blocked.state, 'blocked');
  assert.deepEqual(blocked.missing, ['a failure-path check that passes']);
  assert.equal(blocked.humanReview, true);
  assert.equal(promotionReady({ proposal: { state: 'insufficient-evidence' }, heldOut: { passed: true }, failurePath: { passed: true } }).ready, false);
});

test('differential replay compares the result, not the transport', () => {
  const reference = { fields: { name: 'discount', audience: 'staff' } };
  const helper = { fields: { name: 'discount', audience: 'staff' } };
  const result = differentialReplay({ reference, helper, postconditions: [{ field: 'name' }], frames: [{ field: 'audience', expect: 'staff' }] });
  assert.equal(result.equivalent, true);
  assert.equal(result.transportIdentical, false);
  assert.match(result.reason, /transport trace need not/);
});

test('a helper that reaches a different result is not equivalent', () => {
  const reference = { fields: { name: 'discount', audience: 'staff' } };
  const wrong = { fields: { name: 'discount-v2', audience: 'staff' } };
  const result = differentialReplay({ reference, helper: wrong, postconditions: [{ field: 'name' }], frames: [{ field: 'audience', expect: 'staff' }] });
  assert.equal(result.equivalent, false);
  assert.deepEqual(result.failed, [{ field: 'name', kind: 'postcondition' }]);

  const brokenFrame = differentialReplay({ reference, helper: { fields: { name: 'discount', audience: 'everyone' } }, postconditions: [{ field: 'name' }], frames: [{ field: 'audience', expect: 'staff' }] });
  assert.deepEqual(brokenFrame.failed, [{ field: 'audience', kind: 'frame' }]);
});

test('one environment cannot establish portability, whatever the hostname', () => {
  const single = portability([trace('env-1'), trace('env-1')]);
  assert.equal(single.portable, false);
  assert.match(single.reason, /single environment/);

  const multi = portability([trace('env-1'), trace('env-2')]);
  assert.equal(multi.portable, true);
  assert.deepEqual(multi.parameters, ['77', 'rates.example.test']);
});

test('the module is deterministic and reads nothing', async () => {
  assert.deepEqual(proposeGraduation({ traces: three() }), proposeGraduation({ traces: three() }));
  const source = await readFile(new URL('../src/memory/graduation.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:fs|node:net|fetch\(|process\.env|Date\.|Math\.random/);
});

test('scoped maintenance names evidence debt and proposes only independently verified work', async () => {
  const root = await tempDir('simt-local-maintenance-');
  await mkdir(join(root, 'handbook'));
  await mkdir(join(root, '.simt/local'), { recursive: true });
  const put = (path, value) => writeFile(join(root, path), value);
  await put('.gitignore', '.simt/local/\n');
  await put('simt.json', JSON.stringify({ work: { version: 2, scopes: [{
    id: 'handbook', paths: ['handbook'], kind: 'document', validators: ['node check.cjs'],
  }] } }));
  await put('check.cjs', 'console.log("simt checked: 1");\n');
  const claim = (id, from, known, evidence = '') =>
    `---\nauthority: reviewed\nvalidFrom: ${from}\nknownAt: ${known}\n---\n# Retention\n\n<!-- claim: id=${id} subject=device predicate=retention type=number value=30 status=reviewed${evidence} -->\n`;
  await put('handbook/old.md', claim('older', '2024-01-01', '2024-01-02'));
  await put('handbook/new.md', claim('newer', '2025-01-01', '2025-01-02', ' evidence=older'));
  await put('handbook/broken.md', '---\nsources: ["handbook/unknown.md"]\n---\n# Broken citation\n');
  await put('handbook/generated.md', '<!-- generated, do not edit -->\n# Specification\n');
  for (const name of ['a', 'b', 'c']) await put(`handbook/${name}.md`, `# Policy ${name}\n`);
  await put('.simt/local/lessons.jsonl', JSON.stringify({
    kind: 'fail-then-fix', signature: 'fixture-signature', paths: ['handbook/a.md'], before: 'PRIVATE TRACE BODY',
  }) + '\n');
  await git(['init', '-q'], { cwd: root });
  await git(['add', '.'], { cwd: root });
  await git(['commit', '-qm', 'fixture sources'], { cwd: root });
  const call = async (args) => {
    const result = await simt([...args, '--scope', 'handbook', '--json'], { cwd: root });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /PRIVATE TRACE BODY/);
    return JSON.parse(result.stdout);
  };
  const verify = () => call(['verify', 'run', '--changed', '--yes']);
  const graduate = () => call(['work', 'graduate']);
  const debt = () => call(['knowledge', 'debt']);

  await put('handbook/a.md', '# Policy a revised\n');
  await verify();
  const one = (await graduate()).proposals[0];
  assert.equal(one.validated, 1);
  assert.equal(one.state, 'insufficient-evidence');
  await put('handbook/a.md', '# Changed since the receipt\n');
  const stale = (await graduate()).proposals[0];
  assert.equal(stale.validated, 0);
  assert.equal(stale.state, 'insufficient-evidence');
  const backlog = await debt();
  assert.equal(backlog.proposalOnly, true);
  assert.equal(backlog.lessonCandidates, 1);
  assert.ok(backlog.ranked.some(({ kind, next }) => kind === 'broken-citation' && next.includes('handbook/broken.md')));
  assert.ok(backlog.ranked.some(({ kind, knownAt }) => kind === 'new-source-observation' && knownAt === '2025-01-02'));
  assert.ok(backlog.ranked.some(({ kind }) => kind === 'stale'));
  assert.ok(backlog.ranked.some(({ kind }) => kind === 'missing-derivation'));

  for (const name of ['a', 'b', 'c']) {
    const path = `handbook/${name}.md`;
    await put(path, `# Verified policy ${name}\n`);
    await verify();
    await git(['add', path], { cwd: root });
    await git(['commit', '-qm', `verified fixture ${name}`], { cwd: root });
  }
  const ledgerPath = join(root, '.simt/local/ledger.jsonl');
  const before = await readFile(ledgerPath, 'utf8');
  const { proposals, executed } = await graduate();
  assert.equal(executed, false);
  assert.equal(proposals[0].state, 'proposable');
  assert.equal(proposals[0].validated, 3);
  assert.equal(proposals[0].humanReview, true);
  assert.equal(proposals[0].promotion.ready, false);
  assert.equal(proposals[0].receipts.length, 3);
  assert.equal((await git(['status', '--porcelain'], { cwd: root })).stdout, '');
  assert.equal(await readFile(ledgerPath, 'utf8'), before);
});
