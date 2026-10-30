// The one agent this tool ships (ADR-111): a single body rendered into the file each
// harness documents, installed per harness and with init.
//
// The whole difficulty of this surface is that the six vendors agree on nothing - not
// the directory, not the extension, not the frontmatter keys, not the document shape.
// Five write a markdown file with a frontmatter and a body that becomes the system
// prompt; Codex writes a TOML file whose `developer_instructions` holds the same body.
// So the tests render every form from the one source body and assert the differences
// are exactly the ones the reader table documents, and nothing else.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { adapter, adapters, agentPath, loadAgent, rendered } from '../src/agents/render.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', 'bin', 'simt.mjs');

const made = [];
test.after(async () => {
  const { rm } = await import('node:fs/promises');
  for (const dir of made) await rm(dir, { recursive: true, force: true });
});

/** A scratch directory to install into. `agents install` reads and writes files and
 *  does not run git, so a bare directory is the whole of the fixture. */
async function repo(files = {}) {
  const root = await mkdtemp(join(tmpdir(), 'simt-agents-'));
  made.push(root);
  for (const [name, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), text);
  }
  return root;
}

/** Run the shipped binary. Both streams are returned: the report goes to stdout and
 *  the notes to stderr, and a test that read only one would miss half of what it says. */
function cli(args, { env = {} } = {}) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { code: result.status ?? 1, stdout, stderr, text: `${stdout}${stderr}` };
}

test('the one body encodes both planning and building through simt-dev', async () => {
  const agent = await loadAgent();
  assert.equal(agent.name, 'Simt-Agent');
  // Orient, plan, build: the three verbs the body exists to carry.
  assert.match(agent.body, /simt brief/);
  assert.match(agent.body, /simt why/);
  assert.match(agent.body, /simt plan status/);
  assert.match(agent.body, /simt plan next/);
  assert.match(agent.body, /simt slice start/);
  assert.match(agent.body, /simt slice finish/);
  assert.match(agent.body, /simt plan done/);
});

test('each harness renders the file it documents, from the one body', async () => {
  const agent = await loadAgent();
  const head = agent.body.slice(0, 40);
  for (const row of adapters()) {
    const { text } = rendered(row, agent, null);
    assert.ok(text.includes(head), `${row.id} does not carry the shared body`);
    if (row.format === 'toml') {
      assert.match(text, /^name = "Simt-Agent"\n/, 'codex names the agent');
      assert.match(text, /^description = "/m, 'codex carries a description');
      assert.match(text, /developer_instructions = """/, 'codex holds the body in developer_instructions');
    } else {
      assert.match(text, /^---\n/, 'the markdown form opens with a frontmatter');
      assert.match(text, /\n---\n\n/, 'the frontmatter is closed before the body');
    }
  }

  // The frontmatter differs by harness, and the difference is exactly the documented
  // one: opencode documents no `name` key, the rest document `name` and `description`.
  const opencode = rendered(adapters().find((a) => a.id === 'opencode'), agent, null).text;
  assert.match(opencode, /^---\ndescription: /);
  assert.doesNotMatch(opencode, /^name:/m, 'opencode documents no name key');
  for (const id of ['claude', 'cursor', 'gemini', 'antigravity']) {
    const text = rendered(adapters().find((a) => a.id === id), agent, null).text;
    assert.match(text, /^---\nname: Simt-Agent\ndescription: /, `${id} documents name and description`);
  }
});

test('install writes one file per harness that documents an agents directory', async () => {
  const root = await repo();
  const preview = cli(['agents', 'install', '--root', root]);
  assert.equal(preview.code, 0, preview.text);
  assert.match(preview.text, /PLAN     nothing written/);
  assert.equal(await readFile(join(root, agentPath('claude')), 'utf8').catch(() => null), null, 'a preview wrote a file');

  const install = cli(['agents', 'install', '--root', root, '--yes']);
  assert.equal(install.code, 0, install.text);
  assert.match(install.text, /WROTE    6 agent file\(s\)/);
  for (const row of adapters()) {
    const text = await readFile(join(root, agentPath(row.id)), 'utf8');
    assert.ok(text.length > 0, `${row.id} was not written`);
  }

  // A second install is a no-op, which is what makes it safe to run from a script.
  const again = cli(['agents', 'install', '--root', root, '--yes']);
  assert.equal(again.code, 0, again.text);
  assert.equal(again.text.match(/UNCHANGED/g)?.length, adapters().length, again.text);
});

test('install reports the harnesses that document no agents file, rather than staying quiet', async () => {
  const root = await repo();
  const json = cli(['agents', 'install', '--root', root, '--yes', '--json']);
  const payload = JSON.parse(json.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.filesWritten, true);
  assert.equal(payload.written.length, adapters().length);
  const noFile = payload.notWritten.filter((n) => n.state === 'none').map((n) => n.id).sort();
  assert.deepEqual(noFile, ['copilot', 'deepseek'], 'the two harnesses that document no agents file are named');
  // The plan carries the file facts and not the rendered bytes.
  assert.deepEqual(Object.keys(payload.plan[0]).sort(), ['action', 'id', 'path']);
});

test('status reports absent, then present, then drift, and the readers with no file', async () => {
  const root = await repo();
  const fresh = cli(['agents', 'status', '--root', root]);
  assert.equal(fresh.code, 0, fresh.text);
  for (const row of adapters()) assert.match(fresh.text, new RegExp(`ABSENT\\s+${row.id}`));
  assert.match(fresh.text, /NO FILE\s+copilot/);
  assert.match(fresh.text, /NO FILE\s+deepseek/);

  cli(['agents', 'install', '--root', root, '--yes']);
  const installed = cli(['agents', 'status', '--root', root]);
  for (const row of adapters()) assert.match(installed.text, new RegExp(`PRESENT\\s+${row.id}`));

  // A byte the tool would not write is drift an install will rewrite.
  await writeFile(join(root, agentPath('claude')), (await readFile(join(root, agentPath('claude')), 'utf8')) + 'a stray line\n');
  const drifted = cli(['agents', 'status', '--root', root]);
  assert.match(drifted.text, /DRIFT\s+claude/);
  for (const row of adapters()) {
    if (row.id !== 'claude') assert.match(drifted.text, new RegExp(`PRESENT\\s+${row.id}`));
  }
});

test('install --harness writes one reader and names the ones it skipped', async () => {
  const root = await repo();
  const preview = cli(['agents', 'install', '--root', root, '--harness', 'codex']);
  assert.equal(preview.code, 0, preview.text);
  assert.match(preview.text, /PLAN     nothing written/);
  for (const row of adapters()) {
    if (row.id !== 'codex') assert.match(preview.text, new RegExp(`SKIPPED\\s+${row.id}`));
  }

  const install = cli(['agents', 'install', '--root', root, '--harness', 'codex', '--yes']);
  assert.equal(install.code, 0, install.text);
  assert.ok((await readFile(join(root, agentPath('codex')), 'utf8')).includes('developer_instructions'));
  for (const row of adapters()) {
    if (row.id === 'codex') continue;
    assert.equal(
      await readFile(join(root, agentPath(row.id)), 'utf8').catch(() => null),
      null,
      `${row.id} was written without being requested`,
    );
  }

  const json = cli(['agents', 'install', '--root', root, '--harness', 'codex', '--yes', '--json']);
  const payload = JSON.parse(json.stdout);
  const skipped = payload.notWritten.filter((n) => n.state === 'skipped').map((n) => n.id).sort();
  assert.deepEqual(skipped, adapters().filter((r) => r.id !== 'codex').map((r) => r.id).sort());
});

test('install --harness with an unknown id is a usage error that names the ids', async () => {
  const root = await repo();
  const result = cli(['agents', 'install', '--root', root, '--harness', 'windsurf']);
  assert.equal(result.code, 2);
  assert.match(result.text, /unknown harness `windsurf`/);
  for (const row of adapters()) assert.ok(result.text.includes(row.id), `the remedy does not name ${row.id}`);
});

test('a harness with no renderer is reported, not written', async () => {
  // The reader table documents eight harnesses and this tool renders six. The two it
  // does not write are named in the status, the way ADR-079 ruling 11 requires.
  const root = await repo();
  const status = cli(['agents', 'status', '--root', root]);
  for (const id of ['copilot', 'deepseek']) {
    assert.equal(adapter(id), null, `${id} has no renderer`);
    assert.match(status.text, new RegExp(`NO FILE\\s+${id}`));
  }
});
