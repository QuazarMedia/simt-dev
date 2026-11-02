// Session transcript attribution (review 0003 Q92).
//
// `measure/session.mjs` splits a local Claude Code or Codex transcript into rules, file reads
// and tool output for `simt tokens --session`. The token suite reaches it through the command,
// so what was never tested directly is the split itself: which byte went where, and the
// refusal that keeps a transcript on the machine (ADR-075).
//
// The fixtures are transcripts, not repositories: this is arithmetic over records, and the
// properties worth pinning are that every byte lands in exactly one bucket and that a
// rule file read counts as rules rather than as a file read.

import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { measureSession } from '../src/measure/session.mjs';
import { tempDir } from './fixture.mjs';

const MB = (n) => 'x'.repeat(n);

async function transcript(lines) {
  const dir = await tempDir('session-');
  const path = join(dir, 'session.jsonl');
  await writeFile(path, lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n'));
  return path;
}

test('no path and a remote URL are refused before anything is read', async () => {
  const empty = await measureSession('  ');
  assert.equal(empty.ok, false);
  assert.match(empty.error, /requires a local transcript path/);

  const remote = await measureSession('https://example.com/session.jsonl');
  assert.equal(remote.ok, false);
  // The refusal is the ruling: a transcript is read locally only (ADR-075).
  assert.match(remote.error, /remote URLs are refused/);
});

test('a missing file and a malformed one are reported, not thrown', async () => {
  const missing = await measureSession('/nonexistent/session.jsonl');
  assert.equal(missing.ok, false);
  assert.match(missing.error, /cannot read session transcript/);

  const broken = await measureSession(await transcript(['{not json']));
  assert.equal(broken.ok, false);
  assert.match(broken.error, /invalid JSON\/JSONL session transcript/);
});

test('a system turn is rules, a rule file read is rules, a source read is a file read, a shell is tool output', async () => {
  const path = await transcript([
    { type: 'system', content: MB(40) },
    { type: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'Read', input: { file_path: 'AGENTS.md' } }] },
    { type: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: MB(10) }] },
    { type: 'assistant', content: [{ type: 'tool_use', id: 'b', name: 'Read', input: { file_path: 'src/keep.mjs' } }] },
    { type: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', content: MB(20) }] },
    { type: 'assistant', content: [{ type: 'tool_use', id: 'c', name: 'Bash', input: { command: 'ls' } }] },
    { type: 'user', content: [{ type: 'tool_result', tool_use_id: 'c', content: MB(30) }] },
  ]);
  const measured = await measureSession(path);
  assert.equal(measured.ok, true);
  assert.equal(measured.rules.bytes, 50);
  assert.equal(measured.fileReads.bytes, 20);
  assert.equal(measured.toolOutput.bytes, 30);
  assert.equal(measured.total.bytes, 100);
  assert.equal(measured.rules.items, 2);
});

test('every byte lands in exactly one bucket, and the shares are of the total', async () => {
  const path = await transcript([
    { type: 'system', content: MB(25) },
    { type: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'Read', input: { path: 'CLAUDE.md' } }] },
    { type: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: MB(25) }] },
  ]);
  const measured = await measureSession(path);
  const sum = measured.rules.bytes + measured.fileReads.bytes + measured.toolOutput.bytes;
  assert.equal(sum, measured.total.bytes);
  for (const bucket of [measured.rules, measured.fileReads, measured.toolOutput]) {
    assert.ok(Number.isInteger(bucket.share) && bucket.share >= 0 && bucket.share <= 100);
    assert.equal(bucket.tokens, Math.ceil(bucket.bytes / 4), `token count is not the shared estimator for ${bucket.bytes} bytes`);
  }
});

test('an explicit category wins over the shape of the record', async () => {
  // A harness that already labelled a record says what it is; guessing from the shape would
  // put a labelled rule read into tool output.
  const path = await transcript([
    { category: 'rules', text: MB(12) },
    { category: 'file_read', path: 'AGENTS.md', text: MB(8) },
    { category: 'file_read', path: 'src/a.mjs', text: MB(4) },
    { category: 'tool_output', text: MB(6) },
  ]);
  const measured = await measureSession(path);
  assert.equal(measured.rules.bytes, 20);
  assert.equal(measured.fileReads.bytes, 4);
  assert.equal(measured.toolOutput.bytes, 6);
});

test('a Codex function call names the file its output belongs to', async () => {
  const path = await transcript([
    { type: 'function_call', call_id: 'f1', name: 'read_file', arguments: JSON.stringify({ path: 'AGENTS.md' }) },
    { type: 'function_call_output', call_id: 'f1', output: MB(18) },
    { type: 'function_call', call_id: 'f2', name: 'read_file', arguments: JSON.stringify({ path: 'docs/decisions/ADR-001.md' }) },
    { type: 'function_call_output', call_id: 'f2', output: MB(5) },
    { type: 'function_call', call_id: 'f3', name: 'shell', arguments: '{"command":["bash","-lc","ls"]}' },
    { type: 'function_call_output', call_id: 'f3', output: MB(9) },
  ]);
  const measured = await measureSession(path);
  // A rule file read is rules; a decision record is a file like any other, so it is a read.
  assert.equal(measured.rules.bytes, 18);
  assert.equal(measured.fileReads.bytes, 5);
  assert.equal(measured.toolOutput.bytes, 9);
});

test('an empty transcript measures zero rather than failing', async () => {
  const measured = await measureSession(await transcript([]));
  assert.equal(measured.ok, true);
  assert.equal(measured.total.bytes, 0);
  assert.equal(measured.rules.share, 0);
});
