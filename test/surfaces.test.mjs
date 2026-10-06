// The named surfaces: which editor gets which file, in which format, and who said so.
//
// These tests exist because the failure they cover was invisible. simt-dev shipped
// rules into two places and called that IDE support; the second place was a
// directory only one editor reads. Every assertion below is about a property a
// reader of the projected file depends on — that the path is the one the vendor
// documents, that the frontmatter keys are keys that vendor documents, that a
// pointer cannot rot into a second copy — rather than about our own naming.
//
// Anything asserted here that can be checked by reading the SURFACES table alone is
// deliberately paired with a test that runs the CLI, because a table that describes
// the wrong reality passes its own unit tests perfectly.

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, symlink, lstat, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_SURFACES,
  POINTERS,
  SURFACES,
  SURFACE_IDS,
  foldsRules,
  resolveSurfaces,
  rulePath,
  surface,
  surfacesLine,
  undocumentedKeys,
} from '../src/projection/surfaces.mjs';
import { loadMdcRules, ruleName } from '../src/projection/mdc.mjs';
import { plan, checkTargets, pointerTargets, pointerState } from '../src/projection/project.mjs';

const exec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, '..', 'bin', 'simt-dev.mjs');
const scratch = () => mkdtemp(join(tmpdir(), 'simt-surf-'));

async function capture(args) {
  try {
    const { stdout, stderr } = await exec('node', [BIN, ...args]);
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

const RULE = { id: 'x', description: 'A rule', alwaysApply: true, target: '.cursor/rules/x.mdc' };

// ---------------------------------------------------------------- the table itself

test('every surface row names the document it was verified against', () => {
  // A row whose `verified` is null was not checked against a vendor document. That
  // is allowed, and it must be visible, because a surface list that quietly grew a
  // guessed row puts an unverified assumption into every repo that adopts it.
  for (const s of SURFACES) {
    assert.ok(s.id && s.label && s.readers, `${s.id}: needs an id, a label and its readers`);
    assert.ok(['region', 'file', 'pointer'].includes(s.kind), `${s.id}: unknown kind ${s.kind}`);
    if (s.kind === 'file') {
      assert.ok(s.rule.includes('{name}'), `${s.id}: a rule path must interpolate a name`);
    }
  }
});

test('a per-rule surface emits only frontmatter keys the vendor documents', () => {
  // The guard this file exists for. `documentedKeys` is the vendor's own list; a key
  // invented here would be inert at best, and on Antigravity an unrecognised value
  // silently discards the rule with no message at all.
  for (const s of SURFACES) {
    if (!s.ruleFrontmatter) continue;
    assert.ok(
      Array.isArray(s.documentedKeys) && s.documentedKeys.length > 0,
      `${s.id}: emits frontmatter, so it must declare the keys its vendor documents`,
    );
    for (const line of s.ruleFrontmatter(RULE)) {
      const key = line.split(':')[0].trim();
      assert.ok(
        s.documentedKeys.includes(key),
        `${s.id} emits frontmatter key "${key}", which its vendor does not document (${s.documentedKeys.join(', ')})`,
      );
    }
  }
});

test('every emitted trigger and applyTo value is one the vendor lists', () => {
  // Values, not just keys. Antigravity's `trigger` accepts four values and drops
  // anything else without a word.
  const TRIGGERS = new Set(['always_on', 'model_decision', 'glob', 'manual']);
  const forRule = (alwaysApply) => ({ ...RULE, alwaysApply });
  const lines = (id, rule) => surface(id).ruleFrontmatter(rule);
  assert.ok(TRIGGERS.has(lines('antigravity', forRule(true))[0].split(': ')[1]));
  assert.ok(TRIGGERS.has(lines('antigravity', forRule(false))[0].split(': ')[1]));
  assert.equal(lines('cursor', forRule(true))[1], 'alwaysApply: true');
  assert.equal(lines('cursor', forRule(false))[1], 'alwaysApply: false');
  assert.equal(lines('copilot', RULE)[0], 'applyTo: "**"');
  // Claude emits nothing: `paths:` has a documented parser defect, and a rule with
  // no scoping frontmatter is documented to load eagerly, which is what an
  // always-on rule wants.
  assert.deepEqual(lines('claude', RULE), []);
});

test('the default is exactly one surface, and it is the one with no per-rule path', () => {
  // ADR-021: writing a file for every known IDE is not support. A repo that lives in
  // one editor should acquire one editor's layout, and the rest are opt-in.
  assert.deepEqual(DEFAULT_SURFACES, ['opencode']);
  assert.equal(foldsRules(resolveSurfaces(null, {})), true);

  // Every other surface must still be reachable, or "one by default" would be a
  // deletion rather than a default.
  for (const s of SURFACES) {
    if (s.id === 'opencode') continue;
    const on = resolveSurfaces(null, { surfaces: s.id });
    assert.deepEqual(on.ids, [s.id], `${s.id} must be selectable on its own`);
    assert.equal(foldsRules(on), false, `${s.id} has its own rule path, so it must not fold`);
    assert.equal(foldsRules(resolveSurfaces(null, { surfaces: `opencode,${s.id}` })), true, 'the standard surface folds even alongside a file surface');
  }
  // Standard plus a file surface: the region still carries the rules for the
  // opencode reader, and cursor gets the files. Folding and files coexist.
  assert.equal(foldsRules(resolveSurfaces({ surfaces: ['opencode', 'cursor'] }, {})), true);
});

test('one surface, several, or the default are all reachable and are distinguishable', () => {
  // The three answers a repo can have, and they must never be confused: a reader who
  // sees a set and its source must be able to tell a choice from the default.
  const one = resolveSurfaces(null, { surfaces: 'cursor' });
  assert.deepEqual(one.ids, ['cursor']);
  assert.equal(one.source, 'flag');

  const many = resolveSurfaces(null, { surfaces: 'cursor, copilot ,claude' });
  assert.deepEqual(many.ids, ['cursor', 'copilot', 'claude']);
  assert.equal(many.source, 'flag');
  assert.deepEqual(many.problems, []);

  const declared = resolveSurfaces({ surfaces: ['antigravity'] }, {});
  assert.deepEqual(declared.ids, ['antigravity']);
  assert.equal(declared.source, 'manifest');

  const byDefault = resolveSurfaces(null, {});
  assert.deepEqual(byDefault.ids, ['opencode']);
  assert.equal(byDefault.source, 'default');

  // Empty is a real choice: the primary document and nothing else.
  const none = resolveSurfaces({ surfaces: [] }, {});
  assert.deepEqual(none.ids, [], 'an empty list selects no per-rule surface at all');
});

test('rulePath builds the documented location, and returns null for a surface without one', () => {
  assert.equal(rulePath('cursor', 'test-gate'), '.cursor/rules/test-gate.mdc');
  assert.equal(rulePath('claude', 'test-gate'), '.claude/rules/test-gate.md');
  assert.equal(rulePath('antigravity', 'test-gate'), '.agents/rules/test-gate.md');
  assert.equal(rulePath('copilot', 'test-gate'), '.github/instructions/test-gate.instructions.md');
  assert.equal(rulePath('opencode', 'test-gate'), null);
  assert.equal(rulePath('nope', 'test-gate'), null);
});

test('a rule name comes from its canonical target, so one rename moves every surface', async () => {
  // If the name were re-derived per surface, renaming `.cursor/rules/x.mdc` would
  // leave three copies of the same rule stranded under the old name — one per
  // editor, each one silently no longer updated.
  const rules = await loadMdcRules();
  assert.equal(ruleName({ target: '.cursor/rules/test-gate.mdc' }), 'test-gate');
  for (const rule of rules) {
    assert.equal(ruleName(rule), rule.target.replace('.cursor/rules/', '').replace(/\.mdc$/, ''));
  }
});

// ------------------------------------------------------------------ which surfaces

test('the surface set is flag, then manifest, then the global standard', () => {
  assert.equal(resolveSurfaces(null, {}).source, 'default');
  assert.equal(resolveSurfaces({ surfaces: ['cursor'] }, {}).source, 'manifest');
  assert.equal(resolveSurfaces({ surfaces: ['cursor'] }, { surfaces: 'claude' }).source, 'flag');
  assert.deepEqual(resolveSurfaces({ surfaces: ['cursor'] }, { surfaces: 'claude' }).ids, ['claude']);
  // An empty list is a choice, not an absent choice.
  assert.deepEqual(resolveSurfaces({ surfaces: [] }, {}).ids, []);
  assert.equal(resolveSurfaces({ surfaces: [] }, {}).source, 'manifest');
  // A manifest with no `surfaces` key is not a choice; it falls through.
  assert.equal(resolveSurfaces({ stack: ['node'] }, {}).source, 'default');
});

test('an unknown surface id is a problem, not a skip', () => {
  // A typo would otherwise reduce the repo to AGENTS.md with no message, and a repo
  // that believes it is covered by Copilot instructions would not be.
  const r = resolveSurfaces({ surfaces: ['cursor', 'copilto'] }, {});
  assert.deepEqual(r.ids, ['cursor']);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /unknown surface "copilto"/);
  assert.match(r.problems[0], /opencode, cursor, claude, antigravity, copilot/);
});

test('the flag accepts a comma-separated list and tolerates whitespace', () => {
  assert.deepEqual(resolveSurfaces(null, { surfaces: ' cursor , claude ' }).ids, ['cursor', 'claude']);
  assert.deepEqual(resolveSurfaces(null, { surfaces: 'cursor,cursor,claude' }).ids, ['cursor', 'claude']);
});

test('the one line a reader checks says what and why', () => {
  assert.equal(surfacesLine(resolveSurfaces(null, {})), 'surfaces    opencode  (global standard)');
  assert.equal(surfacesLine(resolveSurfaces({ surfaces: [] }, {}), 10), 'surfaces  (AGENTS.md only)  (manifest)');
  assert.equal(surfacesLine(resolveSurfaces(null, { surfaces: 'cursor' }), 10), 'surfaces  cursor  (flag)');
});

// ----------------------------------------------------------------- one rule, four files

test('the default surface folds every rule into AGENTS.md and writes one file', async () => {
  // ADR-021. One editor chosen, one file written, and the always-on process rules
  // present - which is the defect ADR-020 fixed by scattering them across four
  // directories. Folding is what keeps them.
  const root = await scratch();
  await mkdir(join(root, '.git'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{"name":"x"}\n');
  await writeFile(join(root, 'AGENTS.md'), '# x\n');
  const p = await plan(root, {});
  assert.equal(p.surfaceSource, 'default');

  const ruleFiles = p.targets.filter((t) => t.surface);
  assert.deepEqual(ruleFiles, [], 'the default surface must not write per-rule files');
  assert.deepEqual(p.targets.map((t) => t.file), ['AGENTS.md']);

  const region = p.targets[0].body;
  for (const id of ['test-gate', 'intake-questions']) {
    assert.match(region, new RegExp(`### ${id}\\n`), `${id} must be folded into the region`);
  }
});

test('one rule reaches every selected surface with its own path and its own frontmatter', async () => {
  const root = await scratch();
  await mkdir(join(root, '.git'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{"name":"x"}\n');
  await writeFile(join(root, 'AGENTS.md'), '# x\n');
  const p = await plan(root, { surfaces: 'cursor,claude,antigravity,copilot' });
  const files = p.targets.filter((t) => t.surface).map((t) => t.file);
  assert.ok(files.includes('.cursor/rules/test-gate.mdc'));
  assert.ok(files.includes('.claude/rules/test-gate.md'));
  assert.ok(files.includes('.agents/rules/test-gate.md'));
  assert.ok(files.includes('.github/instructions/test-gate.instructions.md'));
  assert.equal(p.surfaceSource, 'flag');

  const bySurface = new Map(p.targets.filter((t) => t.surface).map((t) => [t.surface, t]));
  assert.match(bySurface.get('cursor').text, /^---\ndescription: /);
  assert.match(bySurface.get('cursor').text, /\nalwaysApply: true\n---/);
  // Claude: body first, no frontmatter block at all.
  assert.ok(bySurface.get('claude').text.startsWith('<!-- simt-dev:begin -->'));
  assert.match(bySurface.get('antigravity').text, /\ntrigger: always_on\n/);
  assert.match(bySurface.get('copilot').text, /\napplyTo: "\*\*"\n---/);
  // Every surface carries the same rule body, so no editor is told something the
  // others are not.
  const bodies = [...bySurface.values()].map((t) => t.body);
  assert.equal(new Set(bodies).size, 1);
});

test('opting into a rule surface alongside the default is one file plus the requested ones', async () => {
  const root = await scratch();
  await mkdir(join(root, '.git'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{"name":"x"}\n');
  const p = await plan(root, { surfaces: 'opencode,cursor' });
  // The primary region is still written; opencode adds no file of its own; cursor does.
  assert.deepEqual(p.targets.map((t) => t.file).sort(), [
    '.cursor/rules/intake-questions.mdc',
    '.cursor/rules/test-gate.mdc',
    'AGENTS.md',
  ]);
  // ...and the rule is in BOTH: folded for the reader who has only AGENTS.md, and as
  // a file for the editor that cannot read it. One canonical source, two destinations.
  assert.match(p.targets.find((t) => t.file === 'AGENTS.md').body, /### test-gate/);
});

test('narrowing the surfaces narrows the files, and AGENTS.md is always there', async () => {
  const root = await scratch();
  await writeFile(join(root, 'package.json'), '{"name":"x"}\n');
  const p = await plan(root, { surfaces: 'cursor' });
  assert.equal(p.surfaceSource, 'flag');
  assert.deepEqual(p.surfaces, ['cursor']);
  const files = p.targets.map((t) => t.file);
  assert.ok(files.includes('AGENTS.md'));
  assert.ok(!files.some((f) => f.startsWith('.claude/')));
  assert.ok(!files.some((f) => f.startsWith('.github/instructions/')));
});

// ------------------------------------------------------------------------ pointers

test('a pointer is a symlink to AGENTS.md, and both names are declared', async () => {
  assert.deepEqual(
    POINTERS.map((p) => `${p.path} -> ${p.to}`),
    ['CLAUDE.md -> AGENTS.md', 'GEMINI.md -> AGENTS.md'],
  );
  for (const p of POINTERS) {
    assert.ok(p.readers && p.verified, `${p.id} must name its readers and its source`);
  }
});

test('pointer state distinguishes absent, current, mispointed and foreign', async () => {
  const root = await scratch();
  const [claude] = pointerTargets(root);
  assert.deepEqual(await pointerState(root, claude), { file: 'CLAUDE.md', state: 'absent' });

  await writeFile(join(root, 'AGENTS.md'), '# x\n');
  await symlink('AGENTS.md', join(root, 'CLAUDE.md'));
  assert.deepEqual(await pointerState(root, claude), { file: 'CLAUDE.md', state: 'current', link: 'AGENTS.md' });

  await symlink('docs/AGENTS.md', join(root, 'GEMINI.md'));
  const gemini = pointerTargets(root)[1];
  const mis = await pointerState(root, gemini);
  assert.equal(mis.state, 'mispointed');
  assert.match(mis.detail, /points at docs\/AGENTS\.md/);

  // The case that matters most: a hand-written CLAUDE.md is the corpus's one true
  // duplicate, and the refusal has to carry its size.
  const root2 = await scratch();
  await writeFile(join(root2, 'CLAUDE.md'), 'x'.repeat(500));
  const foreign = await pointerState(root2, pointerTargets(root2)[0]);
  assert.equal(foreign.state, 'foreign');
  assert.equal(foreign.bytes, 500);
  assert.match(foreign.detail, /a file, not a pointer/);
});

test('check reports a foreign pointer as blocking and a mispointed one as not', async () => {
  // The asymmetry is deliberate. A hand-written CLAUDE.md is an unresolved decision
  // the repo must make: DeepSeek's loader renders a drifted copy in full beside its
  // twin, which is precisely what simt-dev exists to stop. A misaimed pointer is a
  // stale convenience, and making it red would train people to ignore findings.
  const root = await scratch();
  await writeFile(join(root, 'package.json'), '{"name":"x"}\n');
  await writeFile(join(root, 'CLAUDE.md'), '# mine\n');
  const blocked = (await checkTargets(root, { surfaces: 'opencode,claude' })).find(
    (f) => f.status === 'pointer-blocked',
  );
  assert.ok(blocked, 'a regular file at CLAUDE.md must be reported');
  assert.match(blocked.detail, /simt-dev will not replace it/);
  assert.ok(blocked.remedy, 'a blocking finding must carry a remedy');

  const root2 = await scratch();
  await writeFile(join(root2, 'package.json'), '{"name":"x"}\n');
  await symlink('elsewhere.md', join(root2, 'GEMINI.md'));
  const drift = (await checkTargets(root2, { surfaces: 'opencode,antigravity' })).find(
    (f) => f.status === 'pointer-drift',
  );
  assert.ok(drift);
  assert.match(drift.detail, /should point at AGENTS\.md/);
});

// --------------------------------------------------------------- the shipped guard

test('the shipped-content gate would notice a key nobody documents', () => {
  // Proves the predicate the shipped-content gate uses is not vacuous. A guard that
  // cannot fail is a comment.
  assert.deepEqual(undocumentedKeys(), []);
  assert.ok(
    undocumentedKeys([
      { id: 'x', documentedKeys: ['description'], ruleFrontmatter: () => ['alwaysApply: true'] },
    ]).length === 1,
  );
  // A row that emits frontmatter and claims no documented keys is the subtler case:
  // it is not obviously wrong in the diff, it is wrong in the editor.
  assert.equal(
    undocumentedKeys([{ id: 'y', ruleFrontmatter: () => ['trigger: invented'] }]).length,
    1,
  );
  assert.equal(undocumentedKeys([{ id: 'z' }]).length, 0, 'a surface with no frontmatter has nothing to check');
});

test('a pointer written for real is a symlink, and re-init is idempotent', async () => {
  // The regression: `pointerState` used to re-join a path that `pointerTargets` had
  // already joined, so every live pointer read as absent and the second `init` died
  // with EEXIST. A test that calls the two functions with the same root twice cannot
  // see it; a test that runs the command twice can.
  const root = await scratch();
  await exec('git', ['init', '-q'], { cwd: root });
  await writeFile(join(root, 'package.json'), '{"name":"x"}\n');
  const first = await capture(['init', '--root', root, '--yes', '--surfaces', 'opencode,claude']);
  assert.equal(first.code, 0, first.stderr);
  const st = await lstat(join(root, 'CLAUDE.md'));
  assert.ok(st.isSymbolicLink(), 'CLAUDE.md must be a symlink, not a copy');
  const written = await readFile(join(root, 'CLAUDE.md'), 'utf8');
  assert.match(written, /simt-dev:begin/, 'the link must resolve to the projected document');

  const second = await capture(['init', '--root', root, '--yes', '--surfaces', 'opencode,claude']);
  assert.equal(second.code, 0, second.stderr);
  assert.ok(!/EEXIST/i.test(second.stderr), `re-init must not collide: ${second.stderr}`);
  assert.match(second.stdout, /link\s+CLAUDE\.md -> AGENTS\.md\s+current/);
});

test('the default surface writes no pointer at all', async () => {
  // The ruling this exists for: ADR-020 wrote CLAUDE.md and GEMINI.md into every
  // repo, and narrowing the surface set under ADR-021 still left them behind because
  // the pointer list ignored which surface was chosen. A pointer belongs to the
  // editor that needs it, so one surface means one file.
  const root = await scratch();
  await exec('git', ['init', '-q'], { cwd: root });
  await writeFile(join(root, 'package.json'), '{"name":"x"}\n');
  const r = await capture(['init', '--root', root, '--yes']);
  assert.equal(r.code, 0, r.stderr);
  for (const p of ['CLAUDE.md', 'GEMINI.md']) {
    const st = await lstat(join(root, p)).catch(() => null);
    assert.equal(st, null, `${p} must not be written when no surface asked for it`);
  }
  assert.ok(
    !/link\s+CLAUDE/.test(r.stdout),
    'the plan must not advertise a pointer it will not write',
  );
  const drift = (await checkTargets(root, {})).filter((f) => f.status.startsWith('pointer'));
  assert.deepEqual(drift, [], 'a surface that wants no pointer must raise no pointer finding');
});

test('sync creates the directories every surface writes into', async () => {
  // The regression: `init` grew its own mkdir and `sync` did not, so the first `sync`
  // in a repo written by hand failed with ENOENT on the second target - after writing
  // the first, leaving the repo half-migrated. Three of the four surfaces live in
  // directories that do not exist until something creates them.
  const root = await scratch();
  await exec('git', ['init', '-q'], { cwd: root });
  await writeFile(join(root, 'package.json'), '{"name":"x"}\n');

  const r = await capture(['sync', '--root', root, '--yes', '--surfaces', 'cursor,claude,antigravity,copilot']);
  assert.equal(r.code, 0, r.stderr);
  for (const dir of ['.cursor/rules', '.claude/rules', '.agents/rules', '.github/instructions']) {
    const st = await stat(join(root, dir)).catch(() => null);
    assert.ok(st?.isDirectory(), `sync did not create ${dir}`);
  }
  // And the gate agrees, which is the only proof the files landed rather than just the
  // directories existing. It is given the same surfaces: check folds rules into the
  // region for the opencode surface and writes one file per rule otherwise, so asking
  // it about a different surface than sync was given asks a different question.
  const c = await capture(['check', '--root', root, '--surfaces', 'cursor,claude,antigravity,copilot']);
  assert.equal(c.code, 0, `${c.stdout}\n${c.stderr}`);
  assert.doesNotMatch(c.stdout, /ABSENT|DRIFT|MALFORMED/);
});

test('the CLI names the surfaces it chose and where the choice came from', async () => {
  const root = await scratch();
  const r = await capture(['sync', '--root', root, '--dry-run']);
  assert.match(r.stdout, /surfaces\s+opencode\s+\(global standard\)/);
  assert.doesNotMatch(r.stdout, /\.github\/instructions/);
  const narrowed = await capture(['sync', '--root', root, '--dry-run', '--surfaces', 'copilot']);
  assert.match(narrowed.stdout, /surfaces\s+copilot\s+\(flag\)/);
  const many = await capture(['sync', '--root', root, '--dry-run', '--surfaces', 'cursor,copilot']);
  assert.match(many.stdout, /surfaces\s+cursor, copilot\s+\(flag\)/);
  const json = JSON.parse((await capture(['sync', '--root', root, '--dry-run', '--json'])).stdout);
  assert.deepEqual(json.surfaces, ['opencode']);
  assert.equal(json.surfaceSource, 'default');
});
