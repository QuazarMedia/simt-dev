// The command reference and the front page (review 0003 Q90).
//
// A generated reference is worth nothing unless something fails when the rendered bytes and
// the files on disk disagree — that is the whole difference between a generator and a
// script somebody ran once. The README is checked for the two properties that made it
// unreadable: it must stay short, and every link it carries must resolve.
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { SPEC } from '../src/commands/spec.mjs';
import {
  BEGIN,
  END,
  renderCommandBlock,
  renderCommandPages,
  renderReferencePages,
} from '../src/docs/commands.mjs';

const exec = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const README = join(ROOT, 'README.md');
const BIN = fileURLToPath(new URL('../bin/simt.mjs', import.meta.url));

test('docs/commands is exactly what the spec renders', async () => {
  const pages = renderCommandPages();
  const onDisk = new Set((await readdir(join(ROOT, 'docs/commands'))).map((name) => `docs/commands/${name}`));
  assert.deepEqual([...onDisk].sort(), [...pages.keys()].sort(), 'run: simt docs commands --yes');
  for (const [path, text] of renderReferencePages()) {
    assert.equal(await readFile(join(ROOT, path), 'utf8'), text, `${path} is stale: run simt docs commands --yes`);
  }
  for (const [path, text] of pages) {
    assert.equal(await readFile(join(ROOT, path), 'utf8'), text, `${path} is stale: run simt docs commands --yes`);
  }
});

test('every command the spec declares appears in its group page', async () => {
  const pages = renderCommandPages();
  const missing = SPEC.filter((row) => {
    const group = row.path.split(' ')[0];
    return !pages.get(`docs/commands/${group}.md`).includes(`simt ${row.path}`);
  }).map((row) => row.path);
  assert.deepEqual(missing, [], 'commands absent from the reference');
});

test('the index carries the flat list, so a reader who knows the name lands there', () => {
  const index = renderCommandPages().get('docs/commands/README.md');
  assert.ok(index.includes(BEGIN) && index.includes(END), 'the index carries the rendered list');
  assert.equal(index.slice(index.indexOf(BEGIN), index.indexOf(END) + END.length), renderCommandBlock());
});

test('a summary is one line, because every page is one row per command', () => {
  const broken = SPEC.filter((row) => row.summary.includes('\n')).map((row) => row.path);
  assert.deepEqual(broken, []);
});

test('the README stays short enough to be a front page', async () => {
  const text = await readFile(README, 'utf8');
  const lines = text.split('\n').length;
  assert.ok(lines <= 150, `README.md is ${lines} lines; the reference belongs in docs/commands/`);
});

test('every relative link in the README resolves', async () => {
  const text = await readFile(README, 'utf8');
  const targets = [...text.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)]
    .map((m) => m[1])
    .filter((href) => !/^[a-z]+:/i.test(href));
  const broken = [];
  for (const href of targets) {
    try {
      await stat(join(dirname(README), href));
    } catch {
      broken.push(href);
    }
  }
  assert.deepEqual(broken, [], 'the README links to files that are not there');
});

test('docs commands previews without --yes and writes with it', async () => {
  // A writer is behaviour, not a rendering: the plan has to be the bytes `--yes` would
  // write, and a run without the flag has to leave the tree exactly as it found it.
  const dir = await mkdtemp(join(tmpdir(), 'simt-docs-'));
  try {
    const first = await exec('node', [BIN, 'docs', 'commands'], { cwd: dir });
    assert.match(first.stdout, /plan {2}docs\/commands/);
    await assert.rejects(stat(join(dir, 'docs', 'commands', 'README.md')));

    await exec('node', [BIN, 'docs', 'commands', '--yes'], { cwd: dir });
    const written = await readFile(join(dir, 'docs', 'commands', 'README.md'), 'utf8');
    assert.equal(written, renderCommandPages().get('docs/commands/README.md'));

    const again = await exec('node', [BIN, 'docs', 'commands'], { cwd: dir });
    assert.match(again.stdout, /current {2}docs\/commands/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a page that is not there yet is created, not refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'simt-docs-'));
  try {
    await writeFile(join(dir, 'README.md'), '# t\n');
    const run = await exec('node', [BIN, 'docs', 'commands', '--yes'], { cwd: dir });
    assert.match(run.stdout, /write {2}docs\/commands/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
