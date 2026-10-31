// The decisions index is rendered, not authored (review 0003 Q91).
//
// A hand-written table of 117 records agreed with them until it did not, and nothing
// read it, so nothing noticed. This test is the reader: it renders the same document
// the command writes and compares it byte for byte.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { renderDecisionsIndex } from '../src/decisions/index-doc.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = fileURLToPath(new URL('../bin/simt.mjs', import.meta.url));

test('the decisions index is the records, rendered - not a table somebody kept', async () => {
  const { stdout } = await promisify(execFile)('node', [BIN, 'rules', 'decisions', '--json', '--root', ROOT], { maxBuffer: 32 << 20 });
  const rows = JSON.parse(stdout).decisions;
  assert.ok(rows.length > 100, `only ${rows.length} records were read`);
  const actual = await readFile(new URL('../docs/decisions-index.md', import.meta.url), 'utf8');
  assert.equal(actual, renderDecisionsIndex(rows), 'the index disagrees with the records; run: simt rules decisions --yes');
});
