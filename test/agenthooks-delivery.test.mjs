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
import { existsSync } from 'node:fs';
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

import { HARNESSES, BIN, HOOK, REGION_HASH, REGION_HTML, ROOT, cli, git, installedShim, repo, shell, write } from './agenthooks-fixture.mjs';
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
    [MANIFEST_FILE]: `${JSON.stringify({ id: 'fixture', surfaces: HARNESSES, ...optIn }, null, 2)}\n`,
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
  const root = await repo({ [MANIFEST_FILE]: `${JSON.stringify({ id: 'fixture', surfaces: HARNESSES }, null, 2)}\n` });
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
    [MANIFEST_FILE]: `${JSON.stringify({ id: 'fixture', surfaces: HARNESSES, brief: {} }, null, 2)}\n`,
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

  const quiet = await repo({ [MANIFEST_FILE]: `${JSON.stringify({ id: 'fixture', surfaces: HARNESSES }, null, 2)}\n` });
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
  assert.equal(await readFile(join(root, AGENT_HOOK_SHIM), 'utf8'), installedShim({ npm: false }));
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
  const quiet = await repo({ [MANIFEST_FILE]: `${JSON.stringify({ id: 'fixture', surfaces: HARNESSES }, null, 2)}\n` });
  cli(['agent-hooks', 'install', '--root', quiet, '--yes']);
  const quietText = await readFile(join(quiet, hookPath('opencode')), 'utf8');
  assert.doesNotMatch(quietText, /session\.hook\('prompt'/, 'the delivery was installed without an opt-in');

  const asked = await served({ brief: {} }, { warm: false });
  cli(['agent-hooks', 'install', '--root', asked, '--yes']);
  const askedText = await readFile(join(asked, hookPath('opencode')), 'utf8');
  assert.match(askedText, /session\.hook\('prompt'/, 'the opted-in repository got the delivery');
});

test('an empty surfaces list installs nothing and names both remedies', async () => {
  const root = await repo({ [MANIFEST_FILE]: `${JSON.stringify({ id: 'fixture', surfaces: [] }, null, 2)}\n` });
  const preview = cli(['agent-hooks', 'install', '--root', root]);
  assert.equal(preview.code, 0, preview.text);
  assert.match(preview.text, /SKIP\s+no harness is selected/);
  assert.match(preview.text, /add "surfaces"/);
  assert.match(preview.text, /--harness <id>/);
  assert.equal(existsSync(join(root, hookPath('claude'))), false, 'an empty scope still wrote a config');

  const status = cli(['agent-hooks', 'status', '--root', root]);
  assert.equal(status.code, 0, status.text);
  assert.match(status.text, /NO SCOPE/);

  // The flag is the other way to select one, and it needs no declaration.
  const forced = cli(['agent-hooks', 'install', '--root', root, '--harness', 'claude', '--yes']);
  assert.equal(forced.code, 0, forced.text);
  assert.equal(existsSync(join(root, hookPath('claude'))), true);
});
