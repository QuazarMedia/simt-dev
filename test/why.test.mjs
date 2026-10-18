// Governance (R25, ADR-093).
//
// An Affects line is prose. The tokens in backticks are the edges, including
// the ones that wrap onto the next line. A token that is not a path and not a
// command is reported, not dropped.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { whyCommand } from '../src/commands/why.mjs';
import {
  affectsTokens,
  matchGlob,
  resolveToken,
  scopePaths,
  sourceRoots,
} from '../src/index/govern.mjs';

const tick = String.fromCharCode(96);
const bt = (value) => tick + value + tick;
const commands = ['init', 'hooks run', 'check'];

test('why resolves an Affects token and names the decisions on the dispatcher', async () => {
  const text = [
    'Status: **accepted**',
    '',
    'Affects: ' + bt('simt-dev init') + ', ' + bt('simt-dev hooks run') + ',',
    bt('src/hooks/resolve.mjs') + ', the ' + bt('simt-dev') + ' CLI',
    '',
    '## Context',
    'Affects: ' + bt('not-this.mjs'),
  ].join('\n');
  assert.deepEqual(affectsTokens(text), ['simt-dev init', 'simt-dev hooks run', 'src/hooks/resolve.mjs', 'simt-dev']);

  const files = new Set([
    'src/hooks/dispatcher.mjs',
    'src/ci/workflow.mjs',
    'rules/core.md',
    'rules/mdc/test-gate.mdc',
  ]);
  const ctx = { files, commands: new Set(commands), roots: sourceRoots(files) };
  assert.deepEqual(resolveToken('simt-dev init', ctx), { kind: 'command', id: 'init' });
  assert.deepEqual(resolveToken('simt-dev hooks run', ctx), { kind: 'command', id: 'hooks run' });
  assert.deepEqual(resolveToken('simt-dev', ctx), { kind: 'unresolved', token: 'simt-dev' });
  assert.deepEqual(resolveToken('src/ci/workflow.mjs', ctx), { kind: 'paths', paths: ['src/ci/workflow.mjs'] });
  assert.deepEqual(resolveToken('hooks/dispatcher.mjs', ctx), { kind: 'paths', paths: ['src/hooks/dispatcher.mjs'] });
  const globbed = resolveToken('rules/mdc/*.mdc', ctx);
  assert.equal(globbed.kind, 'paths');
  assert.ok(globbed.paths.includes('rules/mdc/test-gate.mdc'));
  assert.equal(resolveToken('rules/*.md', ctx).paths.includes('rules/mdc/test-gate.mdc'), false);
  assert.deepEqual(resolveToken('missing.mjs', ctx), { kind: 'unresolved', token: 'missing.mjs' });
  assert.equal(matchGlob('src/**/*.mjs', 'src/hooks/dispatcher.mjs'), true);
  const open = String.fromCharCode(123);
  const close = String.fromCharCode(125);
  assert.equal(matchGlob('src/**/*.' + open + 'js,mjs' + close, 'src/a.js'), true);
  assert.deepEqual(scopePaths('---\nsimt-id: node\nsimt-applies: [node]\nsimt-scope: ["package.json", "**/*.mjs"]\n---\n'), ['package.json', '**/*.mjs']);

  const root = new URL('..', import.meta.url).pathname;
  const listed = await capture(() => whyCommand(['src/hooks/dispatcher.mjs'], { root }, commands));
  assert.equal(listed.code, 0);
  assert.match(listed.stdout, /decision {2}ADR-017 {2}A declared gate must be one the repo can actually run/);
  assert.match(listed.stdout, /decision {2}ADR-066 /);
  assert.match(listed.stdout, /decision {2}ADR-087 /);
  assert.match(listed.stdout, /gate {6}format /);
});

async function capture(run) {
  const chunks = [];
  const errors = [];
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  process.stderr.write = (chunk) => {
    errors.push(String(chunk));
    return true;
  };
  try {
    const code = await run();
    return { code, stdout: chunks.join(''), stderr: errors.join('') };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}
