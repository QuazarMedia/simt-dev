// Plan 0004 W11: a task carries a vector of intents, and routing grants nothing.
//
// The failures pinned here are one per kind of overreach. "Fix the docs" is a bugfix to the
// old label and a document correction to the vector, and a client reading either must get
// the truth it asked for. "Document the API mutation" needs the state observed and must not
// acquire the right to change it. A reachable operation id routes to `operate` without
// deciding whether the task observes or performs it. And nothing this module returns is a
// permission, which is asserted against the serialized result rather than promised in a
// comment.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  INTENTS,
  INTENT_VERSION,
  OBLIGATIONS,
  classifyIntent,
  classifyTask,
  evaluateIntent,
} from '../src/brief/kind.mjs';

const CORPUS = [
  { task: 'Research the current German VAT rates', expect: 'research' },
  { task: 'Compare the two source documents', expect: 'research' },
  { task: 'Fix the docs typo on the Germany page', expect: 'generate' },
  { task: 'Regenerate the France landing page', expect: 'generate' },
  { task: 'Draft the New Zealand chapter', expect: 'generate' },
  { task: 'Validate the rates table against the source', expect: 'validate' },
  { task: 'Audit the Germany report for contradictions', expect: 'validate' },
  { task: 'Document the calculation mutation endpoint', expect: ['generate', 'operate'] },
  { task: 'Create a calculation through the REST endpoint', expect: 'operate' },
  { task: 'Run the provisioning recipe for tenant A', expect: 'operate' },
  { task: 'Implement caching in the index store', expect: 'change-code' },
  { task: 'Refactor the prefix matcher', expect: 'change-code' },
  { task: 'Add a test for the rename map', expect: 'change-code' },
  { task: 'Make it better', expect: [] },
];

test('the single label is unchanged beside the vector', () => {
  const routed = classifyIntent('Fix the docs typo');
  assert.equal(routed.version, INTENT_VERSION);
  assert.equal(routed.version, 2);
  assert.equal(routed.kind, classifyTask('Fix the docs typo').kind, 'the v1 answer changed under a v1 reader');
  assert.equal(routed.kind, 'bugfix');
  assert.deepEqual(routed.leaders, ['generate'], 'the vector reads the same sentence as a document correction');
  assert.ok(routed.obligations.includes('artifact:validate'));
  assert.equal(routed.obligations.includes('code:test'), false, 'a prose correction is not a code change');
  assert.ok(routed.reasons.some((reason) => /^generate: the task matches/.test(reason)));
});

test('documenting a mutation requires observation and never authorization', () => {
  const routed = classifyIntent('Document the API mutation');
  assert.deepEqual(routed.leaders, ['generate', 'operate']);
  assert.equal(routed.ambiguous, true);
  assert.ok(routed.obligations.includes('state:observe'), 'the state has to be observed to be documented');
  assert.equal(routed.obligations.includes('effect:authorize'), false, 'a document task does not perform the mutation');
  assert.ok(routed.obligations.includes('intent:discover'), 'a tie is routed to discovery rather than picked');
  assert.match(routed.reasons.join('\n'), /tied, so the task is routed to discovery/);
});

test('performing an operation requires authorization, and a requirement is not a grant', () => {
  const routed = classifyIntent('Create a calculation through the REST endpoint');
  assert.deepEqual(routed.leaders, ['operate']);
  assert.ok(routed.obligations.includes('state:observe'));
  assert.ok(routed.obligations.includes('effect:authorize'));
  assert.equal(Object.hasOwn(routed, 'effects'), false, 'routing invented an effects field');
  assert.equal(Object.hasOwn(routed, 'authorization'), false, 'routing invented an authorization field');
  assert.doesNotMatch(JSON.stringify(routed), /"allowed"|"authorized"\s*:\s*true/);
});

test('a declared operation id routes to operate without deciding observe or execute', () => {
  const routed = classifyIntent('look at calc.create', { operationIds: ['calc.create'] });
  assert.ok(routed.leaders.includes('operate'));
  assert.ok(routed.obligations.includes('state:observe'));
  assert.equal(routed.obligations.includes('effect:authorize'), false, 'naming an operation is not asking to run it');
  assert.ok(routed.reasons.some((reason) => /operation calc\.create is declared/.test(reason)));
});

test('a document path, a generator and plain source get different obligations', () => {
  const document = classifyIntent('Tidy the wording', { paths: ['Germany/rates.md'] });
  assert.deepEqual(document.leaders, ['generate']);
  assert.deepEqual(document.obligations, ['artifact:validate']);

  const generator = classifyIntent('Speed up the export', { paths: ['eval/render.mjs'] });
  assert.deepEqual(generator.leaders, ['change-code', 'generate']);
  assert.ok(generator.obligations.includes('code:test'), 'a generator is still code and its tests still run');
  assert.ok(generator.obligations.includes('artifact:regenerate'), 'what it generated is now stale');
  assert.ok(generator.obligations.includes('intent:discover'));
  assert.equal(generator.obligations.includes('artifact:validate'), false);

  const source = classifyIntent('Speed up parsing', { paths: ['src/app.mjs'] });
  assert.deepEqual(source.leaders, ['change-code']);
  assert.deepEqual(source.obligations, ['code:test']);
});

test('an unrecognisable task is routed to discovery instead of to a default', () => {
  const routed = classifyIntent('Make it better');
  assert.equal(routed.unknown, true);
  assert.deepEqual(routed.leaders, []);
  assert.deepEqual(routed.intents, []);
  assert.deepEqual(routed.obligations, ['intent:discover']);
  assert.match(routed.reasons.join('\n'), /nothing in the task or the paths chose an intent/);
});

test('an explicit override decides routing, is reported, and still grants nothing', () => {
  const routed = classifyIntent('Research the German rates', { override: 'validate' });
  assert.deepEqual(routed.leaders, ['validate']);
  assert.equal(routed.intents[0].intent, 'validate');
  assert.ok(routed.intents.some((entry) => entry.intent === 'research'), "the text's own reading is still reported");
  assert.ok(routed.obligations.includes('sources:read'), 'the override does not erase what the task asks for');
  assert.match(routed.reasons.join('\n'), /the caller's override chose validate/);
  assert.equal(routed.ambiguous, false);
  assert.equal(Object.hasOwn(routed, 'effects'), false);

  const zero = classifyIntent('Fix the bug', { override: 'research' });
  assert.deepEqual(zero.intents.map((entry) => entry.intent).includes('research'), true, 'an override names an intent even when nothing else did');

  assert.throws(() => classifyIntent('anything', { override: 'document' }), /override must be one of/);
});

test('the labelled corpus reports precision and recall per intent, and cannot hide a miss', () => {
  const report = evaluateIntent(CORPUS);
  assert.deepEqual(INTENTS, ['research', 'generate', 'validate', 'operate', 'change-code']);
  assert.equal(report.examples, CORPUS.length);
  assert.equal(report.perIntent.length, INTENTS.length);
  assert.equal(report.precision, 1, JSON.stringify(report.perIntent));
  assert.equal(report.recall, 1, JSON.stringify(report.perIntent));
  for (const row of report.perIntent) {
    assert.equal(typeof row.expected, 'number');
    assert.equal(typeof row.predicted, 'number');
  }
  assert.deepEqual(report.ambiguous, [{ task: 'Document the calculation mutation endpoint', between: ['generate', 'operate'] }]);
  assert.deepEqual(report.unknown, [{ task: 'Make it better' }]);

  // A corpus that never names an intent is not evidence about it: the denominator is zero
  // and the ratio is null rather than a flattering 1.
  const thin = evaluateIntent([{ task: 'Refactor the parser', expect: 'change-code' }]);
  const operateRow = thin.perIntent.find((row) => row.intent === 'operate');
  assert.equal(operateRow.precision, null);
  assert.equal(operateRow.recall, null);

  // And a wrong label is a miss the report shows, not one it averages away.
  const wrong = evaluateIntent([{ task: 'Research the German rates', expect: 'validate' }]);
  const researchRow = wrong.perIntent.find((row) => row.intent === 'research');
  const validateRow = wrong.perIntent.find((row) => row.intent === 'validate');
  assert.equal(researchRow.precision, 0, 'the prediction the label did not expect');
  assert.equal(researchRow.recall, null, 'no example expected research, so its recall is undefined');
  assert.equal(validateRow.recall, 0, 'the label the prediction did not cover');
  assert.equal(validateRow.precision, null, 'nothing predicted validate, so its precision is undefined');
});

test('routing is deterministic and reads no clock, environment or socket', async () => {
  const options = { paths: ['Germany/rates.md', 'eval/render.mjs'], artifactIds: ['de-rates'] };
  assert.deepEqual(classifyIntent('Update de-rates and validate it', options), classifyIntent('Update de-rates and validate it', options));

  const source = await readFile(new URL('../src/brief/kind.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /process\.env|Date\.|Math\.random|fetch\(|node:net|node:http/);
  assert.deepEqual([...OBLIGATIONS], [
    'intent:discover',
    'sources:read',
    'artifact:validate',
    'artifact:regenerate',
    'state:observe',
    'effect:authorize',
    'code:test',
  ]);
});
