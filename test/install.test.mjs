import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRegistry, measureSkill } from '../src/graph/load.mjs';
import { skillsDir, wrapFlat } from '../src/commands/skillsinstall.mjs';
import { readManifest, MANIFEST } from '../src/projection/manifest.mjs';
import { skillWorkspace, workspaceEnv, cmd } from './fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, '..', 'bin', 'simt.mjs');
const exec = promisify(execFile);

// The bodies these tests install live here, staged from the registry by the suite
// itself. They used to be read out of sibling repositories, which meant the suite
// passed on a machine that had them and failed on a runner that did not - the third
// time this repository made this mistake about a workspace, and the first time it
// kept the gate red on every push (ADR-031).
const { root: WORKSPACE } = await skillWorkspace();

const temps = [];

async function scratch(files = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'simt-install-'));
  temps.push(dir);
  for (const [name, body] of Object.entries(files)) {
    const path = join(dir, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }
  return dir;
}

async function run(args, env = {}) {
  try {
    const { stdout, stderr } = await exec('node', [BIN, ...args], {
      maxBuffer: 32 << 20,
      // Every case runs against the staged workspace, and a case that needs no
      // workspace says `SIMT_DEV_WORKSPACE: 'off'` itself. Inheriting the
      // developer's own workspace would hide exactly the behaviour the
      // single-repo cases exist to check.
      env: { ...process.env, ...workspaceEnv(WORKSPACE), ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

/** A clone of exactly one repo: it holds that repo's own bodies and nothing else. */
async function singleRepoClone(skillName) {
  const dir = await scratch({ 'package.json': '{"name":"lonely"}' });
  await cp(
    join(WORKSPACE, 'repo-07', '.agents', 'skills', skillName),
    join(dir, '.agents', 'skills', skillName),
    { recursive: true },
  );
  return dir;
}

test.after(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

// --- measureSkill: the bug a new command exposed ------------------------------

test('measureSkill: a directory with reference .md files is not a flat skill', async () => {
  // `checklist.md` sits beside SKILL.md. Treating any sibling .md as a flat
  // layout made install readFile() a directory and die with EISDIR.
  const dir = await scratch({ 's/SKILL.md': '---\nname: s\n---\n\nbody\n', 's/checklist.md': 'x\n' });
  const measured = await measureSkill(join(dir, 's'));
  assert.equal(measured.flat, false);
  assert.equal(measured.files, 2);
});

test('measureSkill: a flat .md file is still reported as flat', async () => {
  const dir = await scratch({ 'flat-skill.md': '---\ndescription: d\n---\n\nbody\n' });
  const measured = await measureSkill(join(dir, 'flat-skill.md'));
  assert.equal(measured.flat, true, 'the ADR-009 defect must remain visible, not be normalised away');
});

// --- destination layout -------------------------------------------------------

test('skillsDir: respects the layout a repo already uses instead of imposing one', () => {
  assert.equal(skillsDir('/r', ['.agents', '.cursor']), '.agents/skills');
  assert.equal(skillsDir('/r', ['.cursor', '.claude']), '.cursor/skills', 'simt-app keeps .cursor canonical');
  assert.equal(skillsDir('/r', ['src']), '.agents/skills', 'a repo with none gets the estate default');
});

test('skills install: writes into the layout the repo already has', async () => {
  const root = await scratch({ '.cursor/keep.md': 'x\n', 'pyproject.toml': '[project]\n' });
  const { code } = await run(['skills', 'install', 'wrangler', '--root', root, '--yes']);
  assert.equal(code, 0);
  assert.ok(existsSync(join(root, '.cursor/skills/wrangler/SKILL.md')));
});

// --- the three refusals -------------------------------------------------------

test('skills install: without a name it fails with usage', async () => {
  const { code, stderr } = await run(['skills', 'install']);
  assert.equal(code, 2);
  assert.match(stderr, cmd('usage: {cli} skills install'));
});

test('skills install: an unknown skill exits USAGE and suggests a near match', async () => {
  const { code, stderr } = await run(['skills', 'install', 'wranglr']);
  assert.equal(code, 2);
  assert.match(stderr, /did you mean wrangler/);
});

test('skills install: --from must name a declared source of that skill', async () => {
  const root = await scratch({ 'pyproject.toml': '[project]\n' });
  const { code, stderr } = await run([
    'skills', 'install', 'wrangler', '--from', 'somewhere/else', '--root', root,
  ]);
  assert.equal(code, 2);
  assert.match(stderr, /is not a declared source of wrangler/);
});

// --- dry run is the default ----------------------------------------------------

test('skills install: writes nothing without --yes', async () => {
  const root = await scratch({ 'pyproject.toml': '[project]\n' });
  const { code, stderr } = await run(['skills', 'install', 'wrangler', '--root', root]);
  assert.equal(code, 0);
  assert.match(stderr, /dry-run {2}nothing written/);
  assert.ok(!existsSync(join(root, '.agents')), 'the destination directory must not even be created');
});

test('skills install: --json is a dry run regardless of --yes, and is structured', async () => {
  const root = await scratch({ 'pyproject.toml': '[project]\n' });
  const { stdout } = await run(['skills', 'install', 'wrangler', '--root', root, '--json']);
  const payload = JSON.parse(stdout);
  assert.equal(payload.action, 'added');
  assert.equal(payload.written, false);
  assert.equal(payload.dest, '.agents/skills/wrangler');
  assert.ok(!existsSync(join(root, '.agents')));
});

// --- what gets written ---------------------------------------------------------

test('skills install: writes a normal skill verbatim, frontmatter and body', async () => {
  // ADR-009 still rules that a flat `<name>.md` is wrapped into
  // `<name>/SKILL.md` with a `name` key added, but this estate holds no flat
  // skill any more, so the wrap path is exercised through `wrapFlat` below
  // rather than through a registry entry. What this test guards instead is
  // the ordinary case: a `<name>/SKILL.md` source is copied byte-for-byte, so
  // a formatter-stable source stays formatter-stable in the consumer.
  const root = await scratch({ 'pyproject.toml': '[project]\n' });
  const { code } = await run(['skills', 'install', 'wrangler', '--root', root, '--yes']);
  assert.equal(code, 0);
  const body = await readFile(join(root, '.agents/skills/wrangler/SKILL.md'), 'utf8');
  const src = await readFile(join(WORKSPACE, 'repo-07/.agents/skills/wrangler/SKILL.md'), 'utf8');
  assert.equal(body, src, 'a directory skill is copied verbatim');
});

test('skills install: reference files come with the skill', async () => {
  const root = await scratch({ 'pyproject.toml': '[project]\n' });
  const { code, stdout } = await run([
    'skills', 'install', 'wrangler', '--root', root, '--yes',
  ]);
  assert.equal(code, 0);
  assert.match(stdout, /2 files/);
  const dir = join(root, '.agents/skills/wrangler');
  assert.ok(existsSync(join(dir, 'SKILL.md')));
  assert.ok(existsSync(join(dir, 'checklist.md')));
});

test('skills install: rerunning is idempotent, including the wrapped form', async () => {
  const root = await scratch({ 'pyproject.toml': '[project]\n' });
  await run(['skills', 'install', 'wrangler', '--root', root, '--yes']);
  const before = await readFile(join(root, '.agents/skills/wrangler/SKILL.md'), 'utf8');
  const { stdout } = await run(['skills', 'install', 'wrangler', '--root', root]);
  assert.match(stdout, /status {3}unchanged/);
  assert.equal(
    await readFile(join(root, '.agents/skills/wrangler/SKILL.md'), 'utf8'),
    before,
  );
});

test('skills install: a local edit is reported as updated, never silently overwritten', async () => {
  const root = await scratch({ 'pyproject.toml': '[project]\n' });
  await run(['skills', 'install', 'wrangler', '--root', root, '--yes']);
  const path = join(root, '.agents/skills/wrangler/SKILL.md');
  const edited = `${await readFile(path, 'utf8')}\n<!-- local note -->\n`;
  await writeFile(path, edited);
  const { stdout } = await run(['skills', 'install', 'wrangler', '--root', root]);
  assert.match(stdout, /status {3}updated/);
  assert.equal(await readFile(path, 'utf8'), edited, 'a dry run must not touch the file');
});

// --- the manifest record -------------------------------------------------------

test('skills install: records provenance in {manifest} localSkills', async () => {
  const root = await scratch({ 'pyproject.toml': '[project]\n' });
  await run(['skills', 'install', 'wrangler', '--root', root, '--yes']);
  const { manifest } = await readManifest(root);
  assert.equal(manifest.localSkills.length, 1);
  const [entry] = manifest.localSkills;
  assert.equal(entry.name, 'wrangler');
  assert.equal(entry.from, 'repo-07/.agents/skills/wrangler');
  assert.match(entry.sha, /^[0-9a-f]{12}$/, 'the pin records which bytes were installed');
  assert.equal(entry.bytes, 18359);
});

test('skills install: a repo with no manifest gets the full canonical shape, not a stub', async () => {
  // A `{localSkills}`-only manifest reads as authoritative while omitting `gates`,
  // which is the field the hook dispatcher runs from - so a repo whose manifest
  // came from `skills install` would install hooks with nothing to enforce.
  const root = await scratch({ 'pyproject.toml': '[project]\n' });
  await run(['skills', 'install', 'wrangler', '--root', root, '--yes']);
  const { manifest } = await readManifest(root);
  for (const key of ['id', 'stack', 'limits', 'gates', 'localSkills', 'projection']) {
    assert.ok(key in manifest, `manifest is missing ${key}`);
  }
  // `gates` must be present and it must be *true*. This assertion used to read
  // `preCommit.length > 0` as the proof of correctness, which is how a manifest
  // declaring four gates this repo cannot run passed a test about manifests being
  // right. A `pyproject.toml` and nothing else runs none of them, so the honest
  // answer is two empty lists, and their emptiness is the point — see the test below.
  assert.deepEqual(manifest.gates, { preCommit: [], prePush: [] });
  // The pin is a content digest, so it is present with or without a `.git` and there is
  // no sentinel to allow. `unknown` was the old fallback and it compared as a version.
  assert.match(manifest.projection.simtDevSha, /^[0-9a-f]{40}$/);
});

// The second half of the same defect, and the half with teeth. A manifest written by a
// command that installs one skill declares what the repo will be blocked on, so every
// gate in it must be one the repo can actually run — otherwise the moment hooks route
// through the manifest, which is the whole point of having gates, every commit in that
// repo is blocked over a promise nobody made.
test('skills install: every gate a created manifest declares is one the repo can run', async () => {
  // A repo with nothing installed and nothing declared, which is the state `skills
  // install` found. Asserting only on this fixture would pass a fix that hardcoded an
  // empty list, so the same test runs against a repo that CAN run gates and requires
  // them to be there. Both halves are the same assertion: `check` accepts the manifest.
  const bare = await scratch({ 'pyproject.toml': '[project]\n' });
  await run(['skills', 'install', 'wrangler', '--root', bare, '--yes']);
  const { manifest } = await readManifest(bare);
  const declared = [...manifest.gates.preCommit, ...manifest.gates.prePush];
  assert.deepEqual(declared, [], `a repo with no scripts must declare no gates, got ${declared}`);

  // `check` is the reader of this field, so ask the same function `check` asks with the
  // same probe, rather than re-deriving the rule here. A test that spelled the rule out
  // itself would pass while `check` rejected the manifest.
  const { unrunnableGates } = await import('../src/projection/manifest.mjs');
  const { readCapability } = await import('../src/hooks/capability.mjs');
  const rejected = unrunnableGates(manifest, await readCapability(bare));
  assert.deepEqual(rejected, [], `check would reject this manifest: ${JSON.stringify(rejected)}`);

  // A repo with the scripts and the formatter gets its gates, and the probe is the only
  // difference between the two fixtures.
  const capable = await scratch({
    'package.json': JSON.stringify({
      name: 'r',
      scripts: { test: 'node -e ""', typecheck: 'tsc' },
      devDependencies: { prettier: '^3' },
    }),
    'node_modules/.bin/prettier': '#!/bin/sh\n',
  });
  await run(['skills', 'install', 'wrangler', '--root', capable, '--yes']);
  const { manifest: withGates } = await readManifest(capable);
  const got = [...withGates.gates.preCommit, ...withGates.gates.prePush];
  assert.ok(got.length > 0, 'a repo that can run gates must get them, or the probe is not running');
  const stillBad = unrunnableGates(withGates, await readCapability(capable));
  assert.deepEqual(stillBad, [], `check would reject this manifest: ${JSON.stringify(stillBad)}`);
});

test('skills install: keeps a hand-written string entry and adds the new record', async () => {
  const root = await scratch({
    'pyproject.toml': '[project]\n',
    [MANIFEST]: JSON.stringify({ id: 'x', localSkills: ['hand-written'] }, null, 2),
  });
  await run(['skills', 'install', 'wrangler', '--root', root, '--yes']);
  const { manifest } = await readManifest(root);
  const names = manifest.localSkills.map((e) => (typeof e === 'string' ? e : e.name));
  assert.deepEqual(names, ['hand-written', 'wrangler']);
});

test('skills install: reinstalling replaces the record rather than duplicating it', async () => {
  const root = await scratch({ 'pyproject.toml': '[project]\n' });
  await run(['skills', 'install', 'wrangler', '--root', root, '--yes']);
  await run(['skills', 'install', 'wrangler', '--root', root, '--yes']);
  const { manifest } = await readManifest(root);
  assert.equal(manifest.localSkills.length, 1);
});

test('skills install: an existing manifest keeps its id, stack, limits and gates', async () => {
  const before = {
    id: 'chosen-by-hand',
    stack: ['python'],
    limits: { coverage: 100, fileLines: { warn: 500, error: 2000 } },
    gates: { preCommit: ['lint'], prePush: ['test'] },
    localSkills: [],
    projection: { simtDevSha: 'aaaaaaa' },
  };
  const root = await scratch({ 'pyproject.toml': '[project]\n', [MANIFEST]: JSON.stringify(before, null, 2) });
  await run(['skills', 'install', 'wrangler', '--root', root, '--yes']);
  const { manifest } = await readManifest(root);
  assert.equal(manifest.id, 'chosen-by-hand');
  assert.equal(manifest.limits.coverage, 100);
  assert.equal(manifest.limits.fileLines.warn, 500);
  assert.deepEqual(manifest.gates.preCommit, ['lint']);
});

// --- in-place ------------------------------------------------------------------

test('skills install: installing a skill into the repo that already holds it does nothing', async () => {
  // The repo being installed into IS the declared source for this variant, so the
  // "installed copy" and the registry source are the same bytes. `cp` of a directory
  // onto itself fails, and the correct action is nothing.
  const { code, stdout, stderr } = await run([
    'skills', 'install', 'wrangler', '--root', join(WORKSPACE, 'repo-07'), '--yes',
  ]);
  assert.equal(code, 0);
  assert.match(stdout, /status {3}in-place/);
  assert.match(stderr, /is the registry source itself/);
});

// --- a single-repo clone, with no workspace anywhere (ADR-015) ------------------

test('skills install: a single-repo clone installs from the copy it already holds', async () => {
  const dir = await singleRepoClone('wrangler');
  const { code, stdout } = await run(['skills', 'install', 'wrangler', '--root', dir, '--yes'], {
    SIMT_DEV_WORKSPACE: 'off',
  });
  assert.equal(code, 0);
  assert.match(stdout, /^workspace \(none\)/m);
  assert.match(stdout, /^source\s+repo-07\/\.agents\/skills\/wrangler/m);
  assert.match(stdout, /^read\s+repo/m);
});

test('skills install: a repo holding a body with the wrong declared size is not that body', async () => {
  const dir = await scratch({
    'package.json': '{"name":"lonely"}',
    '.agents/skills/wrangler/SKILL.md': '---\nname: wrangler\n---\n\nnot the real body\n',
  });
  const { code, stderr } = await run(['skills', 'install', 'wrangler', '--root', dir, '--yes'], {
    SIMT_DEV_WORKSPACE: 'off',
  });
  assert.notEqual(code, 0);
  assert.match(stderr, /exists but is not the declared body \(18359 bytes declared\)/);
});

test('skills show: reads the body a single-repo clone already holds', async () => {
  const dir = await singleRepoClone('wrangler');
  const { code, stdout } = await run(['skills', 'show', 'wrangler', '--root', dir, '--max-bytes', '0'], {
    SIMT_DEV_WORKSPACE: 'off',
  });
  assert.equal(code, 0);
  assert.match(stdout, /^body\s+repo\s+/m);
  assert.ok(!stdout.includes('body unavailable'), 'the body was on disk all along');
});

// --- ADR-009's flat-file wrap, tested directly --------------------------------

test('wrapFlat: ADR-009 - a flat .md gains a name key and keeps its frontmatter and body', async () => {
  const dir = await scratch({
    'flat.md': '---\ndescription: keep me\nargument-hint: "hint"\n---\n\n# Body\n\ntext\n',
    'no-frontmatter.md': '# Body only\n',
  });

  const wrapped = await wrapFlat(join(dir, 'flat.md'), 'flat');
  assert.match(wrapped, /^---\nname: flat\n/, 'the name key ADR-009 requires is added');
  assert.match(wrapped, /^description: keep me$/m, 'existing frontmatter survives');
  assert.match(wrapped, /^argument-hint: "hint"$/m, 'every existing key survives');
  assert.ok(wrapped.includes('# Body') && wrapped.includes('text'), 'the body survives');
  assert.ok(wrapped.endsWith('\n'), 'the result is a well-formed file');

  const bare = await wrapFlat(join(dir, 'no-frontmatter.md'), 'bare');
  assert.equal(bare, '---\nname: bare\n---\n\n# Body only\n', 'a file with no frontmatter still gets a valid header');
});
