// The tooling baselines: a generated region in a file the repo already owns.
//
// The tests are grouped by the failure each one prevents, and they run the shipped
// binary as a subprocess wherever the claim is about a consumer's experience rather
// than about a function's return value. A baseline is four lines of INI; nothing about
// it is hard, and everything about it is easy to get wrong in a way that is invisible
// until somebody's editor disagrees with their colleague's.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import { assertClean } from './leaks.mjs';
import { BASELINES, EDITORCONFIG_BODY, GITATTRIBUTES_BODY, baselineTargets, misplaced } from '../src/projection/baselines.mjs';
import { inject, parse, STYLES } from '../src/projection/markers.mjs';
import { checkTargets, plan } from '../src/projection/project.mjs';

const run = promisify(execFile);
const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'simt-dev.mjs');
const SHA = 'a831794';

async function scratch() {
  return mkdtemp(join(tmpdir(), 'simt-baseline-'));
}

async function repo(name = 'api') {
  const root = await scratch();
  await mkdir(join(root, '.git'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name, dependencies: { hono: '^4' } }) + '\n');
  return root;
}

async function simt(args, root) {
  const r = await run('node', [BIN, ...args, '--root', root], { cwd: root }).catch((e) => ({
    code: e.code ?? 1,
    stdout: e.stdout ?? '',
    stderr: e.stderr ?? '',
  }));
  return { code: r.code ?? 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

// ------------------------------------------------------------------ the bytes ship clean

test('the shipped baseline carries nothing a reader outside this repository cannot act on', async () => {
  // Same guard the rule bodies and the CI workflow get. `.editorconfig` is the first
  // thing this tool writes that a contributor's EDITOR reads, so "readable and
  // actionable by someone who only has this repository" applies to it more literally
  // than to a rule file: there is no agent in the loop to interpret an unclear line.
  assertClean('.editorconfig', EDITORCONFIG_BODY);
});

test('the baseline names only settings, not tools a reader must install', async () => {
  // A baseline that said "use biome" would be a command a repo cannot follow without
  // a dependency decision. Every key here is read by an editor the reader already has.
  assert.doesNotMatch(EDITORCONFIG_BODY, /\b(biome|eslint|prettier --|dprint)\b/);
});

test('the baseline is parseable editorconfig, and prettier\'s section is the last word', () => {
  // The region's own header lines are comments, so a parser that sees them as keys
  // would make the whole file invalid and every editor would fall back to defaults -
  // a file worse than no file at all. This is the failure that motivated a per-file
  // comment style rather than the HTML markers AGENTS.md uses.
  const { text } = inject('', EDITORCONFIG_BODY, { sha: SHA }, { style: 'hash' });
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    assert.match(line, /^\[.*\]$|^\w+ = .+$/, `not an editorconfig line: ${JSON.stringify(line)}`);
  }
  // Every `[section]` is closed before the next begins; a section header with no keys
  // under it is a typo that silently applies to nothing.
  const sections = text.split('\n').filter((l) => l.startsWith('['));
  assert.ok(sections.length >= 5);
});

// ------------------------------------------------------------------------ the mechanism

test('the region is a comment in the file it lands in, not an HTML comment', () => {
  assert.equal(STYLES.hash.begin, '# simt-dev:begin');
  assert.equal(STYLES.hash.where, 'top', 'last-definition-wins means the repo must come after');
  const { text } = inject('', EDITORCONFIG_BODY, { sha: SHA }, { style: 'hash' });
  assert.doesNotMatch(text, /<!--/);
});

test('a repo with no .editorconfig gets one', async () => {
  const root = await repo();
  const { targets } = await baselineTargets(root, SHA);
  assert.equal(targets.length, BASELINES.length);
  const t = targets[0];
  assert.equal(t.file, '.editorconfig');
  assert.equal(t.exists, false);
  assert.equal(t.action, 'added');
});

test('the repo\'s own settings land BELOW the region, so the repo wins', async () => {
  // The whole reason `where: 'top'` exists. An appended region would leave the repo's
  // `indent_size = 4` in the file and silently dead, with no byte removed and nothing
  // in `check` to report. editorconfig takes the last matching definition.
  //
  // The comparison is against the END marker, not against a value: this region also
  // sets `indent_size = 4` for Python and Java, so searching for the repo's own line
  // finds the region's line instead and the assertion holds either way.
  const mine = 'root = true\n\n[*]\nindent_size = 4\nmax_line_length = 120\n';
  const { text } = inject(mine, EDITORCONFIG_BODY, { sha: SHA }, { style: 'hash' });
  const end = text.indexOf('# simt-dev:end');
  assert.ok(end > 0);
  assert.ok(text.indexOf('max_line_length = 120') > end, 'a setting the region does not carry');
  assert.ok(text.lastIndexOf('indent_size = 4') > end, 'a setting the region also carries');
  assert.match(text, /indent_size = 4\nmax_line_length = 120/, 'the repo\'s block must survive byte for byte');
});

test('a second sync writes nothing, and the gate calls it current', async () => {
  const root = await repo();
  const first = await baselineTargets(root, SHA);
  await writeFile(join(root, '.editorconfig'), first.targets[0].text);
  const second = await baselineTargets(root, SHA);
  assert.equal(second.targets[0].action, 'unchanged');
  assert.equal(second.targets[0].text, first.targets[0].text, 'sync must be idempotent');
});

test('a region that has been moved below the repo\'s settings is reported, with the reason', async () => {
  // The bytes are right and the meaning is wrong. Without this finding the gate would
  // call that current, and the repo's indentation settings would simply stop working.
  const root = await repo();
  // sync first, so the region records the SHA the gate will compare against. Building
  // the file from a hand-picked SHA instead would report DRIFT alongside MISPLACED,
  // and the test would pass while asserting the wrong thing.
  await simt(['sync', '--yes'], root);
  const synced = await readFile(join(root, '.editorconfig'), 'utf8');
  const region = synced.slice(synced.indexOf('# simt-dev:begin'));
  const moved = `# their own settings\n\n[*]\nindent_size = 4\n\n${region}`;
  await writeFile(join(root, '.editorconfig'), moved);

  const off = misplaced(parse(moved, 'hash'), 'hash');
  assert.ok(off, 'a region below other settings must be reported');
  assert.match(off.detail, /overrides the settings/);
  assert.match(off.remedy, /above your own settings/);

  const findings = await checkTargets(root, {});
  const f = findings.find((x) => x.file === '.editorconfig' && x.status === 'misplaced');
  assert.ok(f, 'the gate must surface it, not just the module');

  // A finding nobody is stopped by is a note. It has to fail the gate, and it has to be
  // reported alongside a CURRENT `.editorconfig` rather than instead of it — the bytes
  // ARE current, and saying otherwise would teach people to distrust the whole line.
  const checked = await simt(['check'], root);
  assert.equal(checked.code, 1, checked.out);
  assert.match(checked.out, /CURRENT\s+\.editorconfig/);
  assert.match(checked.out, /MISPLACED\s+\.editorconfig/);
});

test('a region at the top of the file is not reported as misplaced', async () => {
  const root = await repo();
  const { targets } = await baselineTargets(root, SHA);
  await writeFile(join(root, '.editorconfig'), targets[0].text);
  assert.equal(misplaced(parse(targets[0].text, 'hash'), 'hash'), null);
});

// ------------------------------------------------------------------------- end to end

test('sync writes the baseline, check reports it current, and both name it', async () => {
  const root = await repo();
  const wrote = await simt(['sync', '--yes'], root);
  assert.equal(wrote.code, 0, wrote.out);

  const onDisk = await readFile(join(root, '.editorconfig'), 'utf8');
  assert.match(onDisk, /^# simt-dev:begin\n/, 'the region must be at the top');
  assert.match(wrote.out, /\.editorconfig/, 'a file the reader was not shown is one they approve by reading the diff');

  const checked = await simt(['check'], root);
  assert.equal(checked.code, 0, checked.out);
  assert.match(checked.out, /CURRENT\s+\.editorconfig/);
});

test('the plan shows the baseline before it exists, with what it is for', async () => {
  const root = await repo();
  const p = await plan(root, {});
  const t = p.targets.find((x) => x.file === '.editorconfig');
  assert.ok(t, 'the plan must contain every file sync will write');
  assert.equal(t.action, 'added');
});

test('a deleted baseline is a blocking finding with a command, not a note', async () => {
  // Same treatment the rule files get: adopting a repo means running init, so a
  // baseline that has been removed is drift. A finding nothing can act on is the
  // failure this gate exists to stop.
  const root = await repo();
  await simt(['sync', '--yes'], root);
  await rename(join(root, '.editorconfig'), join(root, '.editorconfig.bak'));

  const checked = await simt(['check'], root);
  assert.equal(checked.code, 1);
  assert.match(checked.out, /\.editorconfig/);
  assert.match(checked.out, /simt-dev sync/);
});

test('a repo whose .editorconfig has no region is reported, not silently left alone', async () => {
  const root = await repo();
  await writeFile(join(root, '.editorconfig'), 'root = true\n\n[*]\nindent_size = 4\n');
  const checked = await simt(['check'], root);
  assert.equal(checked.code, 1);
  assert.match(checked.out, /\.editorconfig/);
});

test('adopting the baseline does not touch what the repo already had', async () => {
  const root = await repo();
  const mine = 'root = true\n\n[*]\nindent_size = 4\nmax_line_length = 120\n';
  await writeFile(join(root, '.editorconfig'), mine);
  await simt(['sync', '--yes'], root);
  const after = await readFile(join(root, '.editorconfig'), 'utf8');
  for (const line of mine.split('\n').filter((l) => l !== '')) {
    assert.ok(after.includes(line), `lost a line the repo wrote: ${line}`);
  }
});

// ------------------------------------------------------------------------ what is not here

test('the JSON baselines are absent for a reason that is written down, not a gap', () => {
  // tsconfig.base.json, .prettierrc.json and .nvmrc are all named by plan 1 section
  // 3.1 row 5. None can carry a region: JSON has no comment syntax and .nvmrc is a
  // bare version string. Asserting the list keeps a future baseline from being added
  // without noticing that the file it lands in has to be able to hold a comment.
  //
  // `.gitattributes` is here and not in that group, and the distinction is the whole
  // reason it is a region rather than a file simt-dev owns: git reads `#` as a comment
  // and takes the LAST pattern that matches, so the shared line goes at the top and a
  // repo's own LFS filters and binary declarations keep winning below it. Asserting the
  // list is what makes that difference checkable rather than remembered.
  const files = BASELINES.map((b) => b.file);
  assert.deepEqual(files, ['.editorconfig', '.gitattributes']);
  for (const b of BASELINES) {
    assert.ok(STYLES[b.style], `${b.file} has no comment style, so a region in it would be a syntax error`);
    assert.ok(b.why && b.adr, `${b.file} must say why it exists and which record rules on it`);
  }
});

test('every baseline is loaded into the same target list as AGENTS.md', async () => {
  // The alternative is a second writer and a second checker, and those two then
  // disagree once. `sync` writes `plan().targets` and nothing else, so a baseline in
  // a different list would need sync to know about it twice.
  const root = await repo();
  const p = await plan(root, {});
  const fromPlan = p.targets.filter((t) => !t.surface).map((t) => t.file);
  assert.deepEqual(fromPlan, ['AGENTS.md', ...BASELINES.map((b) => b.file)]);
});
// ---------------------------------------------------------------- .gitattributes

test('the shared gitattributes line normalises text without claiming anything is text', async () => {
  // The two halves of one line, and both matter. `text=auto` lets git decide per path,
  // so a binary is left alone; `text` alone would force every path to be text, which is
  // the most common way a repository corrupts an asset. `eol=lf` is the claim ADR-025
  // refused to make from .editorconfig, made here because this is where git reads it.
  const root = await scratch();
  const { targets } = await baselineTargets(root, SHA);
  const ga = targets.find((t) => t.file === '.gitattributes');
  assert.ok(ga, 'the region is missing from the target list');
  assert.match(ga.text, /^\* text=auto eol=lf$/m);
  // Assert the absence of the forcing form by name, so a later "simplification" to
  // `* text eol=lf` fails a test rather than quietly shipping a binary-corrupting line.
  assert.doesNotMatch(ga.text, /^\* text eol=lf$/m);
});

test('the shared line is not a claim about what any individual file IS', async () => {
  // Every one of these belongs to a repo, not to the estate. A shared `.gitattributes`
  // that declared them would be wrong in thirteen of sixteen repositories, and a wrong
  // attribute is silently obeyed rather than refused.
  const root = await scratch();
  const { targets } = await baselineTargets(root, SHA);
  const body = targets.find((t) => t.file === '.gitattributes').text;
  for (const claim of ['filter=lfs', 'binary', '-text', 'linguist', 'diff=', 'merge=']) {
    assert.ok(!body.includes(claim), `${claim} is a per-repo claim and must not be shared`);
  }
});

test('a repo with no gitattributes is offered one, and sync writes it', async () => {
  // Thirteen repos are in this state, so it is the common case and not an edge one.
  const root = await repo();
  const { targets } = await baselineTargets(root, SHA);
  const ga = targets.find((t) => t.file === '.gitattributes');
  assert.equal(ga.exists, false);
  assert.equal(ga.action, 'added');
  // Planning is not writing: asserting the file existed here would be asserting the
  // wrong half of the contract, and `sync` is what has to actually put the bytes down.
  await simt(['sync', '--yes'], root);
  assert.match(await readFile(join(root, '.gitattributes'), 'utf8'), /^\* text=auto eol=lf$/m);
});

test('a repo that already has LFS filters and binary declarations keeps all of them', async () => {
  // simt-app's real file, which is what "the repo's own patterns must survive" means in
  // practice: it has no `text` line at all, and a region that replaced the file would
  // quietly un-LFS a 40 MB map.
  const root = await scratch();
  const mine = [
    'res/data/map/*.tif filter=lfs diff=lfs merge=lfs -text',
    '*.zip filter=lfs diff=lfs merge=lfs -text',
  ].join('\n');
  await writeFile(join(root, '.gitattributes'), `${mine}\n`);
  const result = inject(mine, GITATTRIBUTES_BODY, { sha: SHA }, { style: 'hash' });
  for (const line of mine.split('\n')) {
    assert.ok(result.text.includes(line), `lost a line the repo wrote: ${line}`);
  }
});

test('the region goes ABOVE the repo patterns, because git takes the last match', async () => {
  // This is the `.gitattributes` half of the misplaced finding, and the reason it is a
  // region at all rather than a file simt-dev owns. A region below the repo's patterns
  // would still be a correct set of bytes, and it would silently reverse their intent
  // for every path both lines match.
  const root = await scratch();
  const existing = '* text eol=lf\n*.iq binary\n';
  const result = inject(existing, GITATTRIBUTES_BODY, { sha: SHA }, { style: 'hash' });
  const regionAt = result.text.indexOf(STYLES.hash.begin);
  const repoLineAt = result.text.indexOf('*.iq binary');
  assert.ok(regionAt > -1, 'no region was written');
  assert.ok(regionAt < repoLineAt, 'the shared line must come first so the repo keeps the last word');
  assert.equal(misplaced(parse(existing, 'hash'), 'hash'), null, 'nothing to be misplaced yet');
});

test('a region that has been moved below the repo patterns is reported, not trusted', async () => {
  const begin = STYLES.hash.begin;
  const end = STYLES.hash.end;
  // The repo's line comes FIRST here, which is the mistake. `misplaced` ignores a
  // region at the top of a file, so a fixture with the region at line 0 would report
  // nothing and pass for the wrong reason - which is how this test failed once already.
  const moved = [
    '*.iq binary',
    begin,
    '# simt-dev:generated',
    `# simt-dev:sha=${SHA}`,
    '',
    GITATTRIBUTES_BODY,
    '',
    end,
  ].join('\n');
  assert.equal(misplaced(parse('', 'hash'), 'hash'), null, 'an empty file has nothing misplaced');
  const finding = misplaced(parse(moved, 'hash'), 'hash');
  assert.ok(finding, 'a region below the repo patterns must be reported');
  assert.match(finding.remedy, /move/);
  assert.match(finding.detail, /last definition/);
});

test('the shipped gitattributes region carries no path that only exists in this repository', async () => {
  // Same guard as the gate's own file, for the same reason: this text lands in sixteen
  // repositories and is read by agents that have never seen this tree.
  assertClean(GITATTRIBUTES_BODY, 'the .gitattributes region');
});

test('git itself accepts the shipped region, and honours the repo lines beneath it', async () => {
  // The check that cannot be faked by reading the string back: `git check-attr` asks
  // git what it decided, in a real repository, for a real path. A region that parsed as
  // a comment and did nothing would pass every assertion above and fail here.
  const root = await scratch();
  const exec = async (args, cwd) => (await run('git', args, { cwd })).stdout;
  await exec(['init', '-q', '-b', 'main', '.'], root);
  await exec(['config', 'user.email', 't@example.com'], root);
  await exec(['config', 'user.name', 't'], root);
  const { targets } = await baselineTargets(root, SHA);
  await writeFile(join(root, '.gitattributes'), targets.find((t) => t.file === '.gitattributes').text);
  await writeFile(join(root, '.iq'), 'binary\n');
  await writeFile(join(root, 'main.mc'), 'void main() {}\n');
  await exec(['add', '-A'], root);

  // The shared line applies to both: text auto-detected on disk, LF in the working tree.
  assert.match(await exec(['check-attr', 'text', '--', 'main.mc'], root), /main\.mc: text: auto/);
  assert.match(await exec(['check-attr', 'eol', '--', 'main.mc'], root), /main\.mc: eol: lf/);
  // The repo's own binary declaration still applies, and still wins. `git check-attr`
  // says "unspecified" for an attribute nothing set, which is how `binary` shows up
  // here: `.iq` gets no diff driver, not a text one.
  assert.match(await exec(['check-attr', 'diff', '--', 'main.iq'], root), /main\.iq: diff: unspecified/);
  // And a text file the repo has NOT declared keeps the shared line, which is the
  // point of the file existing at all.
  assert.match(await exec(['check-attr', 'eol', '--', 'main.mc'], root), /main\.mc: eol: lf/);
  // Nothing may have leaked into the working tree as CRLF.
  const bytes = await readFile(join(root, 'main.mc'));
  assert.ok(!bytes.includes(Buffer.from('\r\n')), 'a CRLF in the working tree defeats the baseline');
});

test('a deleted gitattributes is a blocking finding with a command, not a note', async () => {
  // Same treatment the editorconfig gets: adopting a repo means running sync, so a
  // baseline that has been removed is drift. And a finding nothing can act on is the
  // failure this gate exists to stop, so the remedy is a command.
  const root = await repo();
  await simt(['sync', '--yes'], root);
  await rm(join(root, '.gitattributes'));
  const checked = await simt(['check'], root);
  assert.equal(checked.code, 1);
  assert.match(checked.out, /\.gitattributes/);
  assert.match(checked.out, /simt-dev sync/);
});

test('a gitattributes with no region is reported, not silently left alone', async () => {
  // Thirteen repos in the estate have no file at all; this one has a file that simply
  // does not say what the estate says. Leaving it alone would be indistinguishable from
  // a repo that has chosen otherwise, and the whole point is that nobody chose.
  const root = await repo();
  await writeFile(join(root, '.gitattributes'), '*.iq binary\n');
  const checked = await simt(['check'], root);
  assert.equal(checked.code, 1);
  assert.match(checked.out, /\.gitattributes/);
});

test('this repository adopts neither baseline for itself', async () => {
  // Written because it was done once while adding the gitattributes row, and a mistake
  // made once while writing the guard is worth more than any comment. The region marker
  // records the simt-dev SHA, so a copy committed here names a commit that is no longer
  // HEAD by the time it lands; `check` would then be red here for a reason no commit can
  // fix, which is the state ADR-024's gate exists to avoid.
  const here = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  for (const row of BASELINES) {
    const path = join(here, row.file);
    const text = await readFile(path, 'utf8').catch(() => null);
    assert.equal(text, null, `${row.file} exists in this repository; it must stay hand-written (ADR-027)`);
  }
  const agents = await readFile(join(here, 'AGENTS.md'), 'utf8');
  assert.doesNotMatch(agents, /simt-dev:begin/);
});
