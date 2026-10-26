// `simt harness detect` - which harnesses a repository is set up for.
//
// The claim under test is narrow and deliberate: a directory that exists implies a
// harness is in use, and nothing more. The command does not claim what that harness
// reads, because the tool cannot answer that without a vendor document - and a guess
// here would be the reader's problem the first time it was wrong.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { promisify } from 'node:util';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, '..', 'bin', 'simt.mjs');
const exec = promisify(execFile);
const made = [];

after(async () => {
  for (const dir of made) await rm(dir, { recursive: true, force: true });
});

async function scratch(prefix = 'simt-harness-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

async function run(args) {
  try {
    const { stdout, stderr } = await exec('node', [BIN, ...args], { maxBuffer: 16 << 20 });
    return { code: 0, out: stdout + stderr };
  } catch (error) {
    return { code: error.code, out: (error.stdout ?? '') + (error.stderr ?? '') };
  }
}

/** A repository with the given configuration directories present. */
async function repoWith(...dirs) {
  const root = await scratch();
  for (const d of dirs) await mkdir(join(root, d), { recursive: true });
  return root;
}

test('a directory with a channel and one without are reported as different facts', async () => {
  const root = await repoWith('.cursor', '.gemini');
  const out = await run(['harness', 'detect', '--root', root, '--json']);
  assert.equal(out.code, 0, out.out);
  const { repo } = JSON.parse(out.out);

  const rows = Object.fromEntries(repo.rows.map((r) => [r.dir, r]));
  // `.cursor` is a surface in this release, and it projects a rule file.
  assert.equal(rows['.cursor'].surface, 'cursor');
  assert.equal(rows['.cursor'].channel, true);
  // `.gemini` is present and this release has no rule row for it. It is reported as
  // present with no channel, never as "supported" and never as an error. R42 read the
  // vendor docs, so unlike the bare candidates its row now carries provenance - which
  // is exactly the graduation path for a candidate: facts move in only with a source.
  assert.equal(rows['.gemini'].surface, null);
  assert.equal(rows['.gemini'].channel, false);
  assert.equal(rows['.gemini'].kind, 'rules');
  // A channel row carries the document it was verified against, so a reader can check
  // the claim instead of trusting it. The candidate's detection facts carry one too.
  assert.ok(rows['.cursor'].verified, 'a channel with no provenance is the defect this file exists for');
  assert.match(rows['.gemini'].verified, /geminicli\.com.*read 2026-/);
});

test('the text says the same as the json', async () => {
  // `.windsurf` is in for the note: `.gemini` graduated to verified facts, so a fixture
  // of only verified channels would have nothing unclaimed to say the note about.
  const root = await repoWith('.claude', '.cursor', '.gemini', '.windsurf');
  const text = await run(['harness', 'detect', '--root', root]);
  const json = JSON.parse((await run(['harness', 'detect', '--root', root, '--json'])).out);

  assert.equal(text.code, 0);
  for (const row of json.repo.rows) {
    assert.match(text.out, new RegExp(row.dir.replace('.', '\\.')), `${row.dir} is missing from the text output`);
  }
  // The one claim the text makes that a number alone cannot: presence is not coverage.
  assert.match(text.out, /not as unsupported/);
  assert.match(text.out, /\(reads AGENTS\.md\)|some readers read AGENTS\.md/);
  // "some" says which, when the row knows - the detail that decides whether the
  // repository's AGENTS.md actually reaches the reader.
  assert.match(text.out, /some readers read AGENTS\.md: AGENTS\.md is loaded only when/);
});

test('a .dsh directory is the DeepSeek harness, covered by AGENTS.md', async () => {
  const root = await repoWith('.dsh');
  const out = await run(['harness', 'detect', '--root', root, '--json']);
  assert.equal(out.code, 0, out.out);
  const row = JSON.parse(out.out).repo.rows.find((r) => r.dir === '.dsh');
  assert.ok(row, 'a .dsh directory is the harness home shape');
  assert.equal(row.surface, null, 'there is no per-rule file to project');
  assert.equal(row.channel, false);
  assert.equal(row.readsAgentsMd, 'all');
  assert.match(row.verified, /read 2026-10-14/);

  const text = await run(['harness', 'detect', '--root', root]);
  assert.match(text.out, /\.dsh\s+DeepSeek harness\s+AGENTS\.md/);
  assert.doesNotMatch(text.out, /no rule channel in this release/);
});

test('harness detect reports the MCP registration files the loader table names', async () => {
  // R42. Every path here comes from loaders.mjs - the command reads the table rather
  // than carrying a second list, because two lists of vendor paths would drift apart
  // exactly when a harness renames its config. The stat alone is the evidence: a file
  // existing proves setup a bare directory cannot, since .codex also holds things that
  // are not server registrations.
  const root = await scratch();
  for (const [file, body] of [
    ['.mcp.json', '{}'],
    ['.codex/config.toml', '[mcp_servers.x]\ncommand = "x"\n'],
    ['.cursor/mcp.json', '{}'],
    ['.agents/mcp_config.json', '{}'],
    ['.vscode/mcp.json', '{}'],
    ['.gemini/settings.json', '{}'],
  ]) {
    await mkdir(join(root, dirname(file)), { recursive: true });
    await writeFile(join(root, file), body);
  }
  const out = await run(['harness', 'detect', '--root', root, '--json']);
  assert.equal(out.code, 0, out.out);
  const mcpRows = JSON.parse(out.out).repo.rows.filter((r) => r.kind === 'mcp');
  const byFile = Object.fromEntries(mcpRows.map((r) => [r.dir, r]));
  assert.deepEqual(
    mcpRows.map((r) => r.dir).sort(),
    ['.agents/mcp_config.json', '.codex/config.toml', '.cursor/mcp.json', '.gemini/settings.json', '.mcp.json', '.vscode/mcp.json'],
  );
  for (const row of mcpRows) {
    assert.ok(row.surface, 'an MCP row names the loader it belongs to');
    assert.equal(row.channel, false, 'a config file is evidence, not a rule channel');
    assert.match(row.verified, /read 2026-/, 'detection evidence carries the same provenance rule as everything else');
  }
  assert.equal(byFile['.mcp.json'].label, 'Claude Code');
  assert.equal(byFile['.gemini/settings.json'].label, 'Gemini CLI');

  const text = await run(['harness', 'detect', '--root', root]);
  assert.match(text.out, /\.mcp\.json\s+Claude Code\s+MCP config present/);
  assert.match(text.out, /\.gemini\/settings\.json\s+Gemini CLI\s+MCP config present/);
});

test('an absent MCP file is silent, even when its directory is present', async () => {
  // A directory proves a reader may be configured; a registration says it was. One
  // does not stand in for the other, or a .codex full of prompts would report servers
  // it has never had - and a bare .codex has never carried a rules row either, because
  // Codex's only project file is the one the loader table names.
  const root = await repoWith('.codex');
  const out = await run(['harness', 'detect', '--root', root, '--json']);
  assert.equal(out.code, 0, out.out);
  const rows = JSON.parse(out.out).repo.rows;
  assert.ok(!rows.some((r) => r.kind === 'mcp'));

  // With the config file the loader table names, the same repository gains its first
  // evidence row - the file is the fact the directory could never be.
  await writeFile(join(root, '.codex', 'config.toml'), '[mcp_servers.x]\ncommand = "x"\n');
  const out2 = await run(['harness', 'detect', '--root', root, '--json']);
  assert.equal(out2.code, 0, out2.out);
  assert.ok(JSON.parse(out2.out).repo.rows.some((r) => r.kind === 'mcp' && r.dir === '.codex/config.toml'));

  // And an MCP row must not inflate the unclaimed note: an MCP config never claimed a
  // rule channel, so its presence is not a rule gap.
  const withMcp = await scratch();
  await mkdir(join(withMcp, '.windsurf'));
  await writeFile(join(withMcp, '.mcp.json'), '{}');
  const text = await run(['harness', 'detect', '--root', withMcp]);
  assert.match(text.out, /1 present configuration has/);
});

test('a directory named like the MCP file is not evidence', async () => {
  const root = await repoWith('.mcp.json', '.gemini');
  const out = await run(['harness', 'detect', '--root', root, '--json']);
  assert.equal(out.code, 0, out.out);
  const rows = JSON.parse(out.out).repo.rows;
  assert.ok(!rows.some((r) => r.kind === 'mcp'), 'isFile() is what the row rests on');
});

test('a repository with no harness configuration is an answer, not a failure', async () => {
  // A reader running this on a fresh repository must get "none found" and a zero exit.
  // A non-zero exit here would be read as "your repo is wrong", which is the one thing
  // a directory scan can never establish.
  const root = await repoWith();
  const out = await run(['harness', 'detect', '--root', root]);
  assert.equal(out.code, 0, out.out);
  assert.match(out.out, /no harness configuration/i);
  assert.equal(JSON.parse((await run(['harness', 'detect', '--root', root, '--json'])).out).repo.rows.length, 0);
});

test('--user adds the home block, and only when asked', async () => {
  const root = await repoWith('.cursor');
  const withoutKey = JSON.parse((await run(['harness', 'detect', '--root', root, '--json'])).out);
  assert.ok(!('user' in withoutKey), 'home is the reader\'s, not the repository\'s; it is opt-in');

  const withKey = JSON.parse((await run(['harness', 'detect', '--root', root, '--user', '--json'])).out);
  assert.ok('user' in withKey);
  // The contents of the real home are the machine's, not the fixture's, so only the
  // shape is asserted. What the scan found there is whatever the developer installed.
  assert.ok(Array.isArray(withKey.user.rows));
});

test('a subcommand that does not exist is a usage failure, not a default', async () => {
  const root = await repoWith('.cursor');
  const out = await run(['harness', 'nonsense', '--root', root]);
  assert.notEqual(out.code, 0);
  assert.equal(out.code, 2);
});
