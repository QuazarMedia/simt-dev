// `simt completions <shell>` (plan 0003 R51): zsh, bash and fish, generated
// from the command registry.
//
// The acceptance criterion is determinism, so that is the first test. The
// second is the one review 0002 S15 made load-bearing for `--help`: every
// command and flag the binary accepts must appear in every script, because a
// completion that misses a command is a command an installed shell hides —
// the S15 defect wearing a different file. The scripts are also syntax-checked
// with each shell's own parser where that shell exists on this machine; fish
// is not on every runner, so its check skips loudly rather than passing
// silently on an unrun assertion.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SHELLS, renderCompletions, shape } from '../src/completions.mjs';
import { COMMANDS } from '../src/commands/index.mjs';
import { BOOL_FLAGS, VALUE_FLAGS } from '../src/argv.mjs';

const exec = promisify(execFile);

async function run(args) {
  try {
    const { stdout, stderr } = await exec('node', [new URL('../bin/simt.mjs', import.meta.url).pathname, ...args], {
      maxBuffer: 8 << 20,
      env: { ...process.env, NO_COLOR: '1' },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

const escape = (word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A word present as a whole token, not as a fragment of a longer one. */
const word = (w) => new RegExp(`(^|[\\s'(=])${escape(w)}([\\s')]|$)`);

test('the same registry renders byte-identical scripts, run after run', () => {
  for (const shell of SHELLS) {
    const first = renderCompletions(shell, COMMANDS);
    const second = renderCompletions(shell, [...COMMANDS].reverse());
    assert.equal(first, second, `${shell}: input order changed the output, so the render is not deterministic`);
    assert.ok(first.endsWith('\n'), `${shell}: the script is not newline-terminated`);
  }
});

test('every dispatchable command completes in every shell', () => {
  const { top, groups } = shape(COMMANDS);
  // Every path's words: the first word at level one, the subcommand under its
  // group. A path the registry dispatches but no script offers is the S15
  // defect in a completion file.
  const scripts = Object.fromEntries(SHELLS.map((s) => [s, renderCompletions(s, COMMANDS)]));
  const groupWords = new Map(groups);
  for (const path of COMMANDS) {
    const [first, second] = path.split(' ');
    assert.ok(top.includes(first), `shape dropped the first word of ${path}`);
    if (second !== undefined) {
      assert.ok(
        (groupWords.get(first) ?? []).includes(second),
        `shape dropped ${path} from the ${first} group`,
      );
    }
  }
  for (const shell of SHELLS) {
    for (const w of top) {
      assert.match(scripts[shell], word(w), `${shell}: top-level command ${w} does not complete`);
    }
    for (const [group, subs] of groups) {
      for (const sub of subs) {
        assert.match(scripts[shell], word(sub), `${shell}: ${group} ${sub} does not complete`);
      }
    }
  }
});

test('every flag the parser accepts is offered in every shell', () => {
  const flags = [...new Set([...BOOL_FLAGS, ...VALUE_FLAGS])];
  for (const shell of SHELLS) {
    const script = renderCompletions(shell, COMMANDS);
    for (const flag of flags) {
      // fish spells a long option `-l json`, not `--json`; assert the shell's
      // own spelling rather than a shared approximation of it.
      const spelling = shell === 'fish' ? `-l ${flag}` : `--${flag}`;
      assert.ok(
        script.includes(spelling),
        `${shell}: --${flag} is accepted by the parser but never offered`,
      );
    }
  }
});

test('a value flag hands the next word to file completion, not to commands', () => {
  // `simt --root <TAB>` must complete paths. The mechanism differs per shell —
  // a `case` on the previous word in bash/zsh, `-r` in fish — so each shell's
  // own spelling is asserted rather than a shared approximation.
  const bash = renderCompletions('bash', COMMANDS);
  const bashPrev = /case "\$prev" in([\s\S]*?)esac/.exec(bash);
  assert.ok(bashPrev, 'bash: no prev-word case');
  assert.match(bashPrev[1], /--root/, 'bash: --root does not route to file completion');
  assert.match(bashPrev[1], /return 0/, 'bash: the prev-word case falls through to words');

  const zsh = renderCompletions('zsh', COMMANDS);
  const zshPrev = /case "\$prev" in([\s\S]*?)esac/.exec(zsh);
  assert.ok(zshPrev, 'zsh: no prev-word case');
  assert.match(zshPrev[1], /--root/, 'zsh: --root does not route to file completion');
  assert.match(zshPrev[1], /_files/, 'zsh: the prev-word case falls through to words');

  const fish = renderCompletions('fish', COMMANDS);
  assert.match(fish, /complete -c simt -l root -r/);
  assert.match(fish, /complete -c simt -l yes\n/, 'a boolean flag must not demand a value');
});

test('the scripts parse: bash always, zsh and fish when the shell is installed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'simt-compl-'));
  try {
    for (const shell of SHELLS) {
      const path = join(dir, `simt.${shell}`);
      await writeFile(path, renderCompletions(shell, COMMANDS));
      // `bash -n` parses without running: the function body never executes, so
      // COMP_WORDS being unset cannot matter to the assertion.
      if (shell === 'bash') {
        const parsed = spawnSync('bash', ['-n', path], { encoding: 'utf8' });
        assert.equal(parsed.status, 0, `bash -n rejected the generated script:\n${parsed.stderr}`);
        continue;
      }
      const probe = spawnSync('which', [shell], { encoding: 'utf8' });
      if (probe.status !== 0) {
        // Not skipped silently: the diagnostic says the assertion never ran.
        console.log(`# ${shell} is not installed here; its syntax check did not run`);
        continue;
      }
      const parsed = spawnSync(shell, ['-n', path], { encoding: 'utf8' });
      assert.equal(parsed.status, 0, `${shell} -n rejected the generated script:\n${parsed.stderr}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the zsh script completes flags, value-flag paths and commands when driven under zsh', async () => {
  const probe = spawnSync('which', ['zsh'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    // Not skipped silently: the diagnostic says the assertion never ran.
    console.log('# zsh is not installed here; the driven completion check did not run');
    return;
  }
  // The render tests above read the script as text; this one runs it. `zsh -f`
  // sources the generated function with `compadd` and `_files` stubbed, then
  // drives `_simt` the way compsys would: `words` is the command line and
  // `CURRENT` the word being completed.
  const dir = await mkdtemp(join(tmpdir(), 'simt-zsh-'));
  try {
    const scriptPath = join(dir, '_simt.zsh');
    await writeFile(scriptPath, renderCompletions('zsh', COMMANDS));
    const driverPath = join(dir, 'drive.zsh');
    await writeFile(
      driverPath,
      [
        'compadd() {',
        '  print -- "COMPSADD:"',
        '  local x',
        '  for x in "$@"; do print -- "  $x"; done',
        '}',
        '_files() { print -- "FILES"; }',
        `source '${scriptPath}'`,
        'words=(simt --pre)',
        'CURRENT=2',
        '_simt',
        "print -- '==='",
        "words=(simt skills --root '')",
        'CURRENT=4',
        '_simt',
        "print -- '==='",
        "words=(simt '')",
        'CURRENT=2',
        '_simt',
        '',
      ].join('\n'),
    );
    const ran = spawnSync('zsh', ['-f', driverPath], { encoding: 'utf8' });
    assert.equal(ran.status, 0, `zsh -f rejected the driven script:\n${ran.stderr}`);
    const [flagsOut, valueOut, topOut] = ran.stdout.split('===');
    assert.match(flagsOut, /COMPSADD:/, 'simt --pre<TAB> must offer flags');
    assert.match(flagsOut, /--root/, 'the flag list must include --root');
    assert.doesNotMatch(flagsOut, /FILES/, 'a flag word must not fall through to file completion');
    assert.match(valueOut, /FILES/, 'simt skills --root <TAB> must complete paths');
    assert.doesNotMatch(valueOut, /COMPSADD:/, 'a value flag must not offer words');
    assert.match(topOut, /COMPSADD:/, 'simt <TAB> must offer commands');
    assert.match(topOut, /bench/, 'the top-level list must include bench');
    assert.doesNotMatch(topOut, /FILES/, 'a bare command word must not fall through to files');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('completions without a shell is a usage error naming the shells', async () => {
  const bare = await run(['completions']);
  assert.equal(bare.code, 2, bare.stdout + bare.stderr);
  assert.match(`${bare.stdout}${bare.stderr}`, /bash, fish, zsh/);

  const unknown = await run(['completions', 'powershell']);
  assert.equal(unknown.code, 2, unknown.stdout + unknown.stderr);
  assert.match(`${unknown.stdout}${unknown.stderr}`, /unknown shell `powershell`/);
});

test('--json carries the same bytes the redirect would write', async () => {
  const text = await run(['completions', 'zsh']);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /^#compdef simt/);

  const json = await run(['completions', 'zsh', '--json']);
  assert.equal(json.code, 0, json.stderr);
  const payload = JSON.parse(json.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.command, 'completions');
  assert.equal(payload.shell, 'zsh');
  assert.equal(payload.script, text.stdout, 'the document and the redirect disagree');
});