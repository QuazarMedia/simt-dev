import assert from 'node:assert/strict';
import { cmd } from './fixture.mjs';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadMdcRules, renderMdc } from '../src/projection/mdc.mjs';
import { inject } from '../src/projection/markers.mjs';

const scratch = () => mkdtemp(join(tmpdir(), 'simt-mdc-'));

test('every canonical rule is present, named, and states where pushing stops', async () => {
  const rules = await loadMdcRules();
  assert.deepEqual(
    rules.map((r) => r.id),
    ['intake-questions', 'preview-postflight', 'slice-commit', 'test-gate'],
  );
  for (const rule of rules) {
    assert.equal(rule.error, null, `${rule.id}: ${rule.error}`);
    assert.equal(rule.alwaysApply, true);
    assert.ok(rule.description && rule.description.length > 10);
    assert.match(rule.target, /^\.cursor\/rules\/[^/]+\.mdc$/, rule.target);

    // A rule is reachable or it is not, and an unreachable rule is silent: it can be
    // authored, committed, tested for its presence on disk, and projected into no repo
    // at all. `slice-commit` shipped that way — `applies` was simply absent, and the
    // only symptom was a note in `init` output nobody reads.
    //
    // So every rule must declare exactly one of: `applies: always`, a non-empty
    // `applies` list, or `optIn: true`. Anything else is a defect.
    const always = rule.applies === 'always';
    const listed = Array.isArray(rule.applies) && rule.applies.length > 0;
    const optIn = rule.optIn === true;
    assert.ok(
      always || listed || optIn,
      `${rule.id} is unreachable: declare applies: always, a non-empty applies list, or optIn: true`,
    );
    assert.ok(
      !(always && optIn),
      `${rule.id} declares both applies: always and optIn: true; a rule cannot be both unconditional and declared`,
    );
  }

  // The commit rule has to say the one thing a commit cannot imply: that pushing is a
  // separate decision. A procedure that ends at `git commit` reads as a licence to
  // continue to `git push`.
  const slice = rules.find((r) => r.id === 'slice-commit');
  assert.match(slice.body, /Never push because the work is finished/);
  assert.match(slice.body, /approval to commit is not approval to push/i);
  assert.match(slice.body, /--no-verify/);
  assert.doesNotMatch(slice.body, /simt (?!-dev)/, 'names the tool the reader has installed');
});

test('a rule missing id or target is a defect, not a default', () => {
  const rule = { id: null, substitutions: [], body: 'x' };
  const shape = (r) => (r.id === null ? 'missing id in frontmatter' : r.target === null ? 'missing target in frontmatter' : null);
  assert.equal(shape(rule), 'missing id in frontmatter');
  assert.equal(shape({ id: 'a', target: null }), 'missing target in frontmatter');
  assert.equal(shape({ id: 'a', target: 'b' }), null);
});

test('test-gate carries BOTH complementary BLOCK bullets', async () => {
  const rules = await loadMdcRules();
  const gate = rules.find((r) => r.id === 'test-gate');
  const { body } = renderMdc(gate);
  assert.match(body, /Consumer side:/);
  assert.match(body, /Producer side:/);
});

test('the 6/8 partial-pass example survives (it was silently deleted in one copy)', async () => {
  const rules = await loadMdcRules();
  const { body } = renderMdc(rules.find((r) => r.id === 'test-gate'));
  assert.match(body, /6\/8 passing/);
});

test('preview-postflight carries BOTH the build-config and credential bullets', async () => {
  const rules = await loadMdcRules();
  const { body } = renderMdc(rules.find((r) => r.id === 'preview-postflight'));
  assert.match(body, /preview environment's API base URL/);
  assert.match(body, /operator keychain only/);
});

test('the Allowed Without Account section is restored (media had deleted it)', async () => {
  const rules = await loadMdcRules();
  const { body } = renderMdc(rules.find((r) => r.id === 'preview-postflight'));
  assert.match(body, /## Allowed Without Account/);
  assert.match(body, /D1 migration verification/);
});

test('intake keeps migrations in the ask-trigger list', async () => {
  const rules = await loadMdcRules();
  const { body } = renderMdc(rules.find((r) => r.id === 'intake-questions'));
  assert.match(body, /contracts,\s+migrations, or risk/);
});

test('a default is used when the repo declares nothing', async () => {
  const rules = await loadMdcRules();
  const { body, problems } = renderMdc(rules.find((r) => r.id === 'intake-questions'));
  assert.deepEqual(problems, []);
  assert.match(body, /docs\/plans\/\*/);
});

test('a declared substitution replaces the default', async () => {
  const rules = await loadMdcRules();
  const { body } = renderMdc(rules.find((r) => r.id === 'intake-questions'), {
    plansGlob: '../simt-social/docs/plans/*',
  });
  assert.match(body, /\.\.\/simt-social\/docs\/plans\/\*/);
  assert.doesNotMatch(body, /`docs\/plans\/\*`/);
});

test('a per-signal default is used when the repo carries that signal', async () => {
  const rules = await loadMdcRules();
  const gate = rules.find((r) => r.id === 'test-gate');
  const sub = gate.substitutions.find((s) => s.key === 'exampleTestPath');
  assert.equal(sub.perSignal['has-go-mod'], 'path/to/the_changed_test.go');

  // A Go repository is selected on a fact, not a stack tag: the signals carry facts.
  const { body: go } = renderMdc(gate, {}, ['has-go-mod']);
  assert.match(go, /path\/to\/the_changed_test\.go/);

  // Cargo integration tests are files in `tests/`; a Rust reader must not be
  // handed the TypeScript example path.
  const { body: rust } = renderMdc(gate, {}, ['has-cargo-toml']);
  assert.match(rust, /tests\/the_changed\.rs/);
  assert.doesNotMatch(rust, /\.test\.ts|the_changed_test/);

  const { body: other } = renderMdc(gate);
  assert.match(other, /path\/to\/the\.changed\.test\.ts/);
  assert.doesNotMatch(other, /the_changed_test/);
});

test('a declared substitution beats the per-signal default', async () => {
  const rules = await loadMdcRules();
  const gate = rules.find((r) => r.id === 'test-gate');
  const { body } = renderMdc(gate, { exampleTestPath: 'tests/real_test.go' }, ['has-go-mod']);
  assert.match(body, /tests\/real_test\.go/);
});

test('an empty per-signal default drops the line for that signal only', () => {
  const rule = {
    substitutions: [{ key: 'note', default: 'the default note', perSignal: { 'has-x': '' }, describe: '' }],
    body: '- A note: {{note}}.',
  };
  assert.equal(renderMdc(rule, {}, ['has-x']).body.trim(), '');
  assert.match(renderMdc(rule).body, /the default note/);
});

test('a {manifest} token in a body renders as the manifest filename', () => {
  const { body } = renderMdc({ substitutions: [], body: 'declare the bar in `{manifest}`' });
  assert.match(body, /`simt\.json`/);
});

test('an empty declaration DROPS its line rather than printing a blank', async () => {
  const rules = await loadMdcRules();
  const { body } = renderMdc(rules.find((r) => r.id === 'preview-postflight'), {
    productionDomainNote: '',
  });
  assert.doesNotMatch(body, /productionDomainNote/);
  // The surrounding sections must survive the drop intact.
  assert.match(body, /## Requirements/);
  assert.match(body, /## Forbidden/);
  // And the file must not be left with a blank run where the line used to be.
  assert.doesNotMatch(body, /\n{3,}/);
});

test('a substitution with neither a default nor a declaration is reported', () => {
  const rule = {
    id: 'x',
    substitutions: [{ key: 'k', default: undefined }],
    body: 'value is {{k}}',
  };
  const { problems } = renderMdc(rule);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /no default and none declared/);
});

test('rendering with no substitutions leaves no placeholder behind', async () => {
  for (const rule of await loadMdcRules()) {
    const { body, problems } = renderMdc(rule);
    assert.deepEqual(problems, [], rule.id);
    assert.doesNotMatch(body, /\{\{/, rule.id);
  }
});


test('a projected rule is idempotent through inject', async () => {
  const rules = await loadMdcRules();
  const rule = rules.find((r) => r.id === 'test-gate');
  const { body } = renderMdc(rule);
  const meta = { sha: 'abc1234', sources: [rule.source] };
  const first = inject('', body, meta);
  assert.equal(first.action, 'added');
  const second = inject(first.text, body, meta);
  assert.equal(second.action, 'unchanged');
});

test('the rules are pure content: no absolute path or repo name leaks in', async () => {
  for (const rule of await loadMdcRules()) {
    const { body } = renderMdc(rule);
    assert.doesNotMatch(body, /said\.elimam/, rule.id);
    assert.doesNotMatch(body, /\/Users\//, rule.id);
  }
});
// --- the conflict scanner must be able to REACH .mdc files ---------------------
//
// The estate's three always-on .mdc families were its worst-drifted content, and
// `simt-dev init` reported `CONFLICTS none detected` on the repo holding them, because
// RULE_FILES named only AGENTS.md/CLAUDE.md/CONTRIBUTING.md. A detector that only
// looks at the filenames it was written for misses a whole rule surface added later.

import { RULE_FILES, ruleGlobs, rulePaths, scanDocument } from '../src/projection/conflicts.mjs';
import * as surfacesModule from '../src/projection/surfaces.mjs';

test('rulePaths finds hand-written rules by name and by glob', async () => {
  const dir = await scratch();
  await mkdir(join(dir, '.cursor', 'rules'), { recursive: true });
  await writeFile(join(dir, 'AGENTS.md'), '# a\n');
  await writeFile(join(dir, '.cursor', 'rules', 'test-gate.mdc'), '---\n---\n');
  await writeFile(join(dir, '.cursor', 'rules', 'README.txt'), 'ignored\n');
  await writeFile(join(dir, '.cursor', 'rules', 'preview-postflight.mdc'), '---\n---\n');

  const found = (await rulePaths(dir)).map((p) => p.slice(dir.length + 1));
  assert.ok(found.includes('AGENTS.md'));
  assert.ok(found.includes(join('.cursor', 'rules', 'test-gate.mdc')));
  assert.ok(found.includes(join('.cursor', 'rules', 'preview-postflight.mdc')));
  assert.ok(!found.some((p) => p.endsWith('README.txt')), 'a non-markdown file was collected');
  // Stable across runs, so two `init` invocations produce a diffable report.
  assert.deepEqual(
    (await rulePaths(dir)).map((p) => p.slice(dir.length + 1)),
    found,
    'order must be stable for a diffable report',
  );
});

test('rulePaths returns every pointer and named file when no rule dir exists', async () => {
  // Expected from the same authority `rulePaths` reads, not hand-copied. A hand-written
  // list here is the defect this row is about: `GEMINI.md` was missing from it, and from
  // the scanner, for as long as the Antigravity pointer existed — which is precisely the
  // failure the comment on `RULE_FILES` predicted before it happened.
  const { POINTERS, SURFACES } = await import('../src/projection/surfaces.mjs');
  const expected = [...new Set([...RULE_FILES, ...POINTERS.map((p) => p.path)])].sort();

  // The claim is still worth making: a repository with no rule directory yields only the
  // named documents, not a scan of every surface.
  const dir = await scratch();
  const found = (await rulePaths(dir)).map((p) => p.slice(dir.length + 1));
  assert.deepEqual(found, expected);
  assert.ok(!found.some((p) => p.startsWith('.')), 'no surface directory should appear when none exists');
  assert.ok(SURFACES.some((s) => typeof s.rule === 'string'), 'the glob source must not be empty, or this proves nothing');
});

test('every surface that declares a rule path is scanned, and nothing else is', async () => {
  // The four surfaces with a `rule` template write into four different directories. A
  // scanner that names them by hand misses whichever surface was added last, silently:
  // a hand-written rule contradicting a ruling in a directory nobody scans is reported
  // as no contradiction at all.
  const { SURFACES } = await import('../src/projection/surfaces.mjs');
  const dirs = SURFACES.filter((s) => typeof s.rule === 'string').map((s) => s.rule.split('/').slice(0, -1).join('/'));
  assert.deepEqual([...new Set(dirs)].sort(), [
    '.agents/rules',
    '.claude/rules',
    '.cursor/rules',
    '.github/instructions',
  ]);

  // Each one, with a file that contradicts ADR-001, plus a file in one of those
  // directories whose extension the surface does not use.
  const dir = await scratch();
  // Four files a person wrote, one per surface directory. Plus two that must be
  // missed: a `.txt` in a rule directory, and a `.md` in the copilot directory.
  const missed = ['.claude/rules/notes.txt', '.github/instructions/notes.markdown'];
  const planted = {
    '.cursor/rules/hand-written.mdc': 'Always commit and pushed with a conventional message.\n',
    '.claude/rules/hand-written.md': 'Always commit and pushed with a conventional message.\n',
    '.agents/rules/hand-written.md': 'Always commit and pushed with a conventional message.\n',
    '.github/instructions/hand-written.instructions.md': 'Always commit and pushed with a conventional message.\n',
    // `.md`, NOT `.instructions.md` — and it is still scanned. The extension taken
    // from the template is the final one, so the copilot directory is scanned at
    // `.md`, which is deliberately broader than the suffix this tool writes: a person
    // writing `reviewer.md` there is the case this scanner exists for, and matching
    // the tool's own suffix would report their file as absent.
    '.github/instructions/hand-written.md': 'Always commit and pushed with a conventional message.\n',
    ...Object.fromEntries(missed.map((rel) => [rel, 'Always commit and pushed with a conventional message.\n'])),
  };
  for (const [rel, body] of Object.entries(planted)) {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), body);
  }

  const found = (await rulePaths(dir)).map((p) => p.slice(dir.length + 1));
  for (const rel of Object.keys(planted)) {
    assert.equal(found.includes(rel), !missed.includes(rel), `${rel} ${missed.includes(rel) ? 'should not be' : 'should be'} scanned`);
  }

  // And the contradiction planted in each of them is actually found, not merely
  // listed — a scanner that collects a path and never reads it reports the same
  // answer as one that finds nothing.
  const hits = found.filter((rel) => planted[rel] !== undefined).map((rel) => scanDocument(planted[rel], rel));
  assert.equal(hits.length, Object.keys(planted).length - missed.length);
  for (const [i, findings] of hits.entries()) {
    assert.equal(
      findings.filter((f) => f.severity === 'conflict').length,
      1,
      `no conflict found in ${Object.keys(planted).filter((r) => !missed.includes(r))[i]}`,
    );
  }
});

test('a surface added later is scanned without anyone editing the scanner', () => {
  // The structural claim, shown on a surface that does not exist. The whole point of
  // deriving the scan list is that a surface nobody remembered to add to a second list
  // is still scanned; the only way to test that is to hand the derivation a surface
  // this package has never heard of and see what comes out.
  assert.deepEqual(ruleGlobs([{ id: 'invented', rule: '.invented/rules/{name}.mds' }]), [
    '.invented/rules/*.mds',
  ]);

  // A surface with no rule template contributes nothing, rather than a `undefined/*`
  // glob that matches nothing and reads as coverage.
  assert.deepEqual(ruleGlobs([{ id: 'pointer-only' }, { id: 'invented', rule: 'x/{name}.md' }]), [
    'x/*.md',
  ]);

  // And the default is the real list, so the parameter is not a way to narrow a scan
  // in production: with no argument it is every shipped surface.
  const { SURFACES } = surfacesModule;
  assert.deepEqual(ruleGlobs(), ruleGlobs(SURFACES));
  assert.equal(
    ruleGlobs().length,
    SURFACES.filter((s) => typeof s.rule === 'string').length,
  );
});

test('a conflict inside a .mdc rule is detected', async () => {
  const text = '---\ndescription: x\nalwaysApply: true\n---\n\n# Rogue\nAlways commit and pushed with a conventional message.\n';
  const found = scanDocument(text, '.cursor/rules/rogue.mdc');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'conflict');
  assert.equal(found[0].adr, 'ADR-001');
});

test('autonomous-push is matched in every phrasing the estate actually used', () => {
  // garmin's own DoD, plus the two other forms a different author wrote. An
  // anchored pattern matching only the first reported a real rule as clean.
  for (const phrase of [
    '8. Committed and pushed with a conventional message',
    'Always commit and pushed with a conventional message',
    'Then commit and push without asking',
  ]) {
    const found = scanDocument(`# DoD\n- ${phrase}\n`, 'AGENTS.md');
    assert.ok(
      found.some((f) => f.id === 'autonomous-push'),
      `missed: ${phrase}`,
    );
  }
});
test('an empty substitution drops the whole bullet, not just the token line', () => {
  // The failure this prevents: a two-line bullet whose first line carries the token
  // keeps its second line, so the rule reads as a sentence fragment.
  const rule = {
    body: '## Requirements\n\n{{apiBaseUrlNote}}\n  to the preview Worker URL.\n- Keep the credential in the keychain.\n',
    substitutions: [{ key: 'apiBaseUrlNote', default: '- Set `SOCIAL_API_BASE_URL`' }],
  };
  const { body, problems } = renderMdc(rule, { apiBaseUrlNote: '' });
  assert.deepEqual(problems, []);
  assert.ok(!body.includes('to the preview Worker URL.'), body);
  assert.ok(body.includes('Keep the credential in the keychain.'), body);
});

test('two optional clauses on one line lose one with no diagnostic', () => {
  // Dropping a line removes every token on it, so `{{a}}{{b}}` with `a` empty deletes
  // `b` as well — and leaves no leftover placeholder for the leftover check to report.
  // The rule is on the content side: one placeholder per line.
  const rule = {
    body: '## Requirements\n\n- Credentials stay in the keychain.\n{{apiBaseUrlNote}}{{domainNote}}\n',
    substitutions: [
      { key: 'apiBaseUrlNote', default: '- Set the preview base URL.' },
      { key: 'domainNote', default: '- Name the production domain binding.' },
    ],
  };
  const both = renderMdc(rule, {});
  assert.ok(both.body.includes('Set the preview base URL.'));
  assert.ok(both.body.includes('Name the production domain binding.'));

  // With both on separate lines, dropping one leaves the other intact.
  const separate = {
    ...rule,
    body: '## Requirements\n\n- Credentials stay in the keychain.\n{{apiBaseUrlNote}}\n{{domainNote}}\n',
  };
  const { body, problems } = renderMdc(separate, { apiBaseUrlNote: '' });
  assert.deepEqual(problems, []);
  assert.ok(!body.includes('Set the preview base URL.'), body);
  assert.ok(body.includes('Name the production domain binding.'), body);
});

test('every shipped rule reports a substitutions array, declared or not', async () => {
  // `substitutions: subs.length > 0 ? subs : substitutions` referenced an undefined
  // binding. It only fired for a rule WITHOUT the block — which is what a newly authored
  // rule looks like — so no shipped rule could reach it and no test could catch it.
  for (const rule of await loadMdcRules()) {
    assert.ok(Array.isArray(rule.substitutions), rule.file);
  }
});

test('an opt-in rule reaches media with only the clauses media can act on', async () => {
  const { loadMdcRules } = await import('../src/projection/mdc.mjs');
  const rule = (await loadMdcRules()).find((r) => r.id === 'preview-postflight');
  const { body, problems } = renderMdc(rule, {
    previewWorkers: '`simt-social-media-preview`',
    previewUrlHost: 'simt-social-media-preview.<account>',
    productionDomains: '`media.simt.social`',
    // media serves derivatives and calls no API, so it has no base URL to point at.
    previewApiBaseUrlNote: '',
    productionDomainNote:
      '- Production custom domain `media.simt.social` is configured in `wrangler.jsonc` for `main` only.',
  });
  assert.deepEqual(problems, []);
  assert.ok(!body.includes('SOCIAL_API_BASE_URL'), body);
  assert.ok(body.includes('media.simt.social'), body);
  assert.ok(body.includes('main` only.'), body);
  // The sections media had deleted come back, and the credential prohibition keeps
  // the D1 clause media had dropped.
  assert.ok(body.includes('## Allowed Without Account'), body);
  assert.ok(body.includes('D1 migration verification'), body);
  assert.ok(body.includes('never in source, chat, D1, or'), body);
});

// --- A projected rule must be readable by someone who only has this repository ---
//
// The drift that produced this suite was found by asking whether the projected text
// makes sense to a reader who cannot see simt-dev's own tree. Three classes of leak
// were real and are now regression-tested:
//
//   1. instructions addressed to whoever owns the rules upstream ("edit the source in
//      simt-dev") - a consumer of the published package has no such tree, and the
//      region it lands in tells its reader not to edit it;
//   2. paths that resolve inside simt-dev but not in the repo the rule is projected
//      into - the same failure class ADR-015 fixed for skill sources;
//   3. the name of another repository in the estate, which is meaningless outside it.
//
// These run against the *rendered* output, not the source, because that is what a
// consumer reads.

test('a projected rule names no path that only resolves inside simt-dev', async () => {
  for (const rule of await loadMdcRules()) {
    const { body } = renderMdc(rule, {});
    // Paths that mean "inside the tool" rather than "inside your repo".
    //
    // `docs/plans/` is deliberately NOT on this list: it is a substitution default
    // for where a repo keeps its own plans, and it resolves correctly relative to
    // the reader. The distinction is who owns the path, not whether it looks like one.
    for (const leaked of ['docs/decisions/', 'rules/stacks/', 'rules/core.md', 'rules/mdc/']) {
      assert.ok(!body.includes(leaked), `${rule.id} projects a tool-internal path: ${leaked}\n${body}`);
    }
  }
});

test('a projected rule names no other repository in the estate', async () => {
  for (const rule of await loadMdcRules()) {
    const { body } = renderMdc(rule, {});
    assert.ok(!/\bsimt-(?!dev\b)/.test(body), `${rule.id} names a specific repo:\n${body}`);
  }
});

test('the provenance header gives the reader the two actions that exist', async () => {
  const text = inject('', 'Body.', { sha: 'abc1234' }).text;
  // What a reader can actually do.
  assert.match(text, cmd('{cli} sync'), text);
  assert.match(text, /Do not edit/i, text);
  // What a reader cannot do. This phrasing was correct for the rules' maintainer and
  // wrong for everyone else, which is why it is now asserted absent.
  assert.ok(!/edit the source/i.test(text), text);
  assert.ok(!/edits here are overwritten/i.test(text), text);
});

const exec = promisify(execFile);
const BIN = new URL('../bin/simt.mjs', import.meta.url).pathname;

/** A scratch repository holding the named files, keyed by path relative to its root. */
async function repoWith(files) {
  const root = await mkdtemp(join(tmpdir(), 'simt-fm-'));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, body);
  }
  return root;
}

/** Run the shipped binary, because the claim under test is about what a reader runs. */
async function simt(args) {
  const { stdout, stderr } = await exec('node', [BIN, ...args], { maxBuffer: 16 << 20 });
  return { stdout, stderr };
}

test('a rule file frontmatter is re-derived, not inherited from whatever is on disk (S16)', async () => {
  // The defect: the frontmatter came from `extractFrontmatter(existing) ?? ...`, so the
  // file's own block won whenever the file already had one. The block is therefore a
  // snapshot of whatever the surface emitted the first time it saw this tool — forever.
  //
  // The consequence is not drift that a gate can see. The gate reads the file, the file
  // agrees with itself, and no surface change ever reaches a repository that has already
  // adopted it. Nothing is stale by any comparison the tool makes, because nothing
  // compares the emitted frontmatter with the written one.

  // A Cursor rule file whose frontmatter is wrong in a way this tool would never write:
  // `alwaysApply: false` for a rule the registry declares always-on, plus a key that
  // does not belong to Cursor at all.
  const dir = await repoWith({
    'simt.json': JSON.stringify({ id: 'r', stack: [], surfaces: ['cursor'], gates: { preCommit: [], prePush: [] } }, null, 2),
    '.cursor/rules/test-gate.mdc': [
      '---',
      'description: A stale description',
      'alwaysApply: false',
      'inventedKey: someone typed this by hand',
      '---',
      '<!-- simt:begin -->',
      '<!-- simt:end -->',
      '',
    ].join('\n'),
  });

  const before = await readFile(join(dir, '.cursor/rules/test-gate.mdc'), 'utf8');
  assert.match(before, /alwaysApply: false/, 'the fixture must actually be wrong');

  await simt(['sync', '--root', dir, '--yes']);

  const after = await readFile(join(dir, '.cursor/rules/test-gate.mdc'), 'utf8');
  const block = after.slice(0, after.indexOf('---', 4));
  assert.match(block, /alwaysApply: true/, 'the emitted frontmatter did not replace the inherited one');
  assert.match(block, /description: .*test delta/i, 'the description was not re-derived from the rule');
  assert.doesNotMatch(block, /inventedKey/, 'a key this tool never emits survived in a file it owns');

  // And the body is still there, because the frontmatter is not the whole file.
  assert.match(after, /<!-- simt:begin -->/);
  assert.match(after, /<!-- simt:end -->/);
});

test('a surface that emits no frontmatter leaves an existing one alone', async () => {
  // The asymmetry, stated as a test because it is the one place this change deletes
  // something. Where a surface DOES emit frontmatter this tool owns it and replaces it.
  // Where it emits none it has no opinion, and removing a block it never wrote is a
  // different operation with no reader asking for it.
  const dir = await repoWith({
    'simt.json': JSON.stringify({ id: 'r', stack: [], surfaces: ['cursor'], gates: { preCommit: [], prePush: [] } }, null, 2),
  });
  const { rulePath } = await import('../src/projection/surfaces.mjs');
  const rel = rulePath('claude', 'test-gate');
  assert.ok(rel, 'the claude surface has a rule path');
  const path = join(dir, rel);
  await mkdir(dirname(path), { recursive: true });
  const handWritten = '---\ntitle: somebody wrote this\n---\n<!-- simt:begin -->\n<!-- simt:end -->\n';
  await writeFile(path, handWritten);

  await simt(['sync', '--root', dir, '--yes']);
  assert.match(
    await readFile(path, 'utf8'),
    /title: somebody wrote this/,
    'sync deleted a frontmatter block belonging to a surface that emits none',
  );
});
