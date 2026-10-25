// Rule packs - one shared set of rules across repositories, pinned by digest.
//
// The claim under test throughout is that a pack's bytes are accounted for. Every
// fixture here stages a real directory with a real digest, because the failure this
// feature could ship is a repository whose region quietly stops containing half its
// rules and whose gate stays green.
//
// Staged in a temp directory with no siblings, per ADR-031, and every command run
// through the binary rather than imported, so what is tested is what a reader runs.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

import { plan } from '../src/projection/project.mjs';
import { desiredRegion } from '../src/projection/rules.mjs';
import { loadRules, select } from '../src/projection/rules.mjs';
import { buildManifest, manifestText } from '../src/projection/manifest.mjs';
import { provenanceDigest } from '../src/projection/rules.mjs';
import { packageVersion } from '../src/package-version.mjs';
import { packDigest, resolvePacks, PACK_DIR } from '../src/packs.mjs';
import { MANIFEST_FILE } from '../src/name.mjs';
import { git } from './fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, '..', 'bin', 'simt-dev.mjs');
const exec = promisify(execFile);
const made = [];

after(async () => {
  for (const dir of made) await rm(dir, { recursive: true, force: true });
});

async function scratch(prefix = 'simt-packs-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

/**
 * One run of the real binary. `execFile` rejects on a non-zero exit and never reports
 * a code on success, so a test asserting "it exits 0" has to read both paths.
 */
async function run(args) {
  try {
    const { stdout, stderr } = await exec('node', [BIN, ...args], { maxBuffer: 16 << 20 });
    return { code: 0, out: stdout + stderr };
  } catch (error) {
    return { code: error.code, out: (error.stdout ?? '') + (error.stderr ?? '') };
  }
}

const HOUSE_RULE = `---
simt-id: house-node
simt-title: House node rules
simt-applies: [node]
---

## House rule

Every repository in this group keeps its notes under \`docs/\`.
`;

/**
 * A git repository that declares one pack called `house`, pinned to whatever the
 * pack's bytes actually digest to. Pinned by default, because an unpinned pack is a
 * finding and most of what follows is about what happens once it is recorded.
 */
async function repoWithPack({ pin = true, body = HOUSE_RULE } = {}) {
  const root = join(await scratch(), 'repo-a');
  await mkdir(join(root, PACK_DIR, 'house', 'rules', 'stacks'), { recursive: true });
  await writeFile(join(root, 'package.json'), `${JSON.stringify({ name: 'repo-a', version: '1.0.0', scripts: { test: 'node -e ""' } }, null, 2)}\n`);
  await writeFile(join(root, 'README.md'), '# repo-a\n');
  await writeFile(join(root, PACK_DIR, 'house', 'rules', 'stacks', 'house-node.md'), body);
  await git(['init', '-q', root]);
  await git(['-C', root, 'add', '.']);
  await git(['-C', root, 'commit', '-qm', 'initial']);

  const digest = await packDigest(join(root, PACK_DIR, 'house'));
  const manifest = buildManifest({ root, stack: ['node'], sha: 'abc1234', version: '0.2.1' });
  // The gates a stack seeds are gates this fixture cannot run, and the pin names the
  // rule bytes rather than this test's placeholder. Both would leave the gate red for
  // a reason that has nothing to do with packs, so the fixture declares what it can
  // run and pins the content that is actually on disk.
  manifest.gates = { preCommit: ['test'], prePush: [], commands: { test: 'npm test' } };
  manifest.projection = { simtDevSha: await provenanceDigest(), version: packageVersion() };
  manifest.packs = [
    { name: 'house', source: 'git+https://example.invalid/house.git', version: '0.1.0', ...(pin ? { digest } : {}) },
  ];
  await writeFile(join(root, MANIFEST_FILE), manifestText(manifest));
  // Everything the projection produces, written. A fixture that never projects is a
  // fixture whose gate is red for a reason that has nothing to do with the test, and
  // so is one whose commits are ungated.
  const { targets } = await plan(root);
  for (const t of targets) await writeFile(t.path, t.text);
  await run(['hooks', 'install', '--yes', '--root', root]);
  return { root, digest };
}

/** What `sync` would write for AGENTS.md, without writing it. */
async function desired(root) {
  const { body, meta } = await desiredRegion(root, {});
  return { body, sources: meta.sources };
}

test("a pack's rules reach the region, and the region names the pack directory", async () => {
  const { root } = await repoWithPack();
  const { body, sources } = await desired(root);
  assert.match(body, /Every repository in this group keeps its notes/);
  // The source list is how a reader answers "where did this rule come from", so a
  // pack rule that arrived without one would be unattributable text.
  assert.ok(
    sources.includes(`${PACK_DIR}/house/rules/stacks/house-node.md`),
    `region sources were ${JSON.stringify(sources)}`,
  );
});

test('precedence is the repository, then the pack, then what the tool ships', async () => {
  const { root } = await repoWithPack();
  // The pack claims an id the built-in set already ships, and the repository ships a
  // profile claiming an id the pack also claims.
  await writeFile(
    join(root, PACK_DIR, 'house', 'rules', 'stacks', 'node.md'),
    '---\nsimt-id: node\nsimt-applies: [node]\n---\n\n## From the pack\n',
  );
  await mkdir(join(root, '.simt', 'profiles'), { recursive: true });
  await writeFile(
    join(root, '.simt', 'profiles', 'local.md'),
    '---\nsimt-id: house-node\nsimt-applies: [node]\n---\n\n## From the repository\n',
  );

  const { selected, shadowed } = select(await loadRules(root), ['node'], []);
  assert.equal(selected.find((r) => r.id === 'node').source, `${PACK_DIR}/house/rules/stacks/node.md`);
  assert.equal(selected.find((r) => r.id === 'house-node').source, '.simt/profiles/local.md');
  // Both replacements are reported, because a profile that silently replaced another
  // leaves a reader unable to tell which of two texts they are being held to.
  assert.deepEqual(shadowed.map((s) => s.id).sort(), ['house-node', 'node']);
  assert.ok(
    shadowed.every((s) => s.ok),
    'a precedence the tool resolved is not a defect',
  );
});

test('a pack whose bytes no longer match its pin still projects, and the gate names both digests', async () => {
  const { root, digest } = await repoWithPack();
  await writeFile(
    join(root, PACK_DIR, 'house', 'rules', 'stacks', 'house-node.md'),
    '---\nsimt-id: house-node\nsimt-applies: [node]\n---\n\n## Edited\n\nThe rule changed.\n',
  );

  // Projected, not dropped. Dropping it would let the remedy this finding names -
  // `sync --yes` - delete every rule the pack carries, which is the opposite of what
  // a reader who ran it meant.
  assert.match((await desired(root)).body, /The rule changed/);

  const { code, out } = await run(['check', '--root', root]);
  assert.equal(code, 1, 'a region nobody can account for must not be green');
  assert.match(out, /PACK-DIGEST-MISMATCH/);
  assert.ok(out.includes(digest), 'the digest it disagrees with must be printed');
  assert.match(out, /remedy: restore the pinned bytes/);
});

test('a declared pack with no directory blocks the gate, with a remedy that restores it', async () => {
  const { root } = await repoWithPack();
  await rm(join(root, PACK_DIR, 'house'), { recursive: true, force: true });

  const { packs, findings } = await resolvePacks(root);
  assert.equal(packs.length, 1);
  assert.equal(packs[0].present, false);
  assert.equal(packs[0].ok, false);
  assert.equal(findings[0].status, 'pack-missing');
  // The remedy restores the bytes this manifest's digest names, and `sync` is not it:
  // a sync would render the region without the pack and call it current.
  assert.match(findings[0].remedy, /git checkout -- \.simt\/packs\/house/);

  const { code, out } = await run(['check', '--root', root]);
  assert.equal(code, 1);
  assert.match(out, /PACK-MISSING/);
});

test('an unpinned pack is reported and does not block', async () => {
  const { root, digest } = await repoWithPack({ pin: false });

  const { packs } = await resolvePacks(root);
  assert.equal(packs[0].ok, true, 'an absent pin is a missing record, not a mismatch');
  assert.equal(packs[0].digest, digest);

  const { code, out } = await run(['check', '--root', root]);
  assert.equal(code, 0, 'a pack whose rules render correctly must not fail the gate over an optional field');
  assert.match(out, /PACK-UNPINNED/);
  assert.ok(out.includes(digest), 'the digest to record must be printed, not merely requested');
});

test('compare reports each pack and its pinned digest per repository', async () => {
  const { root, digest } = await repoWithPack();

  const clean = await run(['compare', root, '--json']);
  assert.equal(clean.code, 0);
  assert.deepEqual(JSON.parse(clean.out).rows[0].packs, [
    { name: 'house', source: 'git+https://example.invalid/house.git', version: '0.1.0', digest, ok: true },
  ]);

  await writeFile(join(root, PACK_DIR, 'house', 'rules', 'stacks', 'house-node.md'), 'edited\n');
  const broken = JSON.parse((await run(['compare', root, '--json'])).out).rows[0];
  assert.equal(broken.packs[0].ok, false);
  // The digest stays the PINNED one. It answers "which bytes was this declared at",
  // and a row that quietly reported the new digest would hide the mismatch from
  // anything reading the JSON.
  assert.equal(broken.packs[0].digest, digest);
  assert.ok(
    broken.problems.some((p) => p.includes('is pinned to')),
    `problems were ${JSON.stringify(broken.problems)}`,
  );
});

test('a pack name that is not a usable directory name is refused', async () => {
  const { root } = await repoWithPack();
  const manifest = JSON.parse(await readFile(join(root, MANIFEST_FILE), 'utf8'));
  manifest.packs = [{ name: '../escape', version: '0.1.0', digest: 'x' }];
  await writeFile(join(root, MANIFEST_FILE), manifestText(manifest));

  const { packs, findings } = await resolvePacks(root);
  assert.deepEqual(packs, [], 'a name that escapes the pack directory is not a pack');
  assert.equal(findings[0].status, 'pack-name-invalid');

  assert.equal((await run(['check', '--root', root])).code, 1);
});

test('a pack is a rule set, not a second skill registry', async () => {
  // ADR-061 ruled the registry to be workspace data. A pack that carried one would
  // reopen that decision by accident, so the file is readable and inert.
  const { root } = await repoWithPack();
  await mkdir(join(root, PACK_DIR, 'house', 'graph'), { recursive: true });
  await writeFile(
    join(root, PACK_DIR, 'house', 'graph', 'skills.graph.json'),
    `${JSON.stringify({ version: 1, skills: [{ id: 'house-skill', name: 'house-skill', sources: [] }] }, null, 2)}\n`,
  );
  const { out } = await run(['skills', 'index', '--root', root]);
  assert.ok(!out.includes('house-skill'), `a pack's registry must not be read as one: ${out}`);
});

test('a fresh adoption records an empty packs list, and a re-init keeps what the repo declared', async () => {
  const root = join(await scratch(), 'fresh');
  await mkdir(root, { recursive: true });
  const manifest = buildManifest({ root, stack: [], sha: 'abc1234', version: '0.2.1' });
  assert.deepEqual(manifest.packs, []);
  assert.match(manifestText(manifest), /"packs": \[\]/);

  // `init` re-runs adoption and must not empty a field the reader owns.
  const reinit = buildManifest({ root, stack: [], sha: 'abc1234', version: '0.2.1', existing: { packs: [{ name: 'house' }] } });
  assert.deepEqual(reinit.packs, [{ name: 'house' }]);
});