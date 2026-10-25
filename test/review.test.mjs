// The local critic (plan 0003 R39, ADR-008, ADR-090, ADR-075).
//
// Verifies:
//   1. The deterministic brief: the staged diff plus everything that governs it
//      (R25), gathered with no model and no socket; the brief alone is what
//      `simt review` answers, and only --local asks for a verdict.
//   2. `simt review --local` proposes from the configured chat model, verifies
//      the ADR-008 vocabulary and every cited id against the brief, and writes
//      the reply where model output may land — a proposal under
//      `.simt/reviews/`, cached by digest, never a source file. A fabricated
//      citation, a non-vocabulary verdict, or an unfulfilled residual-risk duty
//      marks the proposal `verified: false` instead of trusting it.
//   3. `simt bench critic` reads a labelled set a human wrote for it, runs the
//      critic over the labelled historical diffs, and reports the confusion
//      counts with precision and recall — or names the missing input instead of
//      inferring the metric.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import net from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  DEFAULT_BUDGET,
  VERDICTS,
  buildReviewPrompt,
  parseVerdictReply,
  parseVerdictValue,
  reviewTarget,
  verdictBinary,
} from '../src/review/critic.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, '..', 'bin', 'simt.mjs');
const exec = promisify(execFile);
const GIT = { EMAIL: 't@example.com', NAME: 'T' };

process.env.SIMT_DEV_WORKSPACE = 'off';
process.env.NO_COLOR = '1';

async function runCli(args, env = {}) {
  try {
    const { stdout, stderr } = await exec('node', [BIN, ...args], {
      maxBuffer: 16 << 20,
      env: { ...process.env, NO_COLOR: '1', SIMT_DEV_WORKSPACE: 'off', ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

async function withRoot(run) {
  const dir = await mkdtemp(join(tmpdir(), 'simt-review-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function gitDir(dir, args, env = {}) {
  return exec('git', ['-C', dir, ...args], {
    maxBuffer: 16 << 20,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: GIT.NAME,
      GIT_AUTHOR_EMAIL: GIT.EMAIL,
      GIT_COMMITTER_NAME: GIT.NAME,
      GIT_COMMITTER_EMAIL: GIT.EMAIL,
      ...env,
    },
  });
}

const ADR_FIXTURE = `# ADR-900 — Governance fixture

Status: accepted

## Context

A staged diff needs something to be governed by.

## Ruling

Affects: \`src/review.ts\`

The fixture decision names the file the critic diffs, so the brief must cite it.
`;

const RULE_FIXTURE = `---
simt-id: fixture-rule
simt-title: The fixture rule
simt-scope: ["src/review.ts"]
---

The fixture rule governs the file the critic diffs.
`;

const CHANGE = `export function review() {
  return true;
}
`;

/** A repo whose ADR-900 and rule both govern `src/review.ts`, committed at rest. */
async function fixtureRepo(dir) {
  await mkdir(join(dir, 'docs', 'decisions'), { recursive: true });
  await mkdir(join(dir, 'rules'), { recursive: true });
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'docs', 'decisions', 'ADR-900-governance-fixture.md'), ADR_FIXTURE);
  await writeFile(join(dir, 'rules', 'fixture-rule.md'), RULE_FIXTURE);
  await writeFile(join(dir, 'README.md'), '# scratch\n');
  await writeFile(join(dir, 'src', 'review.ts'), '');
  await gitDir(dir, ['init', '-q', '-b', 'main']);
  await gitDir(dir, ['config', 'user.email', GIT.EMAIL]);
  await gitDir(dir, ['config', 'user.name', GIT.NAME]);
  await gitDir(dir, ['add', '-A']);
  await gitDir(dir, ['commit', '-q', '-m', 'rest']);
}

/** Stage a change to the governed file; returns the resulting patch. */
async function stageChange(dir) {
  const path = join(dir, 'src', 'review.ts');
  const current = await readFile(path, 'utf8');
  await writeFile(path, `${current}${CHANGE}`);
  await gitDir(dir, ['add', path]);
  return (await exec('git', ['-C', dir, 'diff', '--staged'])).stdout;
}

/** Three labelled-history commits on the governed file, with their shas. */
async function commitHistory(dir) {
  const shas = [];
  for (const content of ['alpha\n', 'beta\n', 'gamma\n']) {
    await writeFile(join(dir, 'src', 'review.ts'), content);
    await gitDir(dir, ['add', '-A']);
    await gitDir(dir, ['commit', '-q', '-m', 'labelled']);
    shas.push((await exec('git', ['-C', dir, 'rev-parse', 'HEAD'])).stdout.trim());
  }
  return shas;
}

/** Label the history the way a human reviewer would, under ADR-008. */
async function writeLabels(dir, rows) {
  await mkdir(join(dir, '.simt'), { recursive: true });
  await writeFile(join(dir, '.simt', 'critic-labels.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
}

/**
 * A stub chat endpoint answering `reply` to every request; every request body is
 * captured, so the tests pin what the critic actually sent.
 */
async function withStubServer(reply, run) {
  const requests = [];
  const server = createServer((req, res) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body: JSON.parse(data || '{}') });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model: 'stub-model', choices: [{ message: { content: reply } }] }));
    });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  try {
    return await run(server, requests);
  } finally {
    await new Promise((done) => server.close(done));
  }
}

/** Configure the local chat endpoint the way a consumer's manifest would. */
async function localConfig(root, server) {
  await writeFile(
    join(root, 'simt.json'),
    JSON.stringify({
      local: { chat: { url: `http://127.0.0.1:${server.address().port}/v1`, model: 'stub-model' } },
    }),
  );
}

async function withNoSocketAllowed(fn) {
  let connectAttempts = 0;
  const origConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...connectArgs) {
    connectAttempts += 1;
    throw new Error('no socket is allowed on the deterministic path');
  };
  try {
    return { result: await fn(), connectAttempts };
  } finally {
    net.Socket.prototype.connect = origConnect;
  }
}

test('the deterministic brief lists what governs the staged diff, with no socket', async () => {
  await withRoot(async (dir) => {
    await fixtureRepo(dir);
    await stageChange(dir);
    const { result, connectAttempts } = await withNoSocketAllowed(() =>
      reviewTarget([], { root: dir }, { commands: [] }),
    );
    assert.equal(connectAttempts, 0);
    assert.equal(result.ok, true);
    assert.equal(result.verdict, null);
    assert.deepEqual(result.staged.files, ['src/review.ts']);
    const ids = result.governs.map((item) => item.id);
    assert.ok(ids.includes('ADR-900'), `governs must name ADR-900, got ${ids.join(', ')}`);
    assert.ok(ids.includes('fixture-rule'), `governs must name the rule, got ${ids.join(', ')}`);
  });
});

test('deterministic run points at --local and names the governing ids', async () => {
  await withRoot(async (dir) => {
    await fixtureRepo(dir);
    await stageChange(dir);
    const { code, stdout } = await runCli(['review', '--root', dir]);
    assert.equal(code, 0);
    assert.match(stdout, /governs\s+.*ADR-900/);
    assert.match(stdout, /fixture-rule/);
    assert.match(stdout, /review --local/);
  });
});

test('nothing staged answers plainly and exits 0', async () => {
  await withRoot(async (dir) => {
    await fixtureRepo(dir);
    const { code, stdout, stderr } = await runCli(['review', '--root', dir]);
    assert.equal(code, 0, `stdout:${stdout}\nstderr:${stderr}`);
    assert.match(stdout, /staged    0 files/);
  });
});

test('unknown review argument is a usage failure', async () => {
  await withRoot(async (dir) => {
    await fixtureRepo(dir);
    await stageChange(dir);
    const { code } = await runCli(['review', 'extra', '--root', dir]);
    assert.equal(code, 2);
  });
});

test('--local without a configured model is a configuration error naming local.chat', async () => {
  await withRoot(async (dir) => {
    await fixtureRepo(dir);
    await stageChange(dir);
    const { code, stdout, stderr } = await runCli(['review', '--root', dir, '--local']);
    assert.equal(code, 3, `stdout:${stdout}\nstderr:${stderr}`);
    assert.match(stdout + stderr, /configure local\.chat/);
  });
});

const BLOCK_REPLY = 'verdict: BLOCK\n- `src/review.ts:12` breaks the governed rule, @ADR-900\n- the test delta is missing, @fixture-rule';

test('--local proposes a verified BLOCK with provenance in the proposal frontmatter', async () => {
  await withRoot(async (dir) => {
    await fixtureRepo(dir);
    await stageChange(dir);
    await withStubServer(BLOCK_REPLY, async (server, requests) => {
      await localConfig(dir, server);
      const { code, stdout } = await runCli(['review', '--root', dir, '--local']);
      assert.equal(code, 0);
      assert.match(stdout, /verdict   BLOCK \(verified\)/);

      const found = /proposal  (\S+)\s+\((\w+), (\d+) bytes\)/.exec(stdout);
      assert.ok(found, `stdout must carry the proposal line, got:\n${stdout}`);
      const proposal = await readFile(join(dir, found[1]), 'utf8');
      assert.match(proposal, /^---\n/);
      assert.match(proposal, /advisory: true/);
      assert.match(proposal, /status: proposal/);
      assert.match(proposal, /verified: true/);
      assert.match(proposal, /verdict: BLOCK/);
      assert.match(proposal, /^engine: review-local:stub-model \(prompt sha256-[0-9a-f]{16}\)$/m);
      assert.ok(proposal.includes(BLOCK_REPLY), proposal);

      assert.equal(requests.length, 1);
      const body = requests[0].body;
      assert.equal(body.model, 'stub-model');
      assert.equal(body.temperature, 0);
      assert.equal(body.stream, false);
      assert.equal(body.max_tokens, Math.min(2048, DEFAULT_BUDGET / 4));
      const prompt = body.messages.find((m) => m.role === 'user').content;
      assert.match(prompt, /STAGED DIFF/);
      assert.match(prompt, /WHAT GOVERNS THIS CHANGE/);
      assert.match(prompt, /ADR-900/);
      assert.match(prompt, /fixture-rule/);
      assert.match(prompt, /prefixed with @/);
      assert.match(prompt, /export function review/);
    });
  });
});

test('the proposal is cached by digest and --refresh regenerates it', async () => {
  await withRoot(async (dir) => {
    await fixtureRepo(dir);
    await stageChange(dir);
    await withStubServer(BLOCK_REPLY, async (server) => {
      await localConfig(dir, server);
      const first = await runCli(['review', '--root', dir, '--local']);
      const path = /proposal  (\S+)/.exec(first.stdout)[1];
      const firstBytes = await readFile(join(dir, path), 'utf8');
      assert.match(first.stdout, /\(fresh, /);

      const second = await runCli(['review', '--root', dir, '--local']);
      assert.match(second.stdout, /\(cached, /);
      const secondBytes = await readFile(join(dir, path), 'utf8');
      assert.equal(secondBytes, firstBytes);

      const third = await runCli(['review', '--root', dir, '--local', '--refresh']);
      assert.match(third.stdout, /\(fresh, /);
      const thirdBytes = await readFile(join(dir, path), 'utf8');
      assert.equal(thirdBytes, firstBytes);
    });
  });
});

test('a reply outside the ADR-008 vocabulary still lands, marked unverified', async () => {
  await withRoot(async (dir) => {
    await fixtureRepo(dir);
    await stageChange(dir);
    await withStubServer('LGTM', async (server) => {
      await localConfig(dir, server);
      const { code, stdout } = await runCli(['review', '--root', dir, '--local']);
      // Advisory by construction: the run answers, the faults travel with it,
      // and the proposal records verified: false for the human to see.
      assert.equal(code, 0);
      assert.match(stdout, /unverified no verdict: line/);
    });
  });
});

test('a citation nothing governs is named a fabrication', async () => {
  await withRoot(async (dir) => {
    const report = parseVerdictReply('verdict: BLOCK\n- `src/review.ts:1` cites @ADR-777', new Set(['ADR-900']));
    assert.equal(report.verdict, 'BLOCK');
    assert.ok(report.faults.some((fault) => fault.includes('@ADR-777')), report.faults.join('; '));
    assert.equal(report.faults.length, 1);
    void dir;
  });
});

test('residual risk must list what was not reviewed', async () => {
  const report = parseVerdictReply('verdict: APPROVE WITH RESIDUAL RISK', new Set(['ADR-008']));
  assert.equal(report.verdict, 'APPROVE WITH RESIDUAL RISK');
  assert.match(report.faults.join('; '), /must list what was not reviewed/);
});

test('verdict values admit case and inner whitespace, nothing else', async () => {
  for (const verdict of VERDICTS) {
    assert.equal(parseVerdictValue(verdict.toLowerCase()), verdict);
  }
  assert.equal(parseVerdictValue('AWR'), null);
  assert.equal(verdictBinary('BLOCK', 'BLOCK').truthCritical, 1);
  assert.equal(verdictBinary('APPROVE', 'BLOCK').saidCritical, 1);
  assert.equal(verdictBinary('APPROVE WITH RESIDUAL RISK', 'APPROVE').saidCritical, 0);
  assert.equal(verdictBinary('LGTM', 'BLOCK'), null);
});

test('the prompt carries the diff and cuts it against the budget, saying so', async () => {
  const diff = 'x'.repeat(500);
  const items = [{ id: 'ADR-900', detail: 't', kind: 'decision' }];
  const whole = buildReviewPrompt(diff, items, 0);
  assert.match(whole, /STAGED DIFF\nx+/);
  assert.ok(!whole.includes('truncated'));

  const capped = buildReviewPrompt(diff, items, 96);
  assert.match(capped, /truncated to 96 bytes/);
  assert.ok(capped.length < whole.length);
  assert.match(capped, /WHAT GOVERNS THIS CHANGE\n- ADR-900  t/);
});

test('bench critic names the missing labelled set instead of inventing a metric', async () => {
  await withRoot(async (dir) => {
    await fixtureRepo(dir);
    const { code, stdout, stderr } = await runCli(['bench', 'critic', '--root', dir]);
    assert.equal(code, 1);
    assert.match(stdout + stderr, /no labelled set at .*critic-labels\.jsonl/);
  });
});

test('bench critic measures precision and recall over the labelled history', async () => {
  await withRoot(async (dir) => {
    await fixtureRepo(dir);
    const shas = await commitHistory(dir);
    await writeLabels(dir, [
      { sha: shas[0], verdict: 'BLOCK' },
      { sha: shas[1], verdict: 'APPROVE' },
      { sha: shas[2], verdict: 'BLOCK' },
    ]);
    await withStubServer('verdict: BLOCK\n- `src/review.ts:1` breaks the governed rule, @ADR-900', async (server) => {
      await localConfig(dir, server);
      const { code, stdout } = await runCli(['bench', 'critic', '--root', dir, '--json']);
      assert.equal(code, 0);
      const report = JSON.parse(stdout);
      assert.equal(report.labels, 3);
      assert.equal(report.measured, 3);
      assert.deepEqual([report.tp, report.fp, report.fn, report.tn], [2, 1, 0, 0]);
      assert.ok(Math.abs(report.precision - 2 / 3) < 1e-9);
      assert.equal(report.recall, 1);
      assert.equal(report.gated, false);
      assert.match(report.labelsNote, /below the 30-diff acceptance floor/);
    });
  });
});

test('bench critic refuses a label outside the vocabulary', async () => {
  await withRoot(async (dir) => {
    await fixtureRepo(dir);
    const shas = await commitHistory(dir);
    await writeLabels(dir, [
      { sha: shas[0], verdict: 'BLOCK' },
      { sha: shas[1], verdict: 'LGTM' },
    ]);
    const { code, stdout, stderr } = await runCli(['bench', 'critic', '--root', dir]);
    assert.equal(code, 1);
    assert.match(stdout + stderr, /verdict is not one of .*BLOCK|APPROVE/);
  });
});
