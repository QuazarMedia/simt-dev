// Plan 0004 W52: consumer playbooks and release evidence.
//
// What the suite pins: every command a playbook tells a reader to run is a command that exists;
// every supported path has a playbook; and the playbooks say what is not supported rather than
// leaving a reader to discover it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { SPEC_PATHS } from '../src/commands/spec.mjs';

const playbooks = await readFile(new URL('../docs/playbooks.md', import.meta.url), 'utf8');

// Commands appear two ways: inline in prose, and as runnable lines inside a ```sh fence. Reading
// only the inline form counted a playbook with ten runnable commands as having two.
const inline = [...playbooks.matchAll(/`simt ([a-z][a-z-]*(?: [a-z][a-z-]*)?)/g)].map((match) => match[1]);
const fenced = [...playbooks.matchAll(/```sh\n([\s\S]*?)```/g)].flatMap((block) =>
  [...block[1].matchAll(/^simt ([a-z][a-z-]*(?: [a-z][a-z-]*)?)/gm)].map((match) => match[1]),
);
const documented = [...inline, ...fenced];

test('every documented command is a row in the command spec', () => {
  const known = new Set(SPEC_PATHS);
  const missing = [...new Set(documented)].filter((name) => !known.has(name) && !known.has(name.split(' ')[0]));
  assert.deepEqual(missing, [], `the playbooks tell a reader to run commands that do not exist: ${missing.join(', ')}`);
});

test('each supported path has a playbook with runnable commands', () => {
  for (const heading of ['Docs-only change', 'Mixed knowledge and scripts', 'API-authored change', 'UI-only operation', 'SSH-operated target']) {
    assert.match(playbooks, new RegExp(`## ${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), `${heading} has no playbook`);
  }
  assert.ok(documented.length >= 8, 'the playbooks name too few commands to be runnable');
});

test('the unsupported paths are stated, not left to be discovered', () => {
  for (const limitation of ['live pilot', 'Rollback of a remote effect', 'Exactly-once', 'model that decides policy']) {
    assert.match(playbooks.toLowerCase(), new RegExp(limitation.toLowerCase()), `${limitation} is not stated`);
  }
  assert.match(playbooks, /at-least-once/);
  assert.match(playbooks, /advisory/);
});

test('the playbooks read as instructions a consumer can follow', () => {
  assert.doesNotMatch(playbooks, /simt-dev\//, 'a playbook points at this repository by path');
  assert.doesNotMatch(playbooks, /npx |yarn |pnpm /, 'a playbook names a package runner');
  assert.match(playbooks, /simt gate --changed/);
});
