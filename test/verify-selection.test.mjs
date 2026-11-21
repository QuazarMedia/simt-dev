// Plan 0004 W27: obligation-aware incremental gate selection.
//
// What this suite pins is mostly what the selection refuses: a no-opt-in repository keeps its
// existing import closure, a clean diff is a no-op rather than an empty pass, a non-empty opted-in
// change with no admissible validator is `unverified` and never green, an independence
// requirement is not satisfied by two cheap validators from one provider, an unknown dependency
// expands only to the declared scope, and a Git hook cannot run a remote validator.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { git, simt, tempDir } from './fixture.mjs';

import { coverage } from '../src/index/coverage.mjs';
import {
  CHECK_CLASSES,
  SELECTION_SCHEMA_VERSION,
  SELECTION_STATUSES,
  checkVerifyRun,
  selectVerification,
} from '../src/verify/select.mjs';

const validator = (id, over = {}) => ({ id, class: 'document', covers: ['rates-doc'], cost: 1, environment: 'local', ...over });

const IMPORTS = [
  { src: 'test/rates.test.mjs', dst: 'src/rates.mjs', kind: 'import' },
  { src: 'src/rates.mjs', dst: 'src/core.mjs', kind: 'import' },
];

test('the schema names the statuses and the three check classes', () => {
  assert.equal(SELECTION_SCHEMA_VERSION, 1);
  assert.deepEqual(SELECTION_STATUSES, ['no-op', 'ok', 'unverified']);
  assert.deepEqual(CHECK_CLASSES, ['source', 'document', 'remote']);
});

test('without opting in, the source selection is the existing import closure', () => {
  const expected = coverage({ imports: IMPORTS }, ['src/core.mjs']);
  const report = selectVerification({ changed: ['src/core.mjs'], imports: IMPORTS });
  assert.deepEqual(report.selected.source, expected);
  assert.equal(report.status, 'ok');
  assert.equal(report.unverified.length, 0);

  // A caller that already computed the closure gets exactly that, not a recomputation.
  const handed = selectVerification({ changed: ['src/core.mjs'], imports: IMPORTS, closure: ['test/handed.test.mjs'] });
  assert.deepEqual(handed.selected.source, ['test/handed.test.mjs']);
});

test('a clean diff is a legitimate no-op, not an empty pass', () => {
  const report = selectVerification({ changed: [], imports: IMPORTS });
  assert.equal(report.status, 'no-op');
  assert.equal(report.claimsGreen, false);
  assert.deepEqual(report.selected, { source: [], document: [], remote: [] });
});

test('an opted-in change with no admissible validator is unverified and never green', () => {
  const report = selectVerification({
    changed: ['docs/rates.md'],
    typed: [{ id: 'rates-doc', paths: ['docs/rates.md'] }],
    validators: [],
  });
  assert.equal(report.status, 'unverified');
  assert.equal(report.claimsGreen, false);
  assert.deepEqual(report.unverified, [{ obligation: 'rates-doc', reason: 'no-admissible-validator' }]);
});

test('mandatory validators are taken first, and the cover then picks by cost', () => {
  const report = selectVerification({
    changed: ['docs/rates.md', 'docs/notes.md'],
    typed: [{ id: 'rates-doc', paths: ['docs/rates.md'] }, { id: 'notes-doc', paths: ['docs/notes.md'] }],
    validators: [
      validator('mandatory-doc', { mandatory: true }),
      validator('cheap-both', { covers: ['rates-doc', 'notes-doc'], cost: 1 }),
      validator('expensive-both', { covers: ['rates-doc', 'notes-doc'], cost: 9 }),
      validator('notes-only', { covers: ['notes-doc'], cost: 1 }),
    ],
  });
  // The plan is sorted by id so the output is reproducible; `basis` is what says a mandatory
  // validator was taken before any scoring, not its position in the list.
  assert.equal(report.plan.find((entry) => entry.id === 'mandatory-doc').basis, 'mandatory');
  assert.ok(report.plan.some((entry) => entry.id === 'cheap-both'));
  assert.equal(report.plan.some((entry) => entry.id === 'expensive-both'), false);
  assert.equal(report.status, 'ok');
  assert.equal(report.claimsGreen, true);
});

test('an independence requirement rejects two cheap validators from one provider', () => {
  const sameProvider = selectVerification({
    changed: ['docs/rates.md'],
    typed: [{ id: 'rates-doc', paths: ['docs/rates.md'], needsIndependent: true }],
    validators: [
      validator('a', { provider: 'openai', cost: 1 }),
      validator('b', { provider: 'openai', cost: 1 }),
    ],
  });
  assert.deepEqual(sameProvider.unverified, [{ obligation: 'rates-doc', reason: 'insufficient-independent-validators' }]);
  assert.equal(sameProvider.status, 'unverified');

  const crossProvider = selectVerification({
    changed: ['docs/rates.md'],
    typed: [{ id: 'rates-doc', paths: ['docs/rates.md'], needsIndependent: true }],
    validators: [
      validator('a', { provider: 'openai' }),
      validator('b', { provider: 'anthropic' }),
    ],
  });
  assert.equal(crossProvider.unverified.length, 0);
  assert.equal(crossProvider.status, 'ok');
});

test('an unknown dependency expands to the declared scope, not to everything', () => {
  const report = selectVerification({
    changed: ['docs/adr/0009-new.md', 'src/rates.mjs'],
    imports: IMPORTS,
    typed: [{ id: 'rates-doc', paths: ['docs/rate.md'] }],
    validators: [validator('adr-check', { scope: ['docs/adr/'] }), validator('unrelated', { scope: ['site/'] })],
  });
  assert.ok(report.selected.document.includes('adr-check'));
  assert.equal(report.selected.document.includes('unrelated'), false, 'the expansion left the declared scope');
  assert.match(report.reasons.join(' '), /docs\/adr\/0009-new\.md has no declared obligation, so it expanded to adr-check/);

  const unknownOnly = selectVerification({
    changed: ['docs/adr/0009-new.md'],
    typed: [{ id: 'rates-doc', paths: ['docs/rate.md'] }],
    validators: [validator('adr-check', { scope: ['docs/adr/'] })],
  });
  assert.equal(unknownOnly.selected.document.includes('adr-check'), true);
  assert.equal(unknownOnly.status, 'ok');
});

test('source tests, document checks and remote checks are reported separately', () => {
  const report = selectVerification({
    changed: ['src/core.mjs', 'docs/rates.md'],
    imports: IMPORTS,
    typed: [{ id: 'rates-doc', paths: ['docs/rates.md'] }, { id: 'rates-remote', paths: ['docs/rates.md'] }],
    validators: [
      validator('doc-check', { covers: ['rates-doc'] }),
      validator('remote-check', { class: 'remote', covers: ['rates-remote'], environment: 'target', cost: 3 }),
    ],
  });
  assert.ok(report.selected.source.length > 0);
  assert.deepEqual(report.selected.document, ['doc-check']);
  assert.deepEqual(report.selected.remote, ['remote-check']);
  assert.deepEqual(report.counts, { source: report.selected.source.length, document: 1, remote: 1 });
  assert.deepEqual(report.environment, ['local', 'target']);
  assert.equal(report.costs.total, 4);
});

test('a Git hook cannot run a remote validator; and the refusal cites no missing command', () => {
  const hook = checkVerifyRun({ invocation: 'git-hook', selected: { remote: ['remote-check'] } });
  assert.equal(hook.ok, false);
  assert.equal(hook.code, 'remote-from-hook');
  assert.doesNotMatch(hook.remedy, /simt verify run/);
  assert.equal(hook.usesRepoRunner, true);

  const cli = checkVerifyRun({ invocation: 'cli', selected: { remote: ['remote-check'] } });
  assert.equal(cli.ok, true);
  assert.equal(cli.executesRemote, true);
  assert.equal(cli.usesRepoRunner, true);

  const localHook = checkVerifyRun({ invocation: 'git-hook', selected: { source: ['test/a.test.mjs'] } });
  assert.equal(localHook.ok, true);
});

test('selection is deterministic and the module reads nothing', async () => {
  const input = {
    changed: ['src/core.mjs', 'docs/rates.md'],
    imports: IMPORTS,
    typed: [{ id: 'rates-doc', paths: ['docs/rates.md'] }],
    validators: [validator('a'), validator('b', { cost: 2 })],
  };
  assert.deepEqual(selectVerification(input), selectVerification(structuredClone(input)));
  const source = await readFile(new URL('../src/verify/select.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:fs|node:net|fetch\(|process\.env|Date\.|Math\.random/);
});

test('a field of the wrong type is refused, not read as an empty list (PR20)', async () => {
  const { verifyCommand } = await import('../src/commands/verify.mjs');
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'simt-verify-input-'));
  const doc = (value) => {
    const path = join(dir, `${Math.random().toString(36).slice(2)}.json`);
    return writeFile(path, JSON.stringify(value)).then(() => path);
  };
  // A string `changed` used to select nothing and return an OK no-op.
  assert.equal(await verifyCommand('select', [], { input: await doc({ changed: 'src/a.mjs' }) }), 2);
  assert.equal(await verifyCommand('select', [], { input: await doc({ changed: ['src/a.mjs'] }) }), 0);
  assert.equal(await verifyCommand('plan', [], { input: await doc({ obligations: 'all' }) }), 2);
});

async function localRepository(additional = []) {
  const root = await tempDir('simt-verify-selection-');
  const files = {
    'simt.json': JSON.stringify({
      work: { version: 3, scopes: [{
        id: 'docs', paths: ['docs', 'src'], kind: 'document', ignore: ['private'],
        validators: ['node "scripts/check docs.mjs"'],
        independent: ['links'],
        checks: [
          { id: 'link-a', gate: 'docs-links', covers: ['links'], provider: 'same' },
          { id: 'link-b', argv: ['node', 'scripts/check docs.mjs'], covers: ['links'], provider: 'same' },
          { id: 'source-support', argv: ['simt-fixture-missing'], covers: ['source-support'] },
          { id: 'review', execution: 'human', covers: ['semantic-review'] },
          { id: 'remote', execution: 'remote', covers: ['remote-check'] },
        ],
      }, ...additional] },
      gates: { commands: { 'docs-links': 'node "scripts/check docs.mjs"' } },
    }),
    'docs/changes.md': '# Policy\n',
    'docs/deleted.md': '# Retired\n',
    'docs-old/unmapped.md': '# Neighbour\n',
    'docs/private/notes.md': '# Private\n',
    'src/rate.mjs': 'export const rate = 1;\n',
    'test/rate.test.mjs': 'import { rate } from "../src/rate.mjs";\nexport { rate };\n',
    'scripts/check docs.mjs': 'throw new Error("must never run during selection");\n',
  };
  for (const [path, bytes] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), bytes);
  }
  await git(['init', '-q'], { cwd: root });
  await git(['add', '.'], { cwd: root });
  await git(['commit', '-qm', 'initial'], { cwd: root });
  const select = async (mode = '--changed', scope = 'docs') => {
    const result = await simt(['verify', 'select', mode, '--scope', scope, '--json'], { cwd: root });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout);
  };
  return { root, select };
}

test('repo selection plans staged document checks and shows independent, unavailable and semantic obligations', async () => {
  const { root, select } = await localRepository();
  assert.equal((await select()).selection.status, 'no-op');
  const path = 'docs/changes.md';
  await writeFile(join(root, path), '# Policy\n\n[Link](deleted.md)\n\nsources: [deleted.md]\n');
  await git(['add', path], { cwd: root });
  await writeFile(join(root, path), '# Working draft\n');
  const staged = await select('--staged');
  const worktree = await select();
  assert.deepEqual(staged.selection.changed, [path]);
  assert.equal(staged.basis, 'staged');
  assert.equal(staged.executed, false);
  assert.equal(staged.selection.claimsGreen, false);
  assert.ok(staged.selection.selected.document.includes('legacy-validator-1'));
  const declared = staged.checks.find(({ id }) => id === 'link-a');
  assert.deepEqual(declared.argv, ['node', 'scripts/check docs.mjs']);
  assert.equal(declared.provider, 'same');
  assert.equal(declared.cwd, await realpath(root));
  assert.ok(staged.selection.unverified.some(({ reason }) => reason === 'insufficient-independent-validators'));
  assert.ok(staged.selection.unverified.some(({ reason }) => reason === 'missing-executable'));
  assert.ok(staged.selection.unverified.some(({ reason }) => reason === 'human-review-required'));
  assert.ok(!worktree.obligations.some(({ kind }) => kind === 'links' || kind === 'source-support'));
});

test('repo selection preserves source closure and surfaces rename, deletion and an unmapped sibling', async () => {
  const { root, select } = await localRepository();
  await git(['mv', 'docs/changes.md', 'docs/new name.md'], { cwd: root });
  await git(['rm', '-q', 'docs/deleted.md'], { cwd: root });
  await writeFile(join(root, 'src/rate.mjs'), 'export const rate = 2;\n');
  await writeFile(join(root, 'docs-old/unmapped.md'), '# Changed neighbour\n');
  await writeFile(join(root, 'docs/private/notes.md'), '# Changed private note\n');
  const result = await select();
  assert.deepEqual(result.sourceTests, ['test/rate.test.mjs']);
  assert.ok(result.selection.selected.document.includes('legacy-validator-1'));
  assert.deepEqual(result.renames, [{ from: 'docs/changes.md', to: 'docs/new name.md' }]);
  assert.deepEqual(result.deleted, ['docs/deleted.md']);
  assert.deepEqual(result.pending, [{ path: 'docs-old/unmapped.md', reason: 'unmapped-path' }]);
  assert.equal(result.omitted, 1);
  assert.doesNotMatch(JSON.stringify(result), /private\/notes/);
});

test('ambiguous scope and remote obligations stay unverified', async () => {
  const { root, select } = await localRepository([
    { id: 'one', paths: ['docs/ambiguous/a?'], kind: 'document' },
    { id: 'two', paths: ['docs/ambiguous/a*'], kind: 'document' },
    { id: 'remote-scope', paths: ['remote'], kind: 'remote-object',
      checks: [{ id: 'external', execution: 'remote', covers: ['remote-check'] }] },
  ]);
  await mkdir(join(root, 'docs/ambiguous/a1'), { recursive: true });
  await writeFile(join(root, 'docs/ambiguous/a1/memo.md'), '# Unowned\n');
  await mkdir(join(root, 'remote'), { recursive: true });
  await writeFile(join(root, 'remote/task.json'), '{}\n');
  const result = await select('--changed', 'remote-scope');
  assert.ok(result.pending.some(({ reason }) => reason === 'ambiguous-scope'));
  assert.ok(result.selection.unverified.some(({ reason }) => reason === 'remote-check-unavailable-locally'));
  assert.deepEqual(result.selection.selected.remote, []);
});

test('unknown paths do not expand to a similarly named scope', () => {
  const chosen = selectVerification({
    changed: ['docs-old/other.md'],
    validators: [{ id: 'docs', class: 'document', scope: ['docs'] }],
  });
  assert.deepEqual(chosen.selected.document, []);
});
