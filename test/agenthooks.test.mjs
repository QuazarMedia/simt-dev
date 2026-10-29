// Agent-time hooks (plan 0003 R15): one policy table, six dialects, and the same
// decision whichever harness asks.
//
// Every harness case feeds the payload that harness documents, because the whole
// difficulty of this surface is that the six vendors agree on nothing - not the config
// path, not the event name, not the field the command arrives in, not the field a
// denial comes back in. A fixture written from our own idea of the shape would pass here
// and fail on the first real tool call.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decide, overrides } from '../src/agenthooks/decide.mjs';
import { adapter, adapters, hookCommand, hookPath, hookRows } from '../src/agenthooks/render.mjs';
import { AGENT_HOOK_SHIM, renderAgentHookShim } from '../src/agenthooks/shim.mjs';
import { EVENTS, POLICY_IDS } from '../src/agenthooks/policy.mjs';
import { SQLITE_FILE } from '../src/index/persist.mjs';
import { MANIFEST_FILE } from '../src/name.mjs';
import { git } from './fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', 'bin', 'simt.mjs');
const ROOT = join(HERE, '..');

const made = [];
test.after(async () => {
  const { rm } = await import('node:fs/promises');
  for (const dir of made) await rm(dir, { recursive: true, force: true });
});

/** A repository with a git directory, so `agent-hooks` has a root that is one. */
async function repo(files = {}) {
  const root = await mkdtemp(join(tmpdir(), 'simt-agent-'));
  made.push(root);
  for (const [name, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), text);
  }
  return root;
}

/**
 * Run the shipped binary with a payload on stdin.
 *
 * `execFileSync`, not `execFile`: the hook reads its payload from stdin and closes over
 * it, and the synchronous form is the one that can hand a child its input.
 */
/**
 * Run the shipped binary with a payload on stdin.
 *
 * Both streams are returned, and `text` is both of them: the decision document goes to
 * stdout because that is the channel the harness parses, and the reasons go to stderr
 * because that is the channel a person reads. A test that looked at only one of the two
 * would miss half of what a hook says to the four different consumers of it.
 */
function cli(args, { input = '', env = {} } = {}) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    input,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { code: result.status ?? 1, stdout, stderr, text: `${stdout}${stderr}` };
}

/** The payload each harness documents for a shell call, in its own field names. */
const shell = {
  claude: (command, root) =>
    JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: root }),
  codex: (command, root) =>
    JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: root }),
  cursor: (command, root) =>
    JSON.stringify({ hook_event_name: 'preToolUse', tool_name: 'Shell', tool_input: { command }, working_directory: root }),
  antigravity: (command, root) =>
    JSON.stringify({ hook_event_name: 'PreToolUse', toolCall: { name: 'run_command', args: { CommandLine: command, Cwd: root } }, workspacePaths: [root] }),
  gemini: (command, root) =>
    JSON.stringify({ hook_event_name: 'BeforeTool', tool_name: 'run_shell_command', tool_input: { command }, cwd: root }),
  opencode: (command, root) =>
    JSON.stringify({ tool: 'shell', input: { command }, cwd: root }),
};

/** The payload each harness documents for a file write, in its own field names. */
const write = {
  claude: (file, root) =>
    JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: file, content: 'x' }, cwd: root }),
  codex: (file, root) =>
    JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'apply_patch',
      tool_input: { command: `*** Begin Patch\n*** Update File: ${file}\n@@\n-x\n+y\n*** End Patch\n` },
      cwd: root,
    }),
  cursor: (file, root) =>
    JSON.stringify({ hook_event_name: 'preToolUse', tool_name: 'Write', tool_input: { file_path: file, content: 'x' }, working_directory: root }),
  antigravity: (file, root) =>
    JSON.stringify({ hook_event_name: 'PreToolUse', toolCall: { name: 'write_to_file', args: { TargetFile: file, CodeContent: 'x' } }, workspacePaths: [root] }),
  gemini: (file, root) =>
    JSON.stringify({ hook_event_name: 'BeforeTool', tool_name: 'write_file', tool_input: { file_path: file, content: 'x' }, cwd: root }),
  opencode: (file, root) =>
    JSON.stringify({ tool: 'write', input: { path: file, content: 'x' }, cwd: root }),
};

/** A generated region, in the html style and in the hash style the baselines use. */
const REGION_HTML = [
  '# Notes',
  '',
  '<!-- simt:begin -->',
  '<!-- simt:sha=abc1234 -->',
  'Generated content. Do not edit by hand - your changes are overwritten.',
  '',
  '## Core',
  '',
  '- a rule',
  '<!-- simt:end -->',
  '',
].join('\n');
const REGION_HASH = ['# top', '', '# simt:begin', '# simt:sha=abc1234', '# simt:end', ''].join('\n');

const HOOK = (id, payload, options) => cli(['agent-hook', EVENTS[0], '--harness', id], { input: payload, ...options });

test('every harness blocks a push, in its own dialect and with its own exit code', async () => {
  const root = await repo();
  const expected = {
    claude: (json) => json.hookSpecificOutput.permissionDecision === 'deny',
    codex: (json) => json.hookSpecificOutput.permissionDecision === 'deny',
    cursor: (json) => json.permission === 'deny',
    antigravity: (json) => json.decision === 'deny',
    gemini: (json) => json.decision === 'deny',
    opencode: (json) => typeof json.reason === 'string' && json.reason.length > 0,
  };
  for (const row of adapters()) {
    const result = HOOK(row.id, shell[row.id]('git push origin main', root));
    assert.equal(result.code, row.denyExit, `${row.id} exited ${result.code}, expected ${row.denyExit}`);
    const json = JSON.parse(result.stdout);
    assert.ok(expected[row.id](json), `${row.id} answered ${result.stdout}`);
    assert.match(result.text, /ADR-001/, `${row.id} blocked without naming the ruling`);
    assert.match(result.text, new RegExp(`override: SIMT_ALLOW=push`), `${row.id} did not name its override`);
  }
});

test('a rewrite blocks too, and the message is the record that governs it', async () => {
  const root = await repo();
  for (const row of adapters()) {
    const result = HOOK(row.id, shell[row.id]('git commit --amend -m x', root));
    assert.equal(result.code, row.denyExit, `${row.id} let an amend through`);
    assert.match(result.text, /ADR-017/, `${row.id} blocked without naming the record`);
  }
});

test('an ordinary command is not a decision, so nothing is printed', async () => {
  const root = await repo();
  for (const row of adapters()) {
    const result = HOOK(row.id, shell[row.id]('ls -la', root));
    assert.equal(result.code, 0, `${row.id} exited ${result.code} on an ordinary command`);
    assert.equal(result.stdout, '', `${row.id} printed a decision for a command no policy names`);
  }
});

test('every policy that matches is reported, so lifting one does not carry another', async () => {
  const root = await repo();
  // `git push --force` is both a push and a rewrite. Lifting `push` must leave the
  // rewrite rule standing, or one override would silently cover two rules.
  const result = HOOK('claude', shell.claude('git push --force', root), { env: { SIMT_ALLOW: 'push' } });
  assert.equal(result.code, 2);
  assert.match(result.text, /ADR-017/);
  const json = JSON.parse(result.stdout);
  assert.equal(json.hookSpecificOutput.permissionDecision, 'deny');
});

test('the override lifts exactly the policy it names, and says so', async () => {
  const root = await repo();
  const lifted = HOOK('claude', shell.claude('git push origin main', root), { env: { SIMT_ALLOW: 'push' } });
  assert.equal(lifted.code, 0);
  assert.match(lifted.text, /allowed by SIMT_ALLOW: push/);

  // A typo in the variable is reported rather than ignored: an author who wrote the
  // wrong name believes they lifted something, and silence would confirm it.
  const typo = HOOK('claude', shell.claude('ls', root), { env: { SIMT_ALLOW: 'pusch' } });
  assert.equal(typo.code, 0);
  assert.match(typo.text, /SIMT_ALLOW names no policy: pusch/);
  assert.match(typo.text, new RegExp(POLICY_IDS.join(', ')));

  assert.deepEqual([...overrides({ SIMT_ALLOW: 'push, rewrite ,,nope' }).ids], ['push', 'rewrite']);
  assert.deepEqual(overrides({ SIMT_ALLOW: 'push, rewrite ,,nope' }).unknown, ['nope']);
});

test('the normalised command is what a policy matches, in every spelling the review counted', async () => {
  // Each of these was allowed by the regex the normaliser replaced (review 0003 Q01):
  // the same act, spelled the way an agent finds easiest. The list is the evidence,
  // so it is asserted whole rather than sampled.
  const root = await repo();
  const denied = [
    ['git -C . push', ['ADR-001']],
    ['git -c x=y push', ['ADR-001']],
    ['git --no-pager push', ['ADR-001']],
    ['/usr/bin/git push', ['ADR-001']],
    ['sh -c \'git push\'', ['ADR-001']],
    ['`git push`', ['ADR-001']],
    ['$(git push)', ['ADR-001']],
    ['(git push)', ['ADR-001']],
    ['git push;echo ok', ['ADR-001']],
    ['git push&&echo ok', ['ADR-001']],
    ['git send-pack origin refs/heads/main', ['ADR-001']],
    ['git commit -n -m x', ['ADR-017']],
    ['git commit --amen -m x', ['ADR-017']],
    ['git commit --no-verif -m x', ['ADR-017']],
    ['git reset --har', ['ADR-017']],
    ['git reset -q --hard', ['ADR-017']],
    ['git -C . commit --amend', ['ADR-017']],
    ['git pull --rebase', ['ADR-017']],
    ['git push -fu origin main', ['ADR-001', 'ADR-017']],
    ['git push origin +main', ['ADR-001', 'ADR-017']],
    ['sudo -u ci git push', ['ADR-001']],
    ['env FOO=1 bash -lc \'git push\'', ['ADR-001']],
    ['eval git push', ['ADR-001']],
    ['xargs git push', ['ADR-001']],
    ['time git push', ['ADR-001']],
    ['git -c core.hooksPath=/dev/null commit', ['ADR-104']],
    ['git config core.hooksPath /tmp/elsewhere', ['ADR-104']],
    ['rm -rf .simt-hooks', ['ADR-104']],
  ];
  for (const [command, adrs] of denied) {
    const result = HOOK('claude', shell.claude(command, root));
    assert.equal(result.code, 2, `${command} was not denied: ${result.text}`);
    for (const adr of adrs) assert.match(result.text, new RegExp(adr), `${command} did not name ${adr}: ${result.text}`);
  }

  // The false positives the regex made: a flag or a phrase inside a command that is
  // not git, and the git commands the policies do not name.
  const allowed = [
    'ls -la',
    'echo --no-verify',
    'grep -r "git rebase" docs',
    'git status',
    'git commit -m x',
    'git reset --soft HEAD~1',
    'rm -rf build',
  ];
  for (const command of allowed) {
    const result = HOOK('claude', shell.claude(command, root));
    assert.equal(result.code, 0, `${command} was denied: ${result.text}`);
    assert.equal(result.stdout, '', `${command} produced a decision document`);
  }

  // A command the tokenizer cannot read is judged by the old regex, never by nothing:
  // the push at the start of this one is seen by the fallback even though the quote
  // that ends the line never closes.
  const unbalanced = HOOK('claude', shell.claude('git push origin main && echo "x', root));
  assert.equal(unbalanced.code, 2);
  assert.match(unbalanced.text, /ADR-001/);
});

test('an alias is what the author configured it to be, and the lookup pays for itself', async () => {
  // The one fact a payload cannot carry: what `git p` expands to in the author's own
  // configuration. The repository's config wins over a developer's global aliases, so
  // the fixture is deterministic on any machine.
  const root = await repo();
  await git(['init', '-q', root]);
  for (const [name, value] of [['p', 'push'], ['f', 'push --force'], ['s', '!git push'], ['zzz', 'status']]) {
    await git(['-C', root, 'config', `alias.${name}`, value]);
  }

  const p = HOOK('claude', shell.claude('git p', root));
  assert.equal(p.code, 2, `git p with alias.p=push was not denied: ${p.text}`);
  assert.match(p.text, /ADR-001/);

  const f = HOOK('claude', shell.claude('git f', root));
  assert.equal(f.code, 2, `git f with alias.f=push --force was not denied: ${f.text}`);
  assert.match(f.text, /ADR-001/);
  assert.match(f.text, /ADR-017/);

  const s = HOOK('claude', shell.claude('git s', root));
  assert.equal(s.code, 2, `git s with alias.s=!git push was not denied: ${s.text}`);
  assert.match(s.text, /ADR-001/);

  // An alias to a subcommand no policy names is not a violation.
  const zzz = HOOK('claude', shell.claude('git zzz', root));
  assert.equal(zzz.code, 0, `git zzz with alias.zzz=status was denied: ${zzz.text}`);
  assert.equal(zzz.stdout, '');
});

test('an edit inside a generated region is refused, in both marker styles', async () => {
  const root = await repo({ 'AGENTS.md': REGION_HTML, '.editorconfig': REGION_HASH, 'src/x.mjs': 'export const x = 1;\n' });
  for (const row of adapters()) {
    for (const file of ['AGENTS.md', '.editorconfig']) {
      const result = HOOK(row.id, write[row.id](file, root));
      assert.equal(result.code, row.denyExit, `${row.id} let an edit into ${file} through`);
      assert.match(result.text, /ADR-036/, `${row.id} did not name the record for generated bytes`);
      assert.match(result.text, /sync --yes/, `${row.id} denied without a next step`);
    }
    // A file this tool does not write is not its business.
    const ordinary = HOOK(row.id, write[row.id]('src/x.mjs', root));
    assert.equal(ordinary.code, 0, `${row.id} blocked an ordinary edit`);
  }
});

test('a write under a submodule path is refused, because the content is not this repository’s', async () => {
  const root = await repo({
    '.gitmodules': '[submodule "app-ui"]\n\tpath = app-ui\n\turl = https://example.invalid/x.git\n',
    'app-ui/README.md': '# app\n',
  });
  const result = HOOK('claude', write.claude('app-ui/README.md', root));
  assert.equal(result.code, 2);
  assert.match(result.text, /ADR-036/);
});

test('a payload with nothing to check is not evidence of a violation', async () => {
  // A harness that calls the hook with no payload has told us nothing, and a hook that
  // blocks on nothing stops real work — which is how it gets uninstalled. Stated as a
  // test because "no facts" is the branch a later change is most likely to get wrong.
  const root = await repo();
  const empty = cli(['agent-hook', EVENTS[0], '--harness', 'claude'], { input: '' });
  assert.equal(empty.code, 0);
  assert.equal(empty.stdout, '');

  const garbage = cli(['agent-hook', EVENTS[0], '--harness', 'claude'], { input: 'not json at all' });
  assert.equal(garbage.code, 0);
  assert.equal(garbage.stdout, '');

  const unknownShape = HOOK('claude', JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Something', cwd: root }));
  assert.equal(unknownShape.code, 0);
});

test('a mistake in the hook’s own invocation exits 1, because exit 2 means block', async () => {
  // The one place a wrong exit code is a product defect rather than a detail: every
  // harness reads 2 as "block this tool call", so a typo in a config would stop an agent
  // from doing anything at all, one call at a time.
  const missing = cli(['agent-hook', EVENTS[0]], { input: '{}' });
  assert.equal(missing.code, 1);
  assert.match(missing.text, /needs --harness/);
  assert.match(missing.text, new RegExp(adapters().map((a) => a.id).join(', ')));

  const unknown = cli(['agent-hook', EVENTS[0], '--harness', 'windsurf'], { input: '{}' });
  assert.equal(unknown.code, 1);
  assert.match(unknown.text, /unknown harness/);

  const event = cli(['agent-hook', 'after-tool-use', '--harness', 'claude'], { input: '{}' });
  assert.equal(event.code, 1);
  assert.match(event.text, new RegExp(`known events: ${EVENTS.join(', ')}`));
});

test('install merges into the file a harness already owns', async () => {
  const root = await repo({
    '.claude/settings.json': `${JSON.stringify(
      { model: 'opus', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }] } },
      null,
      2,
    )}\n`,
  });

  const preview = cli(['agent-hooks', 'install', '--root', root]);
  assert.equal(preview.code, 0);
  assert.match(preview.text, /PLAN     nothing written/);
  assert.match(preview.text, /CREATE\s+shim\s+\.simt-hooks\/agent-hook/, 'a preview that hides the shim is planning a write it does not show');
  assert.equal(await readFile(join(root, '.codex', 'hooks.json'), 'utf8').catch(() => null), null, 'a preview wrote a file');
  assert.equal(
    await readFile(join(root, AGENT_HOOK_SHIM), 'utf8').catch(() => null),
    null,
    'a preview wrote the shim',
  );

  const install = cli(['agent-hooks', 'install', '--root', root, '--yes']);
  assert.equal(install.code, 0);
  assert.match(install.text, /CREATE\s+shim\s+\.simt-hooks\/agent-hook/);
  // The shim is what the configs point at, so it is asserted the way a config is:
  // exact bytes, and executable, because a harness runs it, not node.
  assert.equal(await readFile(join(root, AGENT_HOOK_SHIM), 'utf8'), renderAgentHookShim({ npm: false }));
  await access(join(root, AGENT_HOOK_SHIM), constants.X_OK);

  const claude = JSON.parse(await readFile(join(root, '.claude', 'settings.json'), 'utf8'));
  assert.equal(claude.model, 'opus', 'install dropped a key the harness owns');
  assert.equal(claude.hooks.PreToolUse.length, 2, 'install replaced an entry the harness owns');
  assert.equal(claude.hooks.PreToolUse[0].hooks[0].command, 'echo hi', 'install rewrote an entry the harness owns');
  assert.equal(claude.hooks.PreToolUse[1].hooks[0].command, hookCommand('claude'));

  for (const row of adapters()) {
    // Raw text, not parsed JSON: the opencode entry is a plugin file this tool owns
    // whole, and every form carries the same command verbatim.
    const text = await readFile(join(root, hookPath(row.id)), 'utf8');
    assert.ok(text.includes(hookCommand(row.id)), `${row.id} has no hook running this tool`);
  }

  // A second install is a no-op, which is what makes it safe to run from a script.
  const again = cli(['agent-hooks', 'install', '--root', root, '--yes']);
  assert.equal(again.code, 0);
  assert.equal(again.text.match(/UNCHANGED/g)?.length, adapters().length + 1, again.text);
});

test('install refuses to touch a config it cannot read, and says which', async () => {
  const root = await repo({ '.cursor/hooks.json': '{ not json\n' });
  const preview = cli(['agent-hooks', 'install', '--root', root]);
  assert.equal(preview.code, 1, 'a config nobody can parse is not a config this tool may replace');
  assert.match(preview.text, /REFUSED/);
  assert.match(preview.text, /cursor/);
  const written = cli(['agent-hooks', 'install', '--root', root, '--yes']);
  assert.equal(written.code, 1);
  assert.equal(await readFile(join(root, '.codex', 'hooks.json'), 'utf8').catch(() => null), null, 'a refused install wrote another harness');
});

test('status reports every reader, including the ones this tool does not write', async () => {
  const root = await repo();
  const fresh = cli(['agent-hooks', 'status', '--root', root]);
  // A hook nobody installed is a state, not a defect: the harness config is a file the
  // harness owns for other reasons, and a repository that does not use Cursor is not
  // broken. Only a config this tool cannot read is a problem.
  assert.equal(fresh.code, 0, fresh.text);
  for (const row of adapters()) assert.match(fresh.text, new RegExp(`ABSENT\\s+${row.id}`));
  for (const row of hookRows()) {
    if (row.path === null) assert.match(fresh.text, new RegExp(`NO FILE\\s+${row.id}`));
    else if (adapter(row.id) === null) assert.match(fresh.text, new RegExp(`NOT OURS\\s+${row.id}`));
  }

  cli(['agent-hooks', 'install', '--root', root, '--yes']);
  const installed = cli(['agent-hooks', 'status', '--root', root]);
  for (const row of adapters()) assert.match(installed.text, new RegExp(`PRESENT\\s+${row.id}`));
  assert.match(installed.text, /trusted/, 'codex skips a hook nobody trusted, and status has to say so');
});

test('status fails on a config it cannot read, in both surfaces', async () => {
  const root = await repo({ '.codex/hooks.json': 'nope', '.claude/settings.json': '[]' });
  const text = cli(['agent-hooks', 'status', '--root', root]);
  assert.equal(text.code, 1);
  assert.match(text.text, /INVALID\s+codex/);
  assert.match(text.text, /not a JSON object/);

  const json = cli(['agent-hooks', 'status', '--root', root, '--json']);
  const payload = JSON.parse(json.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.command, 'agent-hooks status');
  assert.equal(payload.ok, json.code === 0);
  assert.equal(payload.problems.length, 2, JSON.stringify(payload.problems));
});

test('install reports the harnesses it did not write, rather than staying quiet about them', async () => {
  const root = await repo();
  const json = cli(['agent-hooks', 'install', '--root', root, '--yes', '--json']);
  const payload = JSON.parse(json.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.filesWritten, true);
  assert.equal(payload.written.length, adapters().length);
  assert.deepEqual(payload.shim, { id: 'shim', path: AGENT_HOOK_SHIM, action: 'create', written: true });
  assert.deepEqual(
    payload.notWritten.map((n) => n.id).sort(),
    hookRows().filter((r) => adapter(r.id) === null).map((r) => r.id).sort(),
  );
});

test('the command in the config is the command the reader types', async () => {
  for (const row of adapters()) {
    // The shim, never the bare binary: a harness does not share the shell's PATH, so a
    // config naming `simt` runs nothing on Claude and blocks everything on Cursor.
    assert.equal(hookCommand(row.id), `${AGENT_HOOK_SHIM} ${EVENTS[0]} --harness ${row.id}`);
  }
  const root = await repo();
  cli(['agent-hooks', 'install', '--root', root, '--yes']);
  const text = await readFile(join(root, hookPath('cursor')), 'utf8');
  // Cursor fails open unless a hook says otherwise, so a written entry says otherwise.
  assert.match(text, /"failClosed": true/);
  assert.equal(JSON.parse(text).version, 1, "cursor's example carries its version");
});

test('nothing on the hook path reads the repository, and the entry point does not load the registry', async () => {
  // The plan's acceptance criterion for this slice is a latency, and a latency test on a
  // shared machine measures the machine — twenty runs put this path at 97 ms p50 against
  // 85 ms for `node -e 0`, so a threshold here would assert the weather. What is asserted
  // instead is the structural commitment that produces it: the hot path imports the policy,
  // the decision and the renderer, and nothing whose job is to find out what a repository
  // contains; and `bin/` keeps the registry out of it, so the hot command does not pay for
  // twenty-four commands it is not running.
  //
  // `projection/markers.mjs` and `projection/loaders.mjs` are on the path and are not in
  // the list below on purpose: the first answers whether a file already holds a region, the
  // second is the reader table's paths, and neither reads anything at import. The modules
  // forbidden here are the ones that take a root and go looking.
  const hookFiles = [
    'src/agenthooks/policy.mjs',
    'src/agenthooks/decide.mjs',
    'src/agenthooks/render.mjs',
    'src/commands/agenthook.mjs',
  ];
  const forbidden = [
    '../resolve/',
    '../compare/',
    '../bench/',
    '../graph/',
    '../upgrade/',
    '../mcp/',
    '../workspace.mjs',
    '../projection/manifest.mjs',
    '../projection/project.mjs',
    '../projection/rules.mjs',
    '../commands/index.mjs',
  ];
  for (const file of hookFiles) {
    const text = await readFile(join(ROOT, file), 'utf8');
    for (const heavy of forbidden) {
      assert.equal(text.includes(`'${heavy}`), false, `${file} imports ${heavy}, which reads the repository`);
    }
  }
  const bin = await readFile(join(ROOT, 'bin', 'simt.mjs'), 'utf8');
  assert.equal(
    /^import .*commands\/index\.mjs/m.test(bin),
    false,
    'bin/ imports the command registry statically, so every hook pays for every command',
  );
  assert.match(bin, /await import\('\.\.\/src\/commands\/index\.mjs'\)/);
});

test('the decision itself is measured, and nothing larger is claimed for it', async () => {
  const facts = { command: 'git push origin main', writes: [] };
  const times = [];
  for (let i = 0; i < 200; i += 1) {
    const start = process.hrtime.bigint();
    decide({ facts, env: {} });
    times.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  times.sort((a, b) => a - b);
  const p95 = times[Math.floor(times.length * 0.95)];
  // The plan asks for a hook p95 under 100 ms. That number cannot be demonstrated here
  // and this test does not pretend to: on the machine this was written on a bare
  // `node -e 0` costs ~87 ms before any of this code runs. What is asserted is the part
  // this slice owns - the decision and its two reads - against a bound two orders of
  // magnitude above what it measures.
  assert.ok(p95 < 5, `the decision p95 was ${p95.toFixed(3)} ms`);
});

test('a grant nobody can point at is not a policy', async () => {
  // The override is the escape hatch, and an unknown name in it must not silently widen
  // what is allowed. It is also the one place a harness-agnostic vocabulary is checked
  // against a name a person typed, so it is asserted at the table rather than in a hook.
  const decision = decide({ facts: { command: 'git push', writes: [] }, env: { SIMT_ALLOW: 'push,whatever' } });
  assert.deepEqual(decision.blocked, []);
  assert.deepEqual(decision.lifted, ['push']);
  assert.deepEqual(decision.unknown, ['whatever']);
});

// Delivery (plan 0003 R29). The second event is not a decision and none of these tests is
// about blocking: a prompt hook that could stop a person's prompt is a hook whose own bug
// is a person who cannot type. What is asserted is that the packet reaches stdout - the
// channel the harness reads - in the harness's own key, inside the ceiling, and only in a
// repository that asked for it.

/** The payload each harness documents for a submitted prompt, in its own field names. */
const prompt = {
  claude: (text, root) => JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: text, cwd: root }),
  codex: (text, root) => JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: text, cwd: root }),
};

/** The delivery entry point, which is not the decision's: same command, other event. */
const DELIVER = (id, payload, options) => cli(['agent-hook', EVENTS[1], '--harness', id], { input: payload, ...options });

/**
 * A repository a delivery can serve: a git history, the opt-in in the manifest, and an
 * index that is already warm - because a delivered packet never builds one, so a fixture
 * without an index would be asserting the cold path by accident.
 */
async function served(optIn = { brief: {} }, { warm = true } = {}) {
  const root = await repo({
    [MANIFEST_FILE]: `${JSON.stringify({ id: 'fixture', ...optIn }, null, 2)}\n`,
    'package.json': `${JSON.stringify({ name: 'fixture', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`,
    'README.md': '# fixture\n',
    'src/keep.mjs': 'export function keep(value) {\n  return value;\n}\n',
    'test/keep.test.mjs':
      "import assert from 'node:assert/strict';\nimport { keep } from '../src/keep.mjs';\n\ntest('keep', () => assert.equal(keep(1), 1));\n",
  });
  // Installation and status read the manifest and the config files and nothing else, so a
  // fixture for them carries no history and no index: warming one would be a git commit and
  // a whole index built for a test that never opens either.
  if (!warm) return root;
  await git(['init', '-q', root]);
  await git(['-C', root, 'add', '-A']);
  await git(['-C', root, 'commit', '-qm', 'initial']);
  // Warm the index the way a person would, at a terminal, where building one is allowed.
  cli(['brief', 'fix the keep helper in src/keep.mjs', '--root', root]);
  return root;
}

test('a delivery injects the packet into the prompt, in the harness dialect', async () => {
  const root = await served();
  for (const id of ['claude', 'codex']) {
    const result = DELIVER(id, prompt[id]('fix the keep helper in src/keep.mjs', root));
    assert.equal(result.code, 0, result.text);
    const json = JSON.parse(result.stdout);
    assert.equal(json.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    const text = json.hookSpecificOutput.additionalContext;
    assert.ok(text.startsWith('TASK\n'), text.slice(0, 120));
    assert.ok(text.includes('src/keep.mjs'), text);
    assert.ok(Buffer.byteLength(text) <= 2048, `the packet was ${Buffer.byteLength(text)} bytes`);
    // A prompt is never blocked by this path: the exit code belongs to the delivery, not
    // to a decision, and it stays 0 even where a tool hook would answer with a denial.
    assert.notEqual(result.code, adapter(id).denyExit, `${id} exited with a denial code`);
  }
});

test('a repository that has not opted in is delivered nothing, and the note says why', async () => {
  const root = await repo({ [MANIFEST_FILE]: `${JSON.stringify({ id: 'fixture' }, null, 2)}\n` });
  const result = DELIVER('claude', prompt.claude('fix the keep helper', root));
  assert.equal(result.code, 0, result.text);
  assert.equal(result.stdout, '', 'a packet was delivered to a repository that never asked for one');
  assert.match(result.stderr, /no packet delivered/);
  assert.match(result.stderr, /brief/);
});

test('a payload with no prompt in it delivers nothing rather than guessing', async () => {
  const root = await served();
  const bare = JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: root });
  const result = DELIVER('claude', bare);
  assert.equal(result.code, 0, result.text);
  assert.equal(result.stdout, '', 'a payload we could not read still produced a packet');
  assert.match(result.stderr, /no packet delivered/);
});

test('a delivery never builds the index it reads', async () => {
  // The plan's bar is a latency, and the one way this path could miss it is by walking the
  // repository to build what it is about to read. So the cold case is asserted directly:
  // nothing delivered, and no index left behind for having tried.
  const root = await repo({
    [MANIFEST_FILE]: `${JSON.stringify({ id: 'fixture', brief: {} }, null, 2)}\n`,
    'src/keep.mjs': 'export const keep = 1;\n',
  });
  await git(['init', '-q', root]);
  const result = DELIVER('claude', prompt.claude('fix src/keep.mjs', root));
  assert.equal(result.code, 0, result.text);
  assert.equal(result.stdout, '', 'a cold index delivered a packet, or waited on a walk to build one');
  assert.match(result.stderr, /index is empty/);
  await assert.rejects(access(join(root, SQLITE_FILE)), 'the delivery built an index');
});

test('install writes the prompt group only into a repository that opted in', async () => {
  const asked = await served({ brief: {} }, { warm: false });
  cli(['agent-hooks', 'install', '--root', asked, '--yes']);
  const claude = JSON.parse(await readFile(join(asked, hookPath('claude')), 'utf8'));
  const entry = claude.hooks.UserPromptSubmit;
  assert.ok(Array.isArray(entry) && entry.length === 1, JSON.stringify(claude.hooks));
  assert.equal(entry[0].hooks[0].command, `${AGENT_HOOK_SHIM} ${EVENTS[1]} --harness claude`);
  assert.equal(entry[0].matcher, undefined, 'a prompt event takes no matcher, and the vendors ignore one');
  assert.ok(Array.isArray(claude.hooks.PreToolUse), 'the prompt group displaced the tool hook in the same file');
  // A second install changes nothing at all, the prompt group included.
  const again = cli(['agent-hooks', 'install', '--root', asked, '--yes']);
  assert.equal(again.text.match(/UNCHANGED/g)?.length, adapters().length + 1, again.text);

  const quiet = await repo({ [MANIFEST_FILE]: `${JSON.stringify({ id: 'fixture' }, null, 2)}\n` });
  const result = cli(['agent-hooks', 'install', '--root', quiet, '--yes']);
  assert.match(result.text, /PROMPT\s+not opted in/);
  const refused = JSON.parse(await readFile(join(quiet, hookPath('claude')), 'utf8'));
  assert.equal(refused.hooks.UserPromptSubmit, undefined, 'the delivery was installed without an opt-in');
});

test('install migrates a pre-shim entry instead of stacking a second one', async () => {
  // `ours()` still recognises the bare-binary spelling install wrote before the shim,
  // so the upgrade replaces that entry rather than appending beside it.
  const root = await repo({
    '.claude/settings.json': `${JSON.stringify(
      { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'simt agent-hook pretooluse --harness claude' }] }] } },
      null,
      2,
    )}\n`,
  });
  const install = cli(['agent-hooks', 'install', '--root', root, '--yes']);
  assert.equal(install.code, 0, install.text);
  assert.match(install.text, /UPDATED\s+claude/);
  const claude = JSON.parse(await readFile(join(root, hookPath('claude')), 'utf8'));
  assert.equal(claude.hooks.PreToolUse.length, 1, 'the old entry survived beside the new one');
  assert.equal(claude.hooks.PreToolUse[0].hooks[0].command, hookCommand('claude'));
  assert.equal(await readFile(join(root, AGENT_HOOK_SHIM), 'utf8'), renderAgentHookShim({ npm: false }));
});

test('undo removes the shim with the configs it arrived with', async () => {
  const root = await repo();
  const install = cli(['agent-hooks', 'install', '--root', root, '--yes']);
  assert.equal(install.code, 0, install.text);
  assert.ok((await readFile(join(root, AGENT_HOOK_SHIM), 'utf8')).includes('run_simt_dev'));
  const undone = cli(['undo', '--root', root, '--yes']);
  assert.equal(undone.code, 0, undone.text);
  assert.equal(await readFile(join(root, AGENT_HOOK_SHIM), 'utf8').catch((e) => e.code), 'ENOENT', 'undo left the shim behind');
  assert.equal(
    await readFile(join(root, hookPath('claude')), 'utf8').catch((e) => e.code),
    'ENOENT',
    'undo left a config behind',
  );
});

test('status reports the prompt subscription beside the tool hook', async () => {
  const root = await served({ brief: {} }, { warm: false });
  cli(['agent-hooks', 'install', '--root', root, '--yes']);
  const json = cli(['agent-hooks', 'status', '--root', root, '--json']);
  const payload = JSON.parse(json.stdout);
  const byId = Object.fromEntries(payload.harnesses.map((row) => [row.id, row]));
  assert.equal(byId.claude.prompt, 'present');
  assert.equal(byId.codex.prompt, 'present');
  // Not "absent": these two have no prompt event that can inject, and a subscription that
  // cannot be honoured is not one that is merely switched off.
  assert.equal(byId.cursor.prompt, null);
  assert.equal(byId.antigravity.prompt, null);
});

test('an edit outside the generated region is the author\'s own text (review 0003 Q17)', async () => {
  const root = await repo({ 'AGENTS.md': REGION_HTML, 'src/x.mjs': 'export const x = 1;\n' });
  const editOutside = (file, old_string) =>
    JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: file, old_string, new_string: 'changed' },
      cwd: root,
    });
  // Outside the markers: allowed. Inside them: denied. A Write that keeps the
  // region bytes is allowed; one that drops them is not.
  const outside = HOOK('claude', editOutside('AGENTS.md', '# Notes'));
  assert.equal(outside.code, 0, `an edit outside the region was denied: ${outside.text}`);
  assert.equal(outside.stdout, '');
  const inside = HOOK('claude', editOutside('AGENTS.md', '- a rule'));
  assert.equal(inside.code, 2, 'an edit inside the region was allowed');
  assert.match(inside.text, /ADR-036/);
  const missing = HOOK('claude', editOutside('AGENTS.md', 'no such text anywhere'));
  assert.equal(missing.code, 0, 'an edit touching nothing was denied');
  const kept = `${REGION_HTML.replace('# Notes', '# Changed')}`;
  const writeKept = HOOK(
    'claude',
    JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: 'AGENTS.md', content: kept },
      cwd: root,
    }),
  );
  assert.equal(writeKept.code, 0, `a Write keeping the region was denied: ${writeKept.text}`);
  const writeDropped = HOOK(
    'claude',
    JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: 'AGENTS.md', content: '# Notes\n\nhand only\n' },
      cwd: root,
    }),
  );
  assert.equal(writeDropped.code, 2, 'a Write dropping the region was allowed');
  // A malformed region stays denied: its span is unknown, so no edit can prove
  // itself outside it.
  const broken = await repo({ 'AGENTS.md': '<!-- simt:begin -->\nno end\n' });
  const brokenEdit = HOOK(
    'claude',
    JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: 'AGENTS.md', old_string: 'no end', new_string: 'x' },
      cwd: broken,
    }),
  );
  assert.equal(brokenEdit.code, 2, 'an edit into a malformed region was allowed');
});

test('the delivery is reached through a dynamic import, so a tool call never loads it', async () => {
  // The structural test above forbids the repository-reading modules by name. The delivery
  // needs three of them, so it lives behind a door this test keeps to a `import()`: if it
  // is ever promoted to a static import, the tool-call path starts paying for a packet
  // nobody asked for, and the forbidden-name test would not notice.
  const source = await readFile(join(ROOT, 'src', 'commands', 'agenthook.mjs'), 'utf8');
  assert.match(source, /await import\('\.\.\/agenthooks\/prompt\.mjs'\)/);
  assert.equal(/^\s*import .*agenthooks\/prompt\.mjs/m.test(source), false, 'the delivery is on the tool-call path');
});

test('the opencode entry is a plugin file the tool owns whole, and install round-trips it', async () => {
  const root = await repo();
  const preview = cli(['agent-hooks', 'install', '--root', root]);
  assert.match(preview.text, /CREATED\s+opencode/, 'a fresh repository gets the plugin created');
  cli(['agent-hooks', 'install', '--root', root, '--yes']);
  const path = join(root, hookPath('opencode'));
  const text = await readFile(path, 'utf8');
  assert.ok(text.includes(AGENT_HOOK_SHIM), 'the plugin names the shim every other harness points at');
  // The file is loaded by OpenCode as a module, so it must be valid JS before it is trusted.
  const check = spawnSync(process.execPath, ['--check', path]);
  assert.equal(check.status, 0, `the generated plugin is not valid JS: ${check.stderr}`);

  // A hand edit is drift, and status names the repair rather than reporting presence.
  await writeFile(path, `${text}// mine\n`);
  const status = cli(['agent-hooks', 'status', '--root', root]);
  assert.match(status.text, /DRIFT\s+opencode/, status.text);
  assert.match(status.text, /install to restore/);

  // A second install restores the bytes and is a no-op once more.
  const again = cli(['agent-hooks', 'install', '--root', root, '--yes']);
  assert.match(again.text, /UPDATED\s+opencode/, again.text);
  assert.equal(await readFile(path, 'utf8'), text, 'install did not restore the file it generated');
  const settled = cli(['agent-hooks', 'status', '--root', root]);
  assert.match(settled.text, /PRESENT\s+opencode/, settled.text);
});

test('the opencode plugin carries the prompt hook only where the repository opted in', async () => {
  const quiet = await repo({ [MANIFEST_FILE]: `${JSON.stringify({ id: 'fixture' }, null, 2)}\n` });
  cli(['agent-hooks', 'install', '--root', quiet, '--yes']);
  const quietText = await readFile(join(quiet, hookPath('opencode')), 'utf8');
  assert.doesNotMatch(quietText, /session\.hook\('prompt'/, 'the delivery was installed without an opt-in');

  const asked = await served({ brief: {} }, { warm: false });
  cli(['agent-hooks', 'install', '--root', asked, '--yes']);
  const askedText = await readFile(join(asked, hookPath('opencode')), 'utf8');
  assert.match(askedText, /session\.hook\('prompt'/, 'the opted-in repository got the delivery');
});
