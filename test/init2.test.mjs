import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as gateModule from '../src/projection/manifest.mjs';
import * as gateTable from '../src/hooks/gates.mjs';
import { readCapability, declaredCommands } from '../src/hooks/capability.mjs';
import { git, cmd, tempDir } from './fixture.mjs';
import { CLI, MANIFEST_FILE, MANIFEST_LEGACY } from '../src/name.mjs';
import { packageVersion } from '../src/package-version.mjs';

const buildManifest = gateModule.buildManifest;

async function capture(run) {
  // Both streams. A trailing `next`/`hooks` line goes to stderr on purpose: it is
  // advice about what to do after this command, and a caller piping stdout to a file
  // should not find it there.
  const out = [];
  const err = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (c) => { out.push(String(c)); return true; };
  process.stderr.write = (c) => { err.push(String(c)); return true; };
  let code;
  try {
    code = await run();
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
  return { code, text: `${out.join('')}${err.join('')}` };
}


test('a repo-chosen projection sub-key is not a stale field, and the repair keeps it', async () => {
  const { syncCommand } = await import('../src/commands/sync.mjs');
  const { MANIFEST_COMMENT, manifestDrift } = await import('../src/projection/manifest.mjs');
  const { provenanceDigest } = await import('../src/projection/project.mjs');
  const root = await tempDir('simt-manifest-');
  const stack = ['node'];
  const sha = await provenanceDigest();
  const version = packageVersion();
  const base = {
    ...MANIFEST_COMMENT,
    id: 'r',
    stack,
    limits: { coverage: null, fileLines: { warn: 400, error: 1000 } },
    gates: { preCommit: [], prePush: [] },
    localSkills: [], profiles: [], substitutions: {}, surfaces: null,
  };
  const write = async (projection) =>
    writeFile(join(root, MANIFEST_FILE), `${JSON.stringify({ ...base, projection }, null, 2)}\n`);
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'x' }));

  // The setting alone, with every generated field correct: not drift.
  await write({ simtDevSha: sha, version, place: 'top' });
  assert.equal(await manifestDrift(root, stack, sha), null, 'a repo-chosen sub-key is not a stale field');

  // The setting with a stale stamp: the repair runs, and the setting survives it.
  await write({ simtDevSha: 'aaaaaaa', version, place: 'top' });
  assert.equal((await manifestDrift(root, stack, sha))?.status, 'stale-generated-field');
  const applied = await capture(() => syncCommand([], { root, yes: true }));
  assert.equal(applied.code, 0);
  const after = JSON.parse(await readFile(join(root, MANIFEST_FILE), 'utf8'));
  assert.deepEqual(after.projection, { simtDevSha: sha, version, place: 'top' });
  assert.equal(await manifestDrift(root, stack, sha), null, 'and the gate agrees the repair kept it');
});

// End to end: the repository opts into top placement - the remedy `check` names for
// a reader that stops before the region - and the region ends up below its own
// settings. `check` must see the position as drift and nothing else; `sync` must
// move the region back and settle.
test('a top-placed region that has moved down is drift, and sync moves it back', async () => {
  const { initCommand } = await import('../src/commands/init.mjs');
  const { checkCommand, syncCommand } = await import('../src/commands/sync.mjs');
  const root = await tempDir('simt-manifest-');
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'x' }));
  await capture(() => initCommand([], { root, yes: true }));

  const path = join(root, MANIFEST_FILE);
  const m = JSON.parse(await readFile(path, 'utf8'));
  m.projection.place = 'top';
  await writeFile(path, `${JSON.stringify(m, null, 2)}\n`);

  const agents = join(root, 'AGENTS.md');
  const text = await readFile(agents, 'utf8');
  const region = text.slice(text.indexOf('<!-- simt:begin -->'));
  await writeFile(agents, `# My Project\n\nHand-written settings.\n\n${region}`);

  // The manifest is not the problem - the old code reported `place` as a stale
  // generated field here - and the region's position is.
  const check = await capture(() => checkCommand([], { root }));
  assert.equal(check.code, 1);
  assert.match(check.text, /region is updated/);
  assert.doesNotMatch(check.text, /stale/i);

  const applied = await capture(() => syncCommand([], { root, yes: true }));
  assert.equal(applied.code, 0);
  const after = await readFile(agents, 'utf8');
  assert.ok(after.startsWith('<!-- simt:begin -->'), 'the region must be above the settings');
  assert.match(after, /Hand-written settings\./, 'the settings survive the move');
  assert.equal(JSON.parse(await readFile(path, 'utf8')).projection.place, 'top', 'the setting survives the run');

  // And it settles: the next check is green and the next sync finds nothing.
  assert.equal((await capture(() => checkCommand([], { root }))).code, 0);
  const again = await capture(() => syncCommand([], { root, yes: true }));
  assert.equal(again.code, 0);
  assert.match(again.text, /already current/);
});

test('sync repairs a reformatted manifest only once the repo ignores it', async () => {
  const { syncCommand } = await import('../src/commands/sync.mjs');
  const { manifestDrift, MANIFEST_COMMENT } = await import('../src/projection/manifest.mjs');
  const { provenanceDigest } = await import('../src/projection/project.mjs');
  const root = await tempDir('simt-manifest-');
  const stack = ['node'];
  // The stamp is this build's own digest, so the ONLY thing wrong with this manifest
  // is its bytes. A fixture sha of 'abc1234' would also be a stale generated field,
  // which sync is supposed to repair - so the test would be asserting the other branch.
  const sha = await provenanceDigest();
  // Every generated field correct, only the byte form a prettier hook produced.
  const bytes = [
    '{',
    `  "$comment": ${JSON.stringify(MANIFEST_COMMENT.$comment)},`,
    '  "id": "r",',
    '  "stack": ["node"],',
    '  "limits": {"coverage": null, "fileLines": {"warn": 400, "error": 1000}},',
    '  "gates": {"preCommit": [], "prePush": []},',
    '  "localSkills": [],',
    '  "profiles": [],',
    '  "substitutions": {},',
    '  "surfaces": null,',
    `  "projection": {"simtDevSha": "${sha}", "version": "${packageVersion()}"}`,
    '}',
    '',
  ].join('\n');
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'x' }));
  await writeFile(join(root, MANIFEST_FILE), bytes);
  assert.equal((await manifestDrift(root, stack, sha))?.status, 'reformatted');

  // While a formatter still owns the file, sync leaves it alone. Repairing here would
  // mean every `format` run rewrites a file the commit just wrote: a working tree that
  // is never clean.
  const untouched = await capture(() => syncCommand([], { root, yes: true }));
  assert.equal(untouched.code, 0);
  assert.equal(
    await readFile(join(root, MANIFEST_FILE), 'utf8'),
    bytes,
    'sync rewrote a file whose bytes a formatter still owns',
  );

  // The repository declares the file is not prose. That is the signal, read rather
  // than assumed - so lines that do not name the manifest must NOT count, including a
  // comment about generated files, which is the shape an operator writes first.
  for (const line of ['# generated files are not prose', 'node_modules/', '*.json']) {
    await writeFile(join(root, '.prettierignore'), `${line}\n`);
    await writeFile(join(root, MANIFEST_FILE), bytes);
    const run = await capture(() => syncCommand([], { root, yes: true }));
    assert.equal(run.code, 0);
    assert.equal(
      await readFile(join(root, MANIFEST_FILE), 'utf8'),
      bytes,
      `\`${line}\` is not a declaration about this one file, so sync must not rewrite it`,
    );
  }

  // Naming it is. Both spellings, because the legacy name is what a repository adopted
  // before the rename still has on disk.
  for (const line of [MANIFEST_FILE, MANIFEST_LEGACY]) {
    await writeFile(join(root, '.prettierignore'), `# generated files\n${line}\n`);
    await writeFile(join(root, MANIFEST_FILE), bytes);
    const run = await capture(() => syncCommand([], { root, yes: true }));
    assert.equal(run.code, 0);
    assert.notEqual(
      await readFile(join(root, MANIFEST_FILE), 'utf8'),
      bytes,
      `with ${line} in .prettierignore, sync must put simt-dev's bytes back`,
    );
    assert.equal(
      await manifestDrift(root, stack, sha),
      null,
      'and the gate must agree the manifest is now correct',
    );
  }

  // An unreadable `.prettierignore` is not an absent one. This assertion exists
  // because the first version of that read was `catch { return false }`, and a
  // ReferenceError from a missing import was swallowed by it and read as "this
  // repository has declared nothing" — silently, on every repository, forever. A
  // directory is the one unreadable shape a fixture can build on purpose; ENOENT is
  // the only absence, and it is still absence.
  await rm(join(root, '.prettierignore'), { force: true });
  await mkdir(join(root, '.prettierignore'), { recursive: true });
  await writeFile(join(root, MANIFEST_FILE), bytes);
  await assert.rejects(
    () => syncCommand([], { root, yes: true }),
    (error) => error.code === 'EISDIR',
    'an unreadable .prettierignore must surface, not read as "no declaration"',
  );
});

test('the remedy for a stale manifest field names the command that repairs it', async () => {
  // Two commands must not answer one question with different instructions
  // (ADR-050). `init` re-runs adoption - it tags, it branches - so naming it as the
  // remedy for one stale field is naming a command that does more than the reader
  // asked for, while naming the wrong one is naming a command that cannot help.
  const { manifestDrift } = await import('../src/projection/manifest.mjs');
  const root = await tempDir('simt-manifest-');
  await writeFile(join(root, MANIFEST_FILE), `${JSON.stringify({ projection: { simtDevSha: 'a' } }, null, 2)}\n`);
  const stale = await manifestDrift(root, ['node'], 'b');
  assert.equal(stale?.status, 'stale-generated-field');
  assert.match(stale.remedy, new RegExp(`^run: ${CLI} sync --yes$`), `unexpected remedy: ${stale.remedy}`);
  assert.doesNotMatch(stale.remedy, /init/, 'init re-runs adoption; it is not the repair for one field');
});

test('init --backup: the branch and the tag it creates are both reported (S15)', async () => {
  // With --backup both operations happen, and the heading over plan 0002 §8.2's list
  // is "Nothing is silent". Both were once reported only under `--json`, so the run —
  // the one almost everybody reads — did not say that the branch under them had
  // changed. (ADR-063 made the pair opt-in; the reporting requirement stands for
  // whatever a run does to git state.)
  //
  // The claim under test is about what a reader SEES, so it is asserted on the printed
  // output rather than on the returned payload, which already carried both.
  const { initCommand } = await import('../src/commands/init.mjs');
  const root = await tempDir('simt-manifest-');
  await git(['init', '-q'], { cwd: root });
  await writeFile(join(root, 'notes.txt'), 'x\n');
  await git(['add', '-A'], { cwd: root });
  await git(['commit', '-qm', 'init'], { cwd: root });

  // `capture` collects both streams, which is where a reader looks too.
  const { code, text } = await capture(() => initCommand([], { root, yes: true, backup: true }));
  assert.equal(code, 0);

  // The in-place note is the other half of "Nothing is silent": without --backup the
  // run says it did not branch or tag. With --backup there is nothing to excuse, so
  // the note must not appear.
  assert.doesNotMatch(text, /in place   no backup tag/, '--backup run must not report in-place');

  assert.match(text, /tagged\s+backup-before-simt-dev/, 'the tag it wrote was not reported');
  assert.match(text, /git reset --hard backup-before-simt-dev/, 'and not how to undo it');
  assert.match(text, /branch\s+switched to simt-dev\/adopt/, 'the branch it switched to was not reported');

  // And the commands named must be the ones that work. An escape hatch that prints the
  // wrong way out is worse than one that prints nothing, because it is believed.
  const { stdout: after } = await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root });
  assert.match(after.trim(), /^simt-dev\/adopt$/, 'the test did not actually switch branches');
  const { stdout: branches } = await git(['branch', '--format=%(refname:short)'], { cwd: root });
  assert.match(branches, /\bmaster\b|\bmain\b/, 'the previous branch is gone; the message claims it is untouched');

  // The branch line names the branch it came FROM, and that name must be real.
  const from = /branch\s+switched to simt-dev\/adopt;\s+(\S+)\s+is untouched/.exec(text);
  assert.ok(from, 'the branch line does not name the branch it left');
  assert.ok(
    branches.split('\n').includes(from[1]),
    `the branch line names "${from[1]}", which is not a branch in this repository`,
  );
});

test('init without --backup writes in place: no tag, no branch (ADR-063)', async () => {
  // The default is in place: the adoption lands on the branch the reader already has,
  // and no git object is created. The in-place note says so, and names the flag that
  // restores the undo path. A reader who ran the documented flow without choosing an
  // escape hatch must not find a branch they did not ask for under them.
  const { initCommand } = await import('../src/commands/init.mjs');
  const root = await tempDir('simt-manifest-');
  await git(['init', '-q'], { cwd: root });
  await writeFile(join(root, 'notes.txt'), 'x\n');
  await git(['add', '-A'], { cwd: root });
  await git(['commit', '-qm', 'init'], { cwd: root });
  const { stdout: before } = await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root });

  const { code, text } = await capture(() => initCommand([], { root, yes: true }));
  assert.equal(code, 0);

  const { stdout: after } = await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root });
  assert.equal(after.trim(), before.trim(), 'the reader must stay on the branch they were on');
  const { stdout: branches } = await git(['branch', '--format=%(refname:short)'], { cwd: root });
  assert.doesNotMatch(branches, /simt-dev\/adopt/, 'an adopt branch was created without --backup');
  await assert.rejects(
    () => git(['rev-parse', '--verify', 'refs/tags/backup-before-simt-dev'], { cwd: root }),
    'a backup tag was created without --backup',
  );

  // And the run says what it did instead, with the flag that gives the undo path.
  assert.match(text, /in place   no backup tag or adopt branch/, 'the in-place behaviour was not reported');
  assert.match(text, /--backup/, 'and the flag that restores the undo path was not named');

  // The adoption itself still happened, in place.
  const manifest = await readFile(join(root, MANIFEST_FILE), 'utf8');
  assert.ok(manifest.length > 0, 'the manifest was not written in place');
});

test('init --yes builds the index and reports it; a dry run leaves none behind (ADR-108)', async () => {
  // The index is a cache of git blobs: gitignored, rebuildable, and not journaled.
  // Building it during the adoption means the first `simt map` or `simt brief` in a
  // fresh repository answers from real files. A dry run plans the build without doing
  // it: a run that writes nothing must not leave a cache behind.
  const { initCommand } = await import('../src/commands/init.mjs');
  const root = await tempDir('simt-manifest-');
  await git(['init', '-q'], { cwd: root });
  await writeFile(join(root, 'notes.txt'), 'x\n');
  await git(['add', '-A'], { cwd: root });
  await git(['commit', '-qm', 'init'], { cwd: root });

  const planned = await capture(() => initCommand([], { root }));
  assert.equal(planned.code, 0);
  assert.match(planned.text, /\.simt\/local\/index\.sqlite/, 'the plan does not name the index it will build');
  await assert.rejects(
    () => stat(join(root, '.simt', 'local', 'index.sqlite')),
    'a dry run built the index',
  );

  const { code, text } = await capture(() => initCommand([], { root, yes: true }));
  assert.equal(code, 0);
  assert.match(text, /index    1 files/, 'the build was not reported');
  const built = await stat(join(root, '.simt', 'local', 'index.sqlite'));
  assert.ok(built.size > 0, 'the index was not written');
});

test('init --backup: a directory that is not a git work tree reports no branch and no tag', async () => {
  // The escape hatch is best-effort (plan 0002: a repo with no commits must still be
  // adoptable), so the notes carry the reason. What must not happen is the tool
  // claiming a tag or a branch it did not create.
  const { initCommand } = await import('../src/commands/init.mjs');
  const root = await tempDir('simt-manifest-');
  await writeFile(join(root, 'monkey.jungle'), '');
  const { code, text } = await capture(() => initCommand([], { root, yes: true, backup: true }));
  assert.equal(code, 0);
  assert.doesNotMatch(text, /^tagged /m, 'a tag was reported in a repository with no git');
  assert.doesNotMatch(text, /^branch   switched/m, 'a branch switch was reported in a repository with no git');
  assert.match(text, /not a git work tree/, 'the reason it created neither was not reported');
});
