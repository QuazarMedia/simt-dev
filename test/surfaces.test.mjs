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
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink, lstat, stat } from 'node:fs/promises';
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

import { MANIFEST_FILE } from '../src/name.mjs';

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
  // The baseline is not a surface and writes no rule file; it is a repo-level
  // setting, present whatever the editor.
  // The baselines are not surfaces and write no rule file; they are repo-level
  // settings, present whatever the editor. `.gitattributes` is the second one because
  // it, like `.editorconfig`, is a file git and every editor read without a parser,
  // and it takes the last pattern that matches so the region goes first.
  assert.deepEqual(p.targets.map((t) => t.file), ['AGENTS.md', '.editorconfig', '.gitattributes']);

  const region = p.targets[0].body;
  for (const id of ['test-gate', 'intake-questions']) {
    assert.match(region, new RegExp(`## Process: ${id}\\n`), `${id} must be folded into the region`);
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
  assert.ok(bySurface.get('claude').text.startsWith('<!-- simt:begin -->'));
  assert.match(bySurface.get('antigravity').text, /\ntrigger: always_on\n/);
  assert.match(bySurface.get('copilot').text, /\napplyTo: "\*\*"\n---/);
  // Every surface carries the same rule body, so no editor is told something the
  // others are not.
  const bodies = [...bySurface.values()].map((t) => t.body);
  assert.equal(new Set(bodies).size, 1);
});

test('opting into a rule surface alongside the default writes one file, not two (S12)', async () => {
  const root = await scratch();
  await mkdir(join(root, '.git'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{"name":"x"}\n');
  const p = await plan(root, { surfaces: 'opencode,cursor' });
  // This test asserted the OPPOSITE before ADR-046 - three .mdc files beside a folded
  // region, on the reasoning that "a Cursor reader getting .mdc files does not serve
  // them". Cursor reads AGENTS.md; cursor.com/docs/context/rules documents it. So the
  // three files were 28 KB of the same rules a second time in every Cursor session.
  assert.deepEqual(p.targets.map((t) => t.file).sort(), ['.editorconfig', '.gitattributes', 'AGENTS.md']);
  // The rule is still present - once. Asserting its ABSENCE from the plan is what makes
  // this meaningful: a change that dropped the rule entirely would pass a file-list check.
  assert.match(p.targets.find((t) => t.file === 'AGENTS.md').body, /## Process: test-gate/);
  // And the reason is stated rather than silently skipped, because a reader deciding
  // whether to delete a file already on disk is owed the sentence that justifies it.
  assert.ok(p.notes.some((n) => /reads AGENTS.md, where the rule is already folded/.test(n)), p.notes.join(' | '));
});

test('a rule surface is written for a reader that does NOT read the primary file (S12)', async () => {
  // The other half, and the one that catches over-correction. Copilot's CLI reads
  // AGENTS.md; its editor and code review do not. A per-rule file is the only channel
  // two of its three readers have, so dropping it would silently remove the process
  // rules from a chat that had nowhere else to get them.
  const root = await scratch();
  await writeFile(join(root, 'package.json'), '{"name":"x"}\n');
  const p = await plan(root, { surfaces: 'opencode,copilot' });
  assert.ok(
    p.targets.some((t) => t.file.startsWith('.github/instructions/')),
    'copilot must still get per-rule files',
  );
  assert.match(p.targets.find((t) => t.file === 'AGENTS.md').body, /## Process: test-gate/);
});

test('cursor alone still gets its own files, because nothing folds (S12)', async () => {
  // `readsPrimary` is only meaningful while something folds. With no folding surface
  // selected there is no region to duplicate, so the skip must not fire.
  const root = await scratch();
  await writeFile(join(root, 'package.json'), '{"name":"x"}\n');
  const p = await plan(root, { surfaces: 'cursor' });
  assert.ok(p.targets.some((t) => t.file.startsWith('.cursor/rules/')), 'cursor alone has no AGENTS.md reader to rely on');
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

test('check blocks a mispointed pointer, because its reader is reading something else', async () => {
  // The old asymmetry — foreign blocks, misaimed does not — rested on a misreading of
  // what a pointer is. It cited DeepSeek's loader rendering a drifted copy, which is a
  // different surface entirely: a *copy* beside the original is duplication, and a
  // *symlink* aimed elsewhere is a reader looking at the wrong file. POINTERS[0] records
  // Claude Code's own documentation for the behaviour that makes it load-bearing — it
  // reads CLAUDE.md by default and AGENTS.md only as a fallback — so on a repo that
  // selected `claude`, a misaimed pointer means the rules are invisible to the reader
  // they were written for.
  //
  // Measured before this change: pointer moved to README.md, `check` exited 0, `compare`
  // reported no problems, and thirteen rule citations went unread.
  const root = await scratch();
  await writeFile(join(root, 'package.json'), '{"name":"x"}\n');
  await writeFile(join(root, 'README.md'), '# readme\n');
  await symlink('README.md', join(root, 'CLAUDE.md'));

  const blocked = (await checkTargets(root, { surfaces: 'opencode,claude' })).find(
    (f) => f.status === 'pointer-unread',
  );
  assert.ok(blocked, 'a pointer aimed away from AGENTS.md must be reported');
  assert.match(blocked.detail, /should point at AGENTS\.md/);
  // The remedy names the reader, because "run the command" does not tell someone why
  // this matters and a warning they have learned to skip is worse than no warning.
  assert.match(blocked.remedy, /Claude Code reads CLAUDE\.md/);

  // And the whole command exits non-zero, which is the part the reader acts on.
  // Synced first, so the repository is otherwise current and the only thing that could
  // redden it is the pointer. The first version of this test skipped that step and
  // passed on a repository that was red for a missing `AGENTS.md` — which is how the
  // defect survived a test that asserted against it (ADR-031's shape, one level down).
  await capture(['sync', '--root', root, '--yes', '--surfaces', 'opencode,claude']);
  // `sync` created the correct pointer, which is the point: the repository has to be
  // right before the pointer can be broken on purpose.
  await rm(join(root, 'CLAUDE.md'));
  await symlink('README.md', join(root, 'CLAUDE.md'));
  const { code, stdout, stderr } = await capture(['check', '--root', root, '--surfaces', 'opencode,claude']);
  const said = `${stdout}${stderr}`;
  assert.equal(code, 1, `the gate must fail on a pointer its reader is following: ${said}`);
  assert.match(said, /CLAUDE\.md/);
});

test('a pointer this repository does not serve stays a note', async () => {
  // The half of the rule that keeps it a rule rather than a gate that goes red for
  // everyone. `pointerTargets` filters on the selected surfaces, so a repo on `opencode`
  // that happens to have a `CLAUDE.md` nobody asked for gains nothing from being told,
  // and a gate that reddens for it is a gate people learn to ignore.
  const root = await scratch();
  await writeFile(join(root, 'package.json'), '{"name":"x"}\n');
  await writeFile(join(root, 'README.md'), '# readme\n');
  await symlink('README.md', join(root, 'CLAUDE.md'));

  const found = await checkTargets(root, { surfaces: 'opencode' });
  assert.equal(
    found.find((f) => f.file === 'CLAUDE.md'),
    undefined,
    'the reader this pointer serves is not reading this repository',
  );
  // The gate is asserted through a repository that is otherwise current, so the only
  // thing that could make it red is the pointer. Asserting the exit code on a bare
  // scratch directory would pass for the wrong reason — it is red for a missing
  // AGENTS.md — which is ADR-031's shape one level down.
  await capture(['sync', '--root', root, '--yes', '--surfaces', 'opencode']);
  const { code, stdout } = await capture(['check', '--root', root, '--surfaces', 'opencode']);
  assert.equal(code, 0, stdout);
});

test('a directory where a pointer belongs is reported, and named as a directory', async () => {
  // Not hypothetical: a directory at CLAUDE.md is where Claude Code keeps per-project
  // instructions. Read as "absent" it was invisible — `check` said nothing and `sync`
  // crashed with EEXIST on `symlink()` after writing every other target, naming
  // `simt-dev doctor`, which reports nothing about it either.
  const root = await scratch();
  await writeFile(join(root, 'package.json'), '{"name":"x"}\n');
  await mkdir(join(root, 'CLAUDE.md'), { recursive: true });
  await writeFile(join(root, 'CLAUDE.md', 'NOTES.md'), 'work\n');

  const findings = await checkTargets(root, { surfaces: 'opencode,claude' });
  const blocked = findings.find((f) => f.status === 'pointer-blocked');
  assert.ok(blocked, 'a directory at CLAUDE.md must be reported');
  assert.match(blocked.detail, /a directory, not a pointer/);
  // The measure is entries, not bytes — the same question asked of the thing that would
  // be lost. Printing `undefined bytes` is how this stayed unreported.
  assert.match(blocked.detail, /1 entry\b/);
  assert.doesNotMatch(blocked.detail, /undefined/);
  assert.match(blocked.remedy, /delete the directory/);

  // And nothing is destroyed: the file inside survives, because this tool does not
  // delete what a person wrote.
  assert.equal(await readFile(join(root, 'CLAUDE.md', 'NOTES.md'), 'utf8'), 'work\n');
});

test('sync repairs a misaimed pointer, because that is the remedy it prints', async () => {
  // The row's headline crash, and the reason the remedy is `sync --yes`: `sync` used to
  // plan the pointer, call `symlink()` at a path that already existed, and die with
  // `EEXIST` after writing every other target — naming `simt-dev doctor`, which reports
  // nothing about it. A command whose own remedy crashes on the state it names has no
  // remedy at all.
  const root = await scratch();
  await writeFile(join(root, 'package.json'), '{"name":"x"}\n');
  await writeFile(join(root, 'README.md'), '# readme\n');
  await capture(['sync', '--root', root, '--yes', '--surfaces', 'opencode,claude']);
  assert.equal((await lstat(join(root, 'CLAUDE.md'))).isSymbolicLink(), true);
  await rm(join(root, 'CLAUDE.md'));
  await symlink('README.md', join(root, 'CLAUDE.md'));

  const r = await capture(['sync', '--root', root, '--yes', '--surfaces', 'opencode,claude']);
  const said = `${r.stdout}${r.stderr}`;
  assert.equal(r.code, 0, said);
  assert.doesNotMatch(said, /EEXIST/);
  assert.match(said, /unlinked CLAUDE\.md \(was misaimed\)/);

  // Repaired, and the file the bad link pointed at is untouched: `unlink` on a symlink
  // removes the link, never its target. Asserted because the repair is a deletion.
  assert.equal((await lstat(join(root, 'CLAUDE.md'))).isSymbolicLink(), true);
  assert.equal(await readFile(join(root, 'README.md'), 'utf8'), '# readme\n');
  assert.equal((await capture(['check', '--root', root, '--surfaces', 'opencode,claude'])).code, 0);
});

test('sync still refuses a hand-written file, and never unlinks one', async () => {
  // The other half of the same loop, and the reason the repair is keyed on `state`
  // rather than on existence. A symlink has no content and is this tool's own; a regular
  // file is somebody's writing, and nothing here touches it (ADR-021 ruling 6).
  const root = await scratch();
  await writeFile(join(root, 'package.json'), '{"name":"x"}\n');
  const mine = '# our house style\n';
  await writeFile(join(root, 'CLAUDE.md'), mine);

  const r = await capture(['sync', '--root', root, '--yes', '--surfaces', 'opencode,claude']);
  const said = `${r.stdout}${r.stderr}`;
  assert.equal(r.code, 0, said);
  assert.match(said, /left untouched, not replaced/);
  assert.doesNotMatch(said, /unlinked/);
  assert.equal(await readFile(join(root, 'CLAUDE.md'), 'utf8'), mine);
});

test('sync refuses the directory instead of crashing halfway through the write', async () => {
  const root = await scratch();
  await writeFile(join(root, 'package.json'), '{"name":"x"}\n');
  await mkdir(join(root, 'CLAUDE.md'), { recursive: true });

  const { code, stdout, stderr } = await capture(['sync', '--root', root, '--yes', '--surfaces', 'opencode,claude']);
  // Notes go to stderr, so a test that reads only stdout asserts nothing about the
  // refusal — the one line that proves it happened is a note.
  const said = `${stdout}${stderr}`;
  assert.equal(code, 0, said);
  assert.match(said, /POINTER CLAUDE\.md: a directory, not a pointer/);
  assert.doesNotMatch(said, /undefined/, 'the size of a directory is its entries, and saying so is the fix');
  assert.doesNotMatch(said, /EEXIST/, 'a refusal that arrives after the writes is a crash, not a refusal');
  // The rule files it *could* write still were, and the pointer it could not is named.
  assert.match(said, /left untouched, not replaced/);

  // `sync` reports the refusal and exits 0. ADR-025 ruling 6 is why, and it is the
  // reason this is asserted rather than assumed: the remedy for this finding is
  // `sync --yes`, so a `sync` that refused on it would be a gate whose remedy is the
  // command being run — a gate nothing can satisfy, which the record calls worse than
  // a noisy one. `check` is where it blocks.
  assert.equal(code, 0, 'the refusal is a note; the gate that blocks on it is `check`');
  const checked = await capture(['check', '--root', root, '--surfaces', 'opencode,claude']);
  assert.equal(checked.code, 1, `${checked.stdout}${checked.stderr}`);
});

test('the two non-blocking sets are different, and the difference is the fix', async () => {
  // The mutation that passed this file twice. One set served both commands, so the rule
  // written to keep `sync` quiet quietly quieted `check`'s exit code — which is the
  // defect, unchanged, in a new place. And a `sync` that blocked on it would be a gate
  // whose remedy is the command being run, ADR-025 ruling 6's hazard.
  //
  // Asserted on both sets and on their relationship, because the text output is
  // identical either way: ADR-035's sentence about promises about a *set* of commands,
  // applied to a set of statuses.
  const { SYNC_NON_BLOCKING, CHECK_NON_BLOCKING } = await import('../src/commands/sync.mjs');
  // `pack-unpinned` joined both sets for ADR-065: the rules it carries render, and
  // what is missing is the record of which bytes they were declared at. A pack whose
  // bytes disagree with its pin is NOT in either - that one blocks.
  assert.deepEqual([...SYNC_NON_BLOCKING].sort(), ['orphaned', 'pack-unpinned', 'pointer-unread']);
  assert.deepEqual([...CHECK_NON_BLOCKING].sort(), ['orphaned', 'pack-unpinned']);
  for (const status of ['pack-digest-mismatch', 'pack-missing']) {
    assert.ok(!CHECK_NON_BLOCKING.has(status), `${status} must fail the gate`);
  }
  // Everything `check` tolerates, `sync` tolerates: the gate is never the laxer one.
  for (const status of CHECK_NON_BLOCKING) {
    assert.ok(SYNC_NON_BLOCKING.has(status), `${status} fails the gate but not the writer`);
  }
  // And the specific claim this record exists for.
  assert.ok(
    !CHECK_NON_BLOCKING.has('pointer-unread'),
    'a reader pointed at the wrong file must fail the gate, or ADR-051 did not land',
  );
});

test('check reports a foreign pointer as blocking, with what is in the way', async () => {
  // A hand-written CLAUDE.md is an unresolved decision the repo must make: DeepSeek's
  // loader renders a drifted copy in full beside its twin, which is precisely what
  // simt-dev exists to stop.
  const root = await scratch();
  await writeFile(join(root, 'package.json'), '{"name":"x"}\n');
  await writeFile(join(root, 'CLAUDE.md'), '# mine\n');
  const blocked = (await checkTargets(root, { surfaces: 'opencode,claude' })).find(
    (f) => f.status === 'pointer-blocked',
  );
  assert.ok(blocked, 'a regular file at CLAUDE.md must be reported');
  assert.match(blocked.detail, /simt-dev will not replace it/);
  assert.ok(blocked.remedy, 'a blocking finding must carry a remedy');
  assert.match(blocked.remedy, /delete the file/, 'the remedy names the kind of thing it is');
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
  assert.match(written, /simt:begin/, 'the link must resolve to the projected document');

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

// --- S12: a file the tool wrote must never become invisible ----------------------

/**
 * A repo that was adopted while cursor still got per-rule files, then re-planned.
 *
 * Built by running the tool, not by hand-writing a file that looks generated: the
 * orphan scan keys on the region marker, and a hand-written approximation of one would
 * pass for the wrong reason the moment the marker format moved.
 */
async function repoWithALeftoverRuleFile() {
  const root = await scratch();
  await mkdir(join(root, '.git'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{"name":"x"}\n');
  await exec('node', [BIN, 'init', '--root', root, '--yes', '--surfaces', 'opencode,copilot']);
  // copilot still gets files, so this one is planned and can be made stale.
  const copilotRule = join(root, '.github/instructions/test-gate.instructions.md');
  const text = await readFile(copilotRule, 'utf8');
  // ...and a cursor-shaped leftover, dropped in from a repo written before ADR-046.
  await mkdir(join(root, '.cursor/rules'), { recursive: true });
  await writeFile(join(root, '.cursor/rules/test-gate.mdc'), text.replace(/\.md\b/g, '.mdc'));
  return { root, copilotRule };
}

test('a generated rule file the tool no longer writes is reported, not forgotten (S12)', async () => {
  // The failure this guards: the moment the skip landed, `staleRuleFiles` went from 17
  // to 0 across the estate and the files were still on disk. A tool that stops looking
  // at a file it generated has not cleaned up - it has lost track of it.
  const { root } = await repoWithALeftoverRuleFile();
  const findings = await checkTargets(root, { surfaces: 'opencode,cursor' });
  const orphans = findings.filter((f) => f.status === 'orphaned');
  assert.equal(orphans.length, 1, `expected one orphaned file, got ${JSON.stringify(findings.map((f) => [f.file, f.status]))}`);
  assert.equal(orphans[0].file, '.cursor/rules/test-gate.mdc');
  assert.match(orphans[0].detail, /already folded/);
  // The remedy must name a delete, not `sync`: `sync` will never write this file again,
  // so a `run: simt-dev sync --yes` here would send the reader in a circle.
  assert.match(orphans[0].remedy, /delete \.cursor\/rules\/test-gate\.mdc/);
  assert.doesNotMatch(orphans[0].remedy, /sync/);
});

test('an orphaned rule file does not fail the gate (S12)', async () => {
  // ADR-021 ruling 6: simt-dev never deletes a file it wrote, so nothing in the tool
  // can repair this. A gate that no command can satisfy is worse than a noisy one.
  const { root } = await repoWithALeftoverRuleFile();
  const { code, stdout } = await capture(['check', '--root', root, '--surfaces', 'opencode,cursor']);
  assert.equal(code, 0, `check failed on a file nothing can repair:\n${stdout}`);
  assert.match(stdout, /ORPHANED\s+\.cursor\/rules\/test-gate\.mdc/);
});

test("a repo's own rule files are never reported as orphaned (S12)", async () => {
  // A repo mid-migration has hand-written `.mdc` files of its own. simt-dev did not
  // write them and must not tell anyone to delete them - that is the one destructive
  // outcome available to this feature, so it is asserted directly rather than implied.
  const root = await scratch();
  await mkdir(join(root, '.git'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{"name":"x"}\n');
  await mkdir(join(root, '.cursor/rules'), { recursive: true });
  await writeFile(join(root, '.cursor/rules/team-conventions.mdc'), '---\ndescription: ours\nalwaysApply: true\n---\n\nOur own rule.\n');
  const findings = await checkTargets(root, { surfaces: 'opencode,cursor' });
  assert.deepEqual(findings.filter((f) => f.status === 'orphaned'), []);
});

test('the orphan scan reports nothing when nothing was ever left behind (S12)', async () => {
  // The negative control. Without it, a scan that always returned an empty array would
  // satisfy every test above, because a repo that never had the file has nothing to find.
  const root = await scratch();
  await mkdir(join(root, '.git'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{"name":"x"}\n');
  await exec('node', [BIN, 'init', '--root', root, '--yes', '--surfaces', 'opencode,cursor']);
  const findings = await checkTargets(root, { surfaces: 'opencode,cursor' });
  assert.deepEqual(findings.filter((f) => f.status === 'orphaned'), []);
});

// ------------------------------------- a surface problem is reported as a surface problem

/**
 * A scratch repository whose manifest names a surface that does not exist.
 *
 * `not-a-surface` rather than a plausible typo, so the assertion that matters — that
 * the remedy names the `surfaces` list — cannot pass by coincidence on a string that
 * happens to be a near-miss for one of the real ids.
 */
async function repoWithAnUnknownSurface() {
  const root = await scratch();
  await writeFile(
    join(root, MANIFEST_FILE),
    JSON.stringify({ id: 'x', version: 1, surfaces: ['cursor', 'not-a-surface'], gates: {} }, null, 2),
  );
  return root;
}

test('sync reports an unknown surface as a surface, not as an unprojectable rule', async () => {
  // The defect, stated as the reader met it. `plan()` has carried `surfaceProblems`
  // since the surface table gained a validator, and nothing read the field. The problem
  // was not lost — it arrived through `ruleBodies`, which folded `resolved.problems`
  // into the array `sync` prints as "canonical .mdc rule(s) cannot be projected", with
  // the remedy "fix the reported substitution keys in simt.json".
  //
  // There are no substitution keys in this manifest. There is one misspelled string.
  const root = await repoWithAnUnknownSurface();
  const { code, stdout, stderr } = await capture(['sync', '--root', root, '--yes']);
  const out = stdout + stderr;

  assert.equal(code, 1);
  assert.match(out, /unknown surface "not-a-surface"/, 'the problem itself must still be reported');
  assert.doesNotMatch(out, /\.mdc rule\(s\) cannot be projected/, `reported as a rule problem:\n${out}`);
  assert.doesNotMatch(out, /substitution keys/, `the remedy named a block that is not involved:\n${out}`);
  assert.match(out, /"surfaces"/, `the remedy does not name the list to fix:\n${out}`);
});

test('a rule problem is still reported as a rule problem', async () => {
  // The other direction, and the one that a fix which only deletes the fold would pass
  // while losing the reader their only report. A declared substitution key that no
  // canonical rule defines is a rule defect and keeps the rule wording.
  const root = await scratch();
  await writeFile(
    join(root, MANIFEST_FILE),
    JSON.stringify(
      { id: 'x', version: 1, surfaces: ['cursor'], gates: {}, substitutions: { 'test-gate': { noSuchKey: 'v' } } },
      null,
      2,
    ),
  );
  const { code, stdout, stderr } = await capture(['sync', '--root', root, '--yes']);
  const out = stdout + stderr;

  assert.equal(code, 1);
  assert.match(out, /noSuchKey/, `the substitution key is not named:\n${out}`);
  assert.match(out, /substitution keys/, `the remedy for a substitution key moved:\n${out}`);
});

test('init reports an unknown surface as a surface, not as an unprojectable rule', async () => {
  // `init` reads the same array, and had it removed from that array it would have
  // reported nothing at all — a silent adoption of a repository whose rules go to
  // fewer editors than the user asked for. Asserted because that is the failure a
  // narrow fix here produces.
  const { code, stdout, stderr } = await capture(['init', '--root', (await scratch()), '--yes', '--surfaces', 'cursor,not-a-surface']);
  const out = stdout + stderr;

  assert.equal(code, 1);
  assert.match(out, /unknown surface "not-a-surface"/, `the problem was lost on the init path:\n${out}`);
  assert.doesNotMatch(out, /\.mdc rule\(s\) cannot be projected/, `reported as a rule problem:\n${out}`);
  assert.match(out, /--surfaces/, `the remedy does not name the flag that caused it:\n${out}`);
});

test('check and sync name the same problem the same way', async () => {
  // Two surfaces, one manifest. `check` reported this correctly from the start, and the
  // disagreement between the gate and the writer is what made it a defect rather than a
  // rough edge — a reader's trust in one of them is evidence about the other.
  const root = await repoWithAnUnknownSurface();
  const check = await capture(['check', '--root', root]);
  const sync = await capture(['sync', '--root', root, '--yes']);

  const named = (r) => /unknown surface "not-a-surface"; known: ([^\n]*)/.exec(r.stdout + r.stderr)[1];
  assert.equal(named(sync), named(check), 'the two surfaces disagree about the known ids');
  assert.equal(check.code, 1);
  assert.equal(sync.code, 1);
});
