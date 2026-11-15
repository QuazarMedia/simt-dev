// Shared fixtures for the agenthooks suites: one repository builder, one CLI runner, and
// the payloads each harness documents. Extracted when the suite crossed the line ceiling;
// a second copy of these is a second idea of what a harness payload looks like.

import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { adapters } from '../src/agenthooks/render.mjs';
import { renderAgentHookShim } from '../src/agenthooks/shim.mjs';
import { EVENTS } from '../src/agenthooks/policy.mjs';
import { MANIFEST_FILE } from '../src/name.mjs';

/** The harness set a fixture declares (ADR-141): without it an install writes nothing. */
const HARNESSES = adapters().map((row) => row.id);
import { git, keepTemp } from './fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', 'bin', 'simt.mjs');

/** The shim an install writes in THIS checkout: it records the interpreter and entry point. */
const installedShim = (opts = {}) => renderAgentHookShim({ ...opts, fallback: { node: process.execPath, entry: BIN } });
const ROOT = join(HERE, '..');

/** A repository with a git directory, so `agent-hooks` has a root that is one. */
async function repo(files = {}) {
  const root = await mkdtemp(join(tmpdir(), 'simt-agent-'));
  keepTemp(root);
  for (const [name, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), text);
  }
  // A fixture that installs hooks declares the harness set unless the test wrote its own
  // manifest: saying nothing now means "no harness selected", not "all of them" (ADR-141).
  if (!(MANIFEST_FILE in files)) {
    await writeFile(join(root, MANIFEST_FILE), `${JSON.stringify({ id: 'fixture', surfaces: HARNESSES }, null, 2)}\n`);
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
  // Hermetic: a test asserting the push is blocked must not inherit an ambient
  // SIMT_ALLOW. The pre-push gate runs the suite with SIMT_ALLOW=push set for the
  // outer push, and that var would lift the policy inside the spawned hook. Strip it
  // from the inherited env; a test that wants the policy lifted passes
  // env: { SIMT_ALLOW: ... } and it is re-added below.
  const inherited = { ...process.env };
  delete inherited.SIMT_ALLOW;
  const result = spawnSync(process.execPath, [BIN, ...args], {
    input,
    env: { ...inherited, ...env },
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

export { HARNESSES, HERE, BIN, installedShim, ROOT, repo, cli, shell, write, REGION_HTML, REGION_HASH, HOOK, git };
