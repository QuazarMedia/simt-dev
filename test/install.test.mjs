import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRegistry, REGISTRY_PATH, measureSkill } from '../src/graph/load.mjs';
import { skillsDir } from '../src/commands/skillsinstall.mjs';
import { readManifest, MANIFEST } from '../src/projection/manifest.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, '..', 'bin', 'simt-dev.mjs');
const WORKSPACE = resolve(HERE, '..', '..');
const exec = promisify(execFile);

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
      // A test that inherits the developer's workspace cannot detect behaviour
      // that depends on one being absent, so the single-repo cases say so.
      env: { ...process.env, ...env },
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
    join(WORKSPACE, 'simt-social', '.agents', 'skills', skillName),
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
  const dir = await scratch({ 'coverage-hunt.md': '---\ndescription: d\n---\n\nbody\n' });
  const measured = await measureSkill(join(dir, 'coverage-hunt.md'));
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
  const { code } = await run(['skills', 'install', 'coverage-hunt', '--root', root, '--yes']);
  assert.equal(code, 0);
  assert.ok(existsSync(join(root, '.cursor/skills/coverage-hunt/SKILL.md')));
});

// --- the three refusals -------------------------------------------------------

test('skills install: without a name it fails with usage', async () => {
  const { code, stderr } = await run(['skills', 'install']);
  assert.equal(code, 2);
  assert.match(stderr, /usage: simt-dev skills install/);
});

test('skills install: an unknown skill exits USAGE and suggests a near match', async () => {
  const { code, stderr } = await run(['skills', 'install', 'slice-commmit']);
  assert.equal(code, 2);
  assert.match(stderr, /did you mean slice-commit/);
});

test('skills install: an ambiguous variant is an error, never a guess', async () => {
  // Getting this wrong installs the web procedure into the API repo, which is
  // exactly the two-repo divergence the variants exist to prevent.
  const root = await scratch({ 'monkey.jungle': '', 'src/a.mc': 'class A{}' });
  const { code, stderr } = await run(['skills', 'install', 'slice-commit', '--root', root]);
  assert.equal(code, 2);
  assert.match(stderr, /none matches this repo/);
  assert.match(stderr, /--variant <web\|api>/);
  assert.ok(!existsSync(join(root, '.agents/skills/slice-commit')), 'nothing may be written on refusal');
});

test('skills install: two matching variants are refused rather than ranked', async () => {
  const root = await scratch({ 'package.json': '{"dependencies":{"hono":"1","react":"18"}}' });
  const { code, stderr } = await run(['skills', 'install', 'slice-commit', '--root', root]);
  assert.equal(code, 2);
  assert.match(stderr, /all match this repo/);
});

test('skills install: an unknown --variant names the ones that exist', async () => {
  const root = await scratch({ 'pyproject.toml': '[project]\n' });
  const { code, stderr } = await run(['skills', 'install', 'slice-commit', '--variant', 'mobile', '--root', root]);
  assert.equal(code, 2);
  assert.match(stderr, /variants: web, api/);
});

test('skills install: --from must name a declared source of that skill', async () => {
  const root = await scratch({ 'pyproject.toml': '[project]\n' });
  const { code, stderr } = await run([
    'skills', 'install', 'slice-commit', '--from', 'somewhere/else', '--root', root,
  ]);
  assert.equal(code, 2);
  assert.match(stderr, /is not a declared source of slice-commit/);
});

// --- dry run is the default ----------------------------------------------------

test('skills install: writes nothing without --yes', async () => {
  const root = await scratch({ 'pyproject.toml': '[project]\n' });
  const { code, stderr } = await run(['skills', 'install', 'coverage-hunt', '--root', root]);
  assert.equal(code, 0);
  assert.match(stderr, /dry-run {2}nothing written/);
  assert.ok(!existsSync(join(root, '.agents')), 'the destination directory must not even be created');
});

test('skills install: --json is a dry run regardless of --yes, and is structured', async () => {
  const root = await scratch({ 'pyproject.toml': '[project]\n' });
  const { stdout } = await run(['skills', 'install', 'coverage-hunt', '--root', root, '--json']);
  const payload = JSON.parse(stdout);
  assert.equal(payload.action, 'added');
  assert.equal(payload.written, false);
  assert.equal(payload.dest, '.agents/skills/coverage-hunt');
  assert.ok(!existsSync(join(root, '.agents')));
});

// --- what gets written ---------------------------------------------------------

test('skills install: a flat .md is wrapped into <name>/SKILL.md and gains the name key', async () => {
  const root = await scratch({ 'pyproject.toml': '[project]\n' });
  const { code } = await run(['skills', 'install', 'coverage-hunt', '--root', root, '--yes']);
  assert.equal(code, 0);
  const body = await readFile(join(root, '.agents/skills/coverage-hunt/SKILL.md'), 'utf8');
  assert.match(body, /^---\nname: coverage-hunt\n/, 'ADR-009 requires the name key; the source omits it');
  assert.match(body, /^description: /m, 'the existing frontmatter must survive the wrap');
  assert.ok(body.includes('# Coverage hunt'), 'the body must survive the wrap');
});

test('skills install: reference files come with the skill', async () => {
  // A skill whose references are missing is worse than one never installed,
  // because it looks installed.
  const root = await scratch({ 'pyproject.toml': '[project]\n' });
  const { code, stdout } = await run([
    'skills', 'install', 'add-country-galaxy', '--variant', 'api', '--root', root, '--yes',
  ]);
  assert.equal(code, 0);
  assert.match(stdout, /2 files/);
  const dir = join(root, '.agents/skills/add-country-galaxy');
  assert.ok(existsSync(join(dir, 'SKILL.md')));
  assert.ok(existsSync(join(dir, 'checklist.md')));
});

test('skills install: rerunning is idempotent, including the wrapped form', async () => {
  const root = await scratch({ 'pyproject.toml': '[project]\n' });
  await run(['skills', 'install', 'coverage-hunt', '--root', root, '--yes']);
  const before = await readFile(join(root, '.agents/skills/coverage-hunt/SKILL.md'), 'utf8');
  const { stdout } = await run(['skills', 'install', 'coverage-hunt', '--root', root]);
  assert.match(stdout, /status {3}unchanged/);
  assert.equal(
    await readFile(join(root, '.agents/skills/coverage-hunt/SKILL.md'), 'utf8'),
    before,
  );
});

test('skills install: a local edit is reported as updated, never silently overwritten', async () => {
  const root = await scratch({ 'pyproject.toml': '[project]\n' });
  await run(['skills', 'install', 'coverage-hunt', '--root', root, '--yes']);
  const path = join(root, '.agents/skills/coverage-hunt/SKILL.md');
  const edited = `${await readFile(path, 'utf8')}\n<!-- local note -->\n`;
  await writeFile(path, edited);
  const { stdout } = await run(['skills', 'install', 'coverage-hunt', '--root', root]);
  assert.match(stdout, /status {3}updated/);
  assert.equal(await readFile(path, 'utf8'), edited, 'a dry run must not touch the file');
});

// --- the manifest record -------------------------------------------------------

test('skills install: records provenance in simt-dev.json localSkills', async () => {
  const root = await scratch({ 'pyproject.toml': '[project]\n' });
  await run(['skills', 'install', 'coverage-hunt', '--root', root, '--yes']);
  const { manifest } = await readManifest(root);
  assert.equal(manifest.localSkills.length, 1);
  const [entry] = manifest.localSkills;
  assert.equal(entry.name, 'coverage-hunt');
  assert.equal(entry.from, 'bunnyland-server/.agents/skills/coverage-hunt.md');
  assert.match(entry.sha, /^[0-9a-f]{12}$/, 'the pin records which bytes were installed');
  assert.equal(entry.bytes, 7266);
});

test('skills install: a repo with no manifest gets the full canonical shape, not a stub', async () => {
  // A `{localSkills}`-only manifest reads as authoritative while omitting `gates`,
  // which is the field the hook dispatcher runs from - so a repo whose manifest
  // came from `skills install` would install hooks with nothing to enforce.
  const root = await scratch({ 'pyproject.toml': '[project]\n' });
  await run(['skills', 'install', 'coverage-hunt', '--root', root, '--yes']);
  const { manifest } = await readManifest(root);
  for (const key of ['id', 'stack', 'limits', 'gates', 'localSkills', 'projection']) {
    assert.ok(key in manifest, `manifest is missing ${key}`);
  }
  assert.ok(manifest.gates.preCommit.length > 0 && manifest.gates.prePush.length > 0);
  assert.match(manifest.projection.simtDevSha, /^[0-9a-f]{7}$|^unknown$/);
});

test('skills install: records the variant that was actually installed', async () => {
  const root = await scratch({ 'pyproject.toml': '[project]\n' });
  await run(['skills', 'install', 'slice-commit', '--variant', 'api', '--root', root, '--yes']);
  const { manifest } = await readManifest(root);
  assert.equal(manifest.localSkills[0].variant, 'api');
  assert.equal(manifest.localSkills[0].from, 'simt-social-api/.agents/skills/slice-commit');
});

test('skills install: keeps a hand-written string entry and adds the new record', async () => {
  const root = await scratch({
    'pyproject.toml': '[project]\n',
    [MANIFEST]: JSON.stringify({ id: 'x', localSkills: ['hand-written'] }, null, 2),
  });
  await run(['skills', 'install', 'coverage-hunt', '--root', root, '--yes']);
  const { manifest } = await readManifest(root);
  const names = manifest.localSkills.map((e) => (typeof e === 'string' ? e : e.name));
  assert.deepEqual(names, ['hand-written', 'coverage-hunt']);
});

test('skills install: reinstalling replaces the record rather than duplicating it', async () => {
  const root = await scratch({ 'pyproject.toml': '[project]\n' });
  await run(['skills', 'install', 'coverage-hunt', '--root', root, '--yes']);
  await run(['skills', 'install', 'coverage-hunt', '--root', root, '--yes']);
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
  await run(['skills', 'install', 'coverage-hunt', '--root', root, '--yes']);
  const { manifest } = await readManifest(root);
  assert.equal(manifest.id, 'chosen-by-hand');
  assert.equal(manifest.limits.coverage, 100);
  assert.equal(manifest.limits.fileLines.warn, 500);
  assert.deepEqual(manifest.gates.preCommit, ['lint']);
});

// --- in-place ------------------------------------------------------------------

test('skills install: installing a skill into the repo that already holds it does nothing', async () => {
  // Both social repos resolve .agents/skills through a symlink, so the "installed
  // copy" and the registry source are the same bytes. `cp` of a directory onto
  // itself fails, and the correct action is nothing.
  const { code, stdout, stderr } = await run([
    'skills', 'install', 'slice-commit', '--root', join(WORKSPACE, 'simt-social-api'), '--yes',
  ]);
  assert.equal(code, 0);
  assert.match(stdout, /status {3}in-place/);
  assert.match(stderr, /is the registry source itself/);
});

// --- the registry invariant this command depends on ----------------------------

test('every variant-bearing skill resolves to exactly one variant per real repo', async () => {
  const { registry } = await loadRegistry(REGISTRY_PATH);
  const { fingerprint } = await import('../src/resolve/fingerprint.mjs');
  const cases = [
    { repo: 'simt-social', expect: 'web' },
    { repo: 'simt-social-api', expect: 'api' },
  ];
  for (const skill of registry.skills) {
    if (!skill.variants?.length) continue;
    for (const { repo, expect } of cases) {
      const { signals } = await fingerprint(join(WORKSPACE, repo));
      const tags = new Set(signals);
      const matched = skill.variants.filter((v) => v.stack.some((t) => tags.has(t)));
      assert.equal(
        matched.length,
        1,
        `${skill.name} matches ${matched.length} variants in ${repo}; a variant stack must name the tag that differs`,
      );
      assert.equal(matched[0].id, expect, `${skill.name} should select the ${expect} body in ${repo}`);
    }
  }
});
// --- a single-repo clone, with no workspace anywhere (ADR-015) ------------------

test('skills install: a single-repo clone installs from the copy it already holds', async () => {
  // The case that made this a ruling: a clone of one repo has no workspace, and its
  // `package.json` cannot tell the `web` variant of slice-commit from the `api`
  // one. Its own 5048 bytes are an exact answer, so install uses them.
  const dir = await singleRepoClone('slice-commit');
  const { code, stdout } = await run(['skills', 'install', 'slice-commit', '--root', dir, '--yes'], {
    SIMT_DEV_WORKSPACE: 'off',
  });
  assert.equal(code, 0);
  assert.match(stdout, /^workspace \(none\)/m);
  assert.match(stdout, /^source\s+simt-social\/\.agents\/skills\/slice-commit/m);
  assert.match(stdout, /already holds the web variant/);
  assert.match(stdout, /^read\s+repo/m);
});

test('skills install: the bytes on disk pick the variant, not the stack tags', async () => {
  const dir = await singleRepoClone('slice-commit');
  const { code, stdout } = await run(['skills', 'install', 'slice-commit', '--root', dir], {
    SIMT_DEV_WORKSPACE: 'off',
  });
  assert.equal(code, 0);
  assert.match(stdout, /^install slice-commit \(variant web\)$/m);
});

test('skills install: a repo holding a body with the wrong declared size is not that body', async () => {
  // Size is the identity check. A near-miss is a different file, so it must be
  // refused rather than installed as a degraded match.
  const dir = await scratch({
    'package.json': '{"name":"lonely"}',
    '.agents/skills/slice-commit/SKILL.md': '---\nname: slice-commit\n---\n\nnot the real body\n',
  });
  const { code, stderr } = await run(['skills', 'install', 'slice-commit', '--root', dir, '--yes'], {
    SIMT_DEV_WORKSPACE: 'off',
  });
  assert.notEqual(code, 0);
  // The message has to name the file that is actually there, or the reader goes
  // looking at their stack tags instead.
  assert.match(stderr, /exists but is not the declared body \(5048 bytes declared\)/);
});

test('skills install: signals that contradict the body the repo holds are refused', async () => {
  // A react/hono repo signals both variants, so `held` decides. But a repo whose
  // signals name exactly one variant while holding the other is a disagreement
  // between two inputs, and installing either silently would pick a side.
  const dir = await scratch({
    'package.json': JSON.stringify({
      name: 'lonely',
      dependencies: { hono: '^4', react: '^19' },
    }),
    '.agents/skills/slice-commit/SKILL.md': (() => {
      // Exactly the canonical web body, so the repo genuinely holds the `web`
      // variant even though `hono` is present.
      return readFileSync(join(WORKSPACE, 'simt-social', '.agents', 'skills', 'slice-commit', 'SKILL.md'), 'utf8');
    })(),
  });
  const { code, stdout } = await run(['skills', 'install', 'slice-commit', '--root', dir], {
    SIMT_DEV_WORKSPACE: 'off',
  });
  // react + hono both match, so ambiguity is resolved by the bytes on disk.
  assert.equal(code, 0);
  assert.match(stdout, /the repo's own copy decides/);
  assert.match(stdout, /^install slice-commit \(variant web\)$/m);
});

test('skills install: an explicit --variant is obeyed, and the disagreement is noted not blocked', async () => {
  // The repo holds the `api` body and signals `hono`, so every automatic signal
  // says `api`. An explicit --variant is the author answering a question the tool
  // cannot, so it is obeyed - but the reader is told what they are overriding.
  const dir = await scratch({
    'package.json': JSON.stringify({ name: 'lonely', dependencies: { hono: '^4' } }),
  });
  await cp(
    join(WORKSPACE, 'simt-social-api', '.agents', 'skills', 'slice-commit'),
    join(dir, '.agents', 'skills', 'slice-commit'),
    { recursive: true },
  );
  const { code, stdout, stderr } = await run([
    'skills', 'install', 'slice-commit', '--root', dir, '--variant', 'web', '--yes',
  ]);
  assert.equal(code, 0);
  assert.match(stdout, /^install slice-commit \(variant web\)$/m);
  assert.match(stdout, /^source\s+simt-social\/\.agents\/skills\/slice-commit/m);
  // The note is a diagnostic, so it goes to stderr like every other note.
  assert.match(stderr, /already holds the api body/);
});

test('skills show: reads the body a single-repo clone already holds', async () => {
  const dir = await singleRepoClone('slice-commit');
  const { code, stdout } = await run(['skills', 'show', 'slice-commit', '--root', dir, '--max-bytes', '0'], {
    SIMT_DEV_WORKSPACE: 'off',
  });
  assert.equal(code, 0);
  assert.match(stdout, /^body\s+repo\s+/m);
  assert.ok(!stdout.includes('body unavailable'), 'the body was on disk all along');
});
