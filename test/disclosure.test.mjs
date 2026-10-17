// The disclosure index names what the region deliberately does not contain (ADR-085).
//
// A skill's body in this file would undo the index, so the assertion that matters is the
// absence. The description stays, because that is the trigger a reader matches against
// before it opens the file.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { desiredRegion } from '../src/projection/rules.mjs';

const BODY = 'The body sentence that must stay out of the region.';

async function repo() {
  const root = await mkdtemp(join(tmpdir(), 'simt-disclosure-'));
  await mkdir(join(root, '.agents', 'skills', 'widget'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{ "name": "x" }\n');
  await writeFile(
    join(root, '.agents', 'skills', 'widget', 'SKILL.md'),
    `---\nname: widget\ndescription: >-\n  Open this when editing a widget\n  and not before.\n---\n\n# Widget\n\n${BODY}\n`,
  );
  return root;
}

test('a skill contributes its name and its trigger, and the body stays in its file', async () => {
  const root = await repo();
  const desired = await desiredRegion(root, { surfaces: 'cursor' });
  assert.match(desired.body, /## Disclosure/);
  assert.match(desired.body, /- widget — Open this when editing a widget and not before\./);
  assert.equal(desired.body.includes(BODY), false);
  const headings = [...desired.body.matchAll(/^## .+$/gm)].map((m) => m[0]);
  assert.equal(headings.at(-1), '## Disclosure');
  await rm(root, { recursive: true, force: true });
});

test('a kernel ends on the same index', async () => {
  const root = await repo();
  await writeFile(join(root, 'simt.json'), '{ "mode": "kernel" }\n');
  const desired = await desiredRegion(root, { surfaces: 'cursor' });
  assert.equal(desired.mode, 'kernel');
  assert.equal(desired.body.includes(BODY), false);
  const headings = [...desired.body.matchAll(/^## .+$/gm)].map((m) => m[0]);
  assert.equal(headings.at(-1), '## Disclosure');
  await rm(root, { recursive: true, force: true });
});

test('a symlink fan-out is one skill', async () => {
  const root = await repo();
  await mkdir(join(root, '.cursor', 'skills'), { recursive: true });
  await symlink(join(root, '.agents', 'skills', 'widget'), join(root, '.cursor', 'skills', 'widget'));
  const desired = await desiredRegion(root, { surfaces: 'cursor' });
  const lines = desired.body.split('\n').filter((line) => line.startsWith('- widget'));
  assert.deepEqual(lines, ['- widget — Open this when editing a widget and not before.']);
  await rm(root, { recursive: true, force: true });
});

test('two different files that share a name are both named', async () => {
  const root = await repo();
  await mkdir(join(root, '.claude', 'skills', 'widget'), { recursive: true });
  await writeFile(
    join(root, '.claude', 'skills', 'widget', 'SKILL.md'),
    '---\nname: widget\ndescription: Open this when the other widget is the one in play and the first is not.\n---\n\n# Other\n\nA second body.\n',
  );
  const desired = await desiredRegion(root, { surfaces: 'cursor' });
  assert.match(desired.body, /- widget \(\.agents\/skills\) — Open this when editing a widget/);
  assert.match(desired.body, /- widget \(\.claude\/skills\) — Open this when the other widget/);
  assert.equal(desired.body.includes('A second body.'), false);
  await rm(root, { recursive: true, force: true });
});

test('a skill with no description says so, and names the command that shows it', async () => {
  const root = await repo();
  await writeFile(
    join(root, '.agents', 'skills', 'widget', 'SKILL.md'),
    '---\nname: widget\n---\n\n# Widget\n\nNo trigger was written.\n',
  );
  const desired = await desiredRegion(root, { surfaces: 'cursor' });
  assert.match(desired.body, /- widget — no description, so nothing says when to open it\. Show it with: simt skills show widget/);
  assert.equal(desired.body.includes('No trigger was written.'), false);
  await rm(root, { recursive: true, force: true });
});
