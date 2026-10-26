// Package generation (plan 0003 R43): three harness packages from one set of tables,
// each self-contained enough to install into a clean profile and pass the R15 fixture
// payloads against its own copy of the runtime.
//
// The acceptance criterion is "installs into a clean profile and passes R15's fixture
// tests", so the load-bearing assertion is not that a file was written but that the COPIED
// runtime — the one that lives inside the package, with nothing on PATH to fall back on —
// answers each harness's payload in that harness's dialect. A package whose config points
// at a runtime that dies on the first call would install cleanly and enforce nothing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', 'bin', 'simt.mjs');
const ROOT = join(HERE, '..');

const made = [];
test.after(async () => {
  for (const dir of made) await rm(dir, { recursive: true, force: true });
});

/** A throwaway directory, tracked for cleanup. */
async function temp(name) {
  const dir = await mkdtemp(join(tmpdir(), name));
  made.push(dir);
  return dir;
}

/** Build one package with the shipped binary, returning the spawn result. */
function build(kind, out, { yes = true } = {}) {
  const args = ['plugin', kind, '--out', out];
  if (yes) args.push('--yes');
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', cwd: ROOT });
}

/** The copied runtime's bin path for a kind, relative to the package root. */
function copiedBin(out, kind) {
  return join(out, kind === 'cursor' ? join('.cursor', 'simt') : '.', 'bin', 'simt.mjs');
}

/**
 * Run a copied runtime's agent-hook with a payload on stdin, exactly as the package's
 * generated command would: claude and cursor pass --root (their vendors set a project-dir
 * env var), gemini does not (its base input carries cwd instead).
 */
function hook(out, kind, payload, project) {
  const args = ['agent-hook', 'pre-tool-use', '--harness', kind];
  if (kind !== 'gemini') args.push('--root', project);
  const result = spawnSync(process.execPath, [copiedBin(out, kind), ...args], {
    input: payload,
    encoding: 'utf8',
  });
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** Feed lines to a copied runtime's `mcp` and collect the session. */
function converse(bin, raw) {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [bin, 'mcp']);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', rej);
    child.on('close', () => res({ stdout, stderr }));
    child.stdin.end(raw);
  });
}

/** A directory's files as a relpath → bytes map, for byte-identical comparisons. */
async function tree(dir) {
  const out = {};
  async function walk(d, rel) {
    for (const name of (await readdir(d)).sort()) {
      const abs = join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      if ((await stat(abs)).isDirectory()) await walk(abs, r);
      else out[r] = await readFile(abs);
    }
  }
  await walk(dir, '');
  return out;
}

test('each package, run from its own copied runtime, blocks a push in its own dialect', async () => {
  const project = await temp('simt-pkgproj-');

  const claude = await temp('simt-pkgc-');
  assert.equal(build('claude', claude).status, 0);
  const c = hook(claude, 'claude', JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push origin main' }, cwd: project }), project);
  assert.equal(c.code, 2, 'claude blocks with exit 2');
  assert.equal(JSON.parse(c.stdout).hookSpecificOutput.permissionDecision, 'deny');

  const cursor = await temp('simt-pkgu-');
  assert.equal(build('cursor', cursor).status, 0);
  const u = hook(cursor, 'cursor', JSON.stringify({ tool_name: 'Shell', tool_input: { command: 'git push origin main' }, working_directory: project }), project);
  assert.equal(u.code, 2, 'cursor blocks with exit 2');
  assert.equal(JSON.parse(u.stdout).permission, 'deny');

  const gemini = await temp('simt-pkgg-');
  assert.equal(build('gemini', gemini).status, 0);
  const g = hook(gemini, 'gemini', JSON.stringify({ tool_name: 'run_shell_command', tool_input: { command: 'git push origin main' }, cwd: project }), project);
  // Gemini's vendor documents the decision JSON, not a block exit code, so it exits 0.
  assert.equal(g.code, 0, 'gemini answers with the decision document, exit 0');
  assert.equal(JSON.parse(g.stdout).decision, 'deny');

  // An ordinary command is silent on every dialect: no decision document, exit 0.
  for (const [kind, out, payload] of [
    ['claude', claude, { tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: project }],
    ['cursor', cursor, { tool_name: 'Shell', tool_input: { command: 'ls' }, working_directory: project }],
    ['gemini', gemini, { tool_name: 'run_shell_command', tool_input: { command: 'ls' }, cwd: project }],
  ]) {
    const r = hook(out, kind, JSON.stringify(payload), project);
    assert.equal(r.code, 0, `${kind}: ordinary command exits 0`);
    assert.equal(r.stdout, '', `${kind}: ordinary command is silent on stdout`);
  }
});

test('the copied runtime serves the MCP surface, so the package registration points at a live server', async () => {
  const claude = await temp('simt-pkgmcp-');
  assert.equal(build('claude', claude).status, 0);
  const { stdout, stderr } = await converse(copiedBin(claude, 'claude'), [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  ].join('\n') + '\n');
  assert.equal(stderr, '', 'the protocol channel carries no diagnostics');
  const messages = stdout.trim() === '' ? [] : stdout.trim().split('\n').map((l) => JSON.parse(l));
  const list = messages.find((m) => m.id === 2);
  assert.ok(list, 'tools/list answered');
  assert.ok(list.result.tools.length > 0, 'the copied runtime lists its tools');
});

test('two builds of the same kind are byte-identical', async () => {
  const a = await temp('simt-pkga-');
  const b = await temp('simt-pkgb-');
  // Same basename in each: the gemini manifest takes its name from the directory, so a
  // determinism check that used two names would compare two different manifests.
  const pa = join(a, 'pkg');
  const pb = join(b, 'pkg');
  assert.equal(build('gemini', pa).status, 0);
  assert.equal(build('gemini', pb).status, 0);
  assert.deepEqual(await tree(pa), await tree(pb), 'two gemini builds differ');
});

test('a dry run writes nothing; --yes writes the generated files', async () => {
  const dry = await temp('simt-pkgdry-');
  const dryOut = join(dry, 'pkg');
  assert.equal(build('claude', dryOut, { yes: false }).status, 0);
  assert.deepEqual(await tree(dry).then((t) => Object.keys(t)), [], 'a dry run writes no files');

  const wet = await temp('simt-pkgwet-');
  const wetOut = join(wet, 'pkg');
  assert.equal(build('claude', wetOut).status, 0);
  const written = Object.keys(await tree(wetOut));
  assert.ok(written.includes(join('.claude-plugin', 'plugin.json')), 'the manifest was written');
  assert.ok(written.includes(join('hooks', 'hooks.json')), 'the hooks document was written');
  assert.ok(written.includes('package.json'), 'the runtime was copied');
});

test('an unknown kind is a usage failure that names the valid kinds', () => {
  const result = build('foo', join(tmpdir(), 'simt-pkgnever-'));
  assert.equal(result.status, 2);
  for (const kind of ['claude', 'gemini', 'cursor']) {
    assert.ok(result.stderr.includes(kind), `the remedy names \`${kind}\``);
  }
});

test('the gemini hooks document carries a millisecond timeout, not the seconds every other row uses', async () => {
  const gemini = await temp('simt-pkgms-');
  assert.equal(build('gemini', gemini).status, 0);
  const doc = JSON.parse(await readFile(join(gemini, 'hooks', 'hooks.json'), 'utf8'));
  const entry = doc.hooks.BeforeTool[0].hooks[0];
  assert.equal(entry.timeout, 10000, 'gemini timeout is milliseconds');
});
