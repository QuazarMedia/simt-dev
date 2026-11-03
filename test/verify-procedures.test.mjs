// Plan 0004 W26: recipe and procedure contracts.
//
// The fixtures are shaped like a repository that owns its procedures in its own annotations: a
// recipe decorated with `@not_idempotent`, `@mutates` and `@graduated`, a runbook that lists its
// steps and also contains a `def`, and a prose reference page. What the suite pins: the three
// flags survive verbatim, an orchestration is not one callable function, unparsed prose is
// counted rather than guessed at, and a fallback that returns the right object without the
// right privacy is rejected.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  PROCEDURE_KINDS,
  PROCEDURES_SCHEMA_VERSION,
  checkProcedures,
  readProcedure,
  selectFallback,
} from '../src/verify/procedures.mjs';

const RECIPE = [
  '# @recipe create-rate',
  '# @input rate:number',
  '# @output docs/de/rates.md',
  '# @imports src/knowledge/claims.mjs',
  '# @actor writer',
  '# @flag rates_v2',
  '# @effect remote-write:billing',
  '# @not_idempotent',
  '# @mutates',
  '# @graduated helper:create',
  '# @postcondition docs/de/rates.md contains 19',
  'def create_rate(rate):',
  '    total = rate * 2',
  '    return total',
].join('\n');

const ORCHESTRATION = [
  '# @kind orchestration',
  '# @step read the bulletin',
  '# @step write the rate',
  '# @calls create-rate',
  'def run():',
  '    return read() + write()',
].join('\n');

const REFERENCE = ['# Rates reference', '', 'The standard rate is 19 per cent.', '', '## Notes', '', 'This section is prose and is not parsed.'].join('\n');

test('the adapter names three kinds and its own version', () => {
  assert.equal(PROCEDURES_SCHEMA_VERSION, 1);
  assert.deepEqual(PROCEDURE_KINDS, ['reference', 'recipe', 'orchestration']);
});

test('the local flags survive verbatim', () => {
  const record = readProcedure(RECIPE, { path: 'recipes/create_rate.py' });
  assert.equal(record.id, 'create-rate');
  assert.equal(record.kind, 'recipe');
  assert.equal(record.idempotent, false, '@not_idempotent was softened');
  assert.equal(record.mutates, true);
  assert.equal(record.graduated, 'helper:create');
  assert.deepEqual(record.inputs, [{ name: 'rate', type: 'number' }]);
  assert.deepEqual(record.outputs, ['docs/de/rates.md']);
  assert.deepEqual(record.actors, ['writer']);
  assert.deepEqual(record.effects, [{ kind: 'remote-write', target: 'billing' }]);
  assert.deepEqual(record.postconditions, ['docs/de/rates.md contains 19']);
  assert.deepEqual(record.problems, []);
});

test('an orchestration is not a single callable function, even with a def in it', () => {
  const record = readProcedure(ORCHESTRATION, { path: 'runbooks/publish.py' });
  assert.equal(record.kind, 'orchestration');
  assert.equal(record.callable, false, 'the runbook was treated as one callable');
  assert.deepEqual(record.steps, ['read the bulletin', 'write the rate']);
  assert.deepEqual(record.calls, ['create-rate']);
});

test('a recipe with a definition is callable; a reference page is not', () => {
  assert.equal(readProcedure(RECIPE).callable, true);
  const reference = readProcedure(REFERENCE, { path: 'docs/rates.md' });
  assert.equal(reference.kind, 'reference');
  assert.equal(reference.callable, false);
  assert.equal(reference.id, null);
});

test('unsupported prose stays unparsed and the coverage reports it', () => {
  const reference = readProcedure(REFERENCE);
  assert.ok(reference.unparsed.length >= 4, JSON.stringify(reference.unparsed));
  for (const entry of reference.unparsed) {
    assert.equal(entry.reason, 'prose');
    assert.ok(entry.line > 0);
  }
  assert.ok(reference.coverage.fraction < 1);
  assert.equal(reference.coverage.parsed + reference.coverage.unparsed, reference.coverage.total);
  // Nothing in the prose was turned into an annotation.
  assert.deepEqual(reference.outputs, []);
  assert.equal(reference.idempotent, null);
});

test('a missing import, a cycle and impossible prerequisites are all problems with remedies', () => {
  const a = readProcedure('# @recipe a\n# @imports src/missing.mjs\n# @calls b\ndef a():\n    return 1');
  const b = readProcedure('# @recipe b\n# @calls a\ndef b():\n    return 1');
  const impossible = readProcedure('# @recipe c\n# @prerequisite flag:rates_v2\n# @prerequisite flag:!rates_v2\ndef c():\n    return 1');

  const report = checkProcedures([a, b, impossible], { files: ['src/knowledge/claims.mjs'] });
  assert.equal(report.ok, false);
  const codes = report.problems.map((entry) => entry.code);
  assert.ok(codes.includes('missing-import'));
  assert.ok(codes.includes('cycle'));
  assert.ok(codes.includes('impossible-prerequisites'));
  for (const entry of report.problems) assert.ok(entry.remedy.length > 10, `${entry.code} has no remedy`);
  assert.match(report.problems.find((entry) => entry.code === 'missing-import').detail, /src\/missing\.mjs/);
  assert.match(report.problems.find((entry) => entry.code === 'cycle').detail, /a -> b -> a/);
});

test('an effect that mutates must be declared as one', () => {
  const undeclared = readProcedure('# @recipe publish\n# @effect publish:rates\ndef publish():\n    return 1');
  assert.deepEqual(undeclared.problems.map((entry) => entry.code), ['undocumented-mutation']);
  assert.match(undeclared.problems[0].remedy, /@mutates/);

  const declared = readProcedure('# @recipe publish\n# @mutates\n# @effect publish:rates\ndef publish():\n    return 1');
  assert.deepEqual(declared.problems, []);
  assert.equal(declared.mutates, true);
});

test('a call to a procedure nobody declares is a problem, not a silent edge', () => {
  const report = checkProcedures([readProcedure('# @recipe a\n# @calls invented\ndef a():\n    return 1')]);
  assert.deepEqual(report.problems.map((entry) => entry.code), ['missing-procedure']);
  assert.match(report.problems[0].remedy, /declare invented/);
});

test('a fallback is chosen for privacy, not for the shape of its return value', () => {
  const candidates = [
    { id: 'ui-fallback', returns: 'dict', privacy: { implemented: [] } },
    { id: 'service-call', returns: 'dict', privacy: { implemented: ['tenant-isolation'] } },
  ];
  const chosen = selectFallback(candidates, { returns: 'dict', privacy: ['tenant-isolation'] });
  assert.equal(chosen.chosen, 'service-call');
  assert.deepEqual(chosen.rejected, [{ id: 'ui-fallback', reason: 'privacy-unsatisfied', missing: ['tenant-isolation'] }]);

  const none = selectFallback([{ id: 'ui-fallback', returns: 'dict', privacy: { implemented: [] } }], { returns: 'dict', privacy: ['tenant-isolation'] });
  assert.equal(none.chosen, null);
  assert.equal(none.rejected[0].reason, 'privacy-unsatisfied');

  const wrongType = selectFallback([{ id: 'other', returns: 'str', privacy: { implemented: ['tenant-isolation'] } }], { returns: 'dict' });
  assert.deepEqual(wrongType.rejected, [{ id: 'other', reason: 'returns-mismatch' }]);
});

test('reading is deterministic, and the module reads nothing itself', async () => {
  assert.deepEqual(readProcedure(RECIPE), readProcedure(RECIPE));
  assert.deepEqual(checkProcedures([readProcedure(RECIPE)]), checkProcedures([readProcedure(RECIPE)]));
  const source = await readFile(new URL('../src/verify/procedures.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:fs|node:net|fetch\(|process\.env|Date\.|Math\.random/);
});
