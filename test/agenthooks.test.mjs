// Agent-time hooks (plan 0003 R15): one policy table, four dialects, and the same
// decision whichever harness asks.
//
// Every harness case feeds the payload that harness documents, because the whole
// difficulty of this surface is that the four vendors agree on nothing - not the config
// path, not the event name, not the field the command arrives in, not the field a
// denial comes back in. A fixture written from our own idea of the shape would pass here
// and fail on the first real tool call.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decide, overrides } from '../src/agenthooks/decide.mjs';
import { adapter, adapters, hookCommand, hookPath, hookRows } from '../src/agenthooks/render.mjs';
import { EVENTS, POLICY_IDS } from '../src/agenthooks/policy.mjs';
import { CLI } from '../src/name.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', 'bin', 'simt-dev.mjs');
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
  assert.equal(await readFile(join(root, '.codex', 'hooks.json'), 'utf8').catch(() => null), null, 'a preview wrote a file');

  const install = cli(['agent-hooks', 'install', '--root', root, '--yes']);
  assert.equal(install.code, 0);

  const claude = JSON.parse(await readFile(join(root, '.claude', 'settings.json'), 'utf8'));
  assert.equal(claude.model, 'opus', 'install dropped a key the harness owns');
  assert.equal(claude.hooks.PreToolUse.length, 2, 'install replaced an entry the harness owns');
  assert.equal(claude.hooks.PreToolUse[0].hooks[0].command, 'echo hi', 'install rewrote an entry the harness owns');
  assert.equal(claude.hooks.PreToolUse[1].hooks[0].command, hookCommand('claude'));

  for (const row of adapters()) {
    const config = JSON.parse(await readFile(join(root, hookPath(row.id)), 'utf8'));
    assert.ok(JSON.stringify(config).includes(hookCommand(row.id)), `${row.id} has no hook running this tool`);
  }

  // A second install is a no-op, which is what makes it safe to run from a script.
  const again = cli(['agent-hooks', 'install', '--root', root, '--yes']);
  assert.equal(again.code, 0);
  assert.equal(again.text.match(/UNCHANGED/g)?.length, adapters().length, again.text);
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
  assert.deepEqual(
    payload.notWritten.map((n) => n.id).sort(),
    hookRows().filter((r) => adapter(r.id) === null).map((r) => r.id).sort(),
  );
  assert.ok(payload.notWritten.some((n) => n.id === 'opencode'), 'opencode loads hooks as plugins, and that is a fact worth printing');
});

test('the command in the config is the command the reader types', async () => {
  for (const row of adapters()) {
    const command = hookCommand(row.id);
    assert.match(command, new RegExp(`^${CLI} agent-hook ${EVENTS[0]} --harness ${row.id}$`));
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
  const bin = await readFile(join(ROOT, 'bin', 'simt-dev.mjs'), 'utf8');
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
