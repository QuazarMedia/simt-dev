// `simt knowledge impact` in text mode (found 2026-11-06 while authoring the simt-echo
// knowledge inputs).
//
// `impactReport` returns `affected` as a bucket object ({claims, artifacts, ...}), and the
// text renderer iterated it as a list - `for (const entry of {...})` - so the door that
// `--json` answered fine crashed with "object is not iterable" the moment a person read it.
// The regression pins both directions: the bucket object renders, and the legacy flat list
// still does.

import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { knowledgeCommand, renderKnowledge } from '../src/commands/knowledge.mjs';
import { tempDir, capture } from './fixture.mjs';

const GRAPH = {
  nodes: [
    { id: 'src:a', kind: 'source' },
    { id: 'claim:c', kind: 'claim' },
  ],
  edges: [{ from: 'src:a', kind: 'supports', to: 'claim:c', status: 'reviewed' }],
};

async function inputWith(root) {
  const input = join(root, 'impact.json');
  await writeFile(input, JSON.stringify({ graph: GRAPH, change: { refs: [] } }));
  return input;
}

test('text mode renders the affected bucket object instead of crashing', async () => {
  const root = await tempDir('knowledge-impact-');
  const input = await inputWith(root);
  const result = await capture(() => knowledgeCommand('impact', [], { root, input, refs: 'src:a' }));
  assert.equal(result.code, 0, `text mode refused the bucket object: ${result.stderr}`);
  assert.match(result.stdout, /^claims\s+claim:c$/m, 'the reached claim renders under its bucket');
  assert.match(result.stdout, /src:a/, 'the changed ref is named');
});

test('the legacy flat reached list still renders under `affected`', () => {
  const text = renderKnowledge({
    command: 'knowledge impact',
    change: { refs: ['src:a'] },
    affected: ['claim:c', 'claim:d'],
  });
  assert.match(text, /^affected\s+claim:c$/m);
  assert.match(text, /^affected\s+claim:d$/m);
});

test('empty buckets render nothing between the refs line and the footers', () => {
  const text = renderKnowledge({
    command: 'knowledge impact',
    change: { refs: ['src:a'] },
    affected: { claims: [], artifacts: [], other: [] },
  });
  assert.equal(text.split('\n').length, 1, 'an empty change is one line, not padding');
});

test('a ref the graph does not hold is reported unknown, not fatal', async () => {
  const root = await tempDir('knowledge-impact-unknown-');
  const input = await inputWith(root);
  const result = await capture(() => knowledgeCommand('impact', [], { root, input, refs: 'src:missing' }));
  assert.equal(result.code, 0, `unknown ref crashed text mode: ${result.stderr}`);
  assert.match(result.stdout, /src:missing.*not-in-graph/, 'the gap is named with its reason');
});
