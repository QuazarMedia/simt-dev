// Plan 0004 W27: obligation-aware incremental gate selection.
//
// What this suite pins is mostly what the selection refuses: a no-opt-in repository keeps its
// existing import closure, a clean diff is a no-op rather than an empty pass, a non-empty opted-in
// change with no admissible validator is `unverified` and never green, an independence
// requirement is not satisfied by two cheap validators from one provider, an unknown dependency
// expands only to the declared scope, and a Git hook cannot run a remote validator.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

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

test('a Git hook cannot run a remote validator; `simt verify run` can', () => {
  const hook = checkVerifyRun({ invocation: 'git-hook', selected: { remote: ['remote-check'] } });
  assert.equal(hook.ok, false);
  assert.equal(hook.code, 'remote-from-hook');
  assert.match(hook.remedy, /simt verify run/);
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
