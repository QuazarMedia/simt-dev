// The README's command list, held to the spec (review 0003 Q60).
//
// The list is rendered rather than written by hand, which is worth nothing unless
// something fails when the rendered bytes and the file disagree - that is the whole
// difference between a generator and a script somebody ran once.
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { SPEC } from '../src/commands/spec.mjs';
import { BEGIN, END, renderCommandBlock, replaceBlock } from '../src/docs/commands.mjs';

const exec = promisify(execFile);
const README = fileURLToPath(new URL('../README.md', import.meta.url));
const BIN = fileURLToPath(new URL('../bin/simt.mjs', import.meta.url));

test('the README command list is what the spec renders', async () => {
  const text = await readFile(README, 'utf8');
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  assert.ok(start !== -1 && end > start, `README.md carries no ${BEGIN} ... ${END} region`);
  assert.equal(
    text.slice(start, end + END.length),
    renderCommandBlock(),
    'README.md is stale: run `simt docs readme --yes`',
  );
});

test('every command the spec declares appears in the rendered list', () => {
  const block = renderCommandBlock();
  const missing = SPEC.filter((row) => !block.includes(`simt ${row.path}`)).map((row) => row.path);
  assert.deepEqual(missing, [], 'commands absent from the README list');
});

test("a row's summary is one line, because the list is one line per command", () => {
  const broken = SPEC.filter((row) => row.summary.includes('\n')).map((row) => row.path);
  assert.deepEqual(broken, []);
});

test('a README without the markers is refused rather than appended to', () => {
  assert.equal(replaceBlock('no markers here', 'block'), null);
  assert.equal(replaceBlock(`a\n${BEGIN}\nold\n${END}\nb`, 'new'), `a\nnew\nb`);
});

test('docs readme previews without --yes and writes with it', async () => {
  // A writer is behaviour, not a rendering: the plan has to be the bytes `--yes` would
  // write, and a run without the flag has to leave the file exactly as it found it.
  const dir = await mkdtemp(join(tmpdir(), 'simt-docs-'));
  try {
    const file = join(dir, 'README.md');
    const start = `# t\n\n${BEGIN}\n${END}\n`;
    await writeFile(file, start);
    const preview = await exec('node', [BIN, 'docs', 'readme'], { cwd: dir });
    assert.match(preview.stdout, /plan {2}README\.md/);
    assert.equal(await readFile(file, 'utf8'), start, 'a preview wrote');

    await exec('node', [BIN, 'docs', 'readme', '--yes'], { cwd: dir });
    const text = await readFile(file, 'utf8');
    assert.equal(text.slice(text.indexOf(BEGIN), text.indexOf(END) + END.length), renderCommandBlock());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
