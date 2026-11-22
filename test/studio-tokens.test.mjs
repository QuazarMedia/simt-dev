// ST10: the Budget's rectangles are measured bytes, not estimates, and an overflow grows
// the picture past its frame instead of being clipped into a comfortable shape.

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { realpath, writeFile } from 'node:fs/promises';

import { budget, layoutTreemap, sessionPathError, sessionSplit } from '../src/studio/public/budget.js';
import { simt } from './fixture.mjs';
import { fixtureRepo, httpReq, session, startStudio } from './studio-fixture.mjs';

const payload = ({ budgetBytes = 1000, generated = 300 } = {}) => ({
  ok: true,
  command: 'tokens',
  root: '/fixture',
  mode: 'repository',
  budget: { bytes: budgetBytes, bytesPerToken: 4 },
  totals: { generatedBytes: generated, tokens: generated / 4 },
  roots: [
    {
      name: 'alpha',
      channels: [
        { channel: 'codex', generatedBytes: 100, readerBytes: 40 },
        { channel: 'claude', generatedBytes: 50, readerBytes: 20 },
      ],
    },
    {
      name: 'beta',
      channels: [{ channel: 'codex', generatedBytes: 150, readerBytes: 30 }],
    },
  ],
});

test('rectangle areas are proportional to measured bytes, grouped by repository', () => {
  const layout = layoutTreemap(payload());
  assert.equal(layout.rectangles.length, 3);
  const ratios = layout.rectangles.map((rect) => rect.area / rect.bytes);
  assert.ok(ratios.every((ratio) => Math.abs(ratio - ratios[0]) < 1e-9), `areas drifted: ${ratios.join(', ')}`);
  assert.deepEqual([...new Set(layout.rectangles.map((rect) => rect.repository))], ['alpha', 'beta']);
  assert.equal(layout.rectangles.filter((rect) => rect.repository === 'alpha').length, 2);
});

test('an over-budget layout extends past its frame and says by how much', () => {
  const over = layoutTreemap(payload({ budgetBytes: 100, generated: 300 }));
  assert.equal(over.overflow, true);
  assert.equal(over.overBy, 200);
  assert.equal(over.frame?.over, true);
  assert.ok(over.height > over.frame.y + over.frame.h, 'the frame must not contain the overflow');
  assert.match(budget(payload({ budgetBytes: 100, generated: 300 })), /over budget by 200 B/);

  const within = layoutTreemap(payload({ budgetBytes: 1000, generated: 300 }));
  assert.equal(within.overflow, false);
  assert.match(budget(payload({ budgetBytes: 1000, generated: 300 })), /within budget/);
});

test('the session split is shares of the measured bytes, and a URL is refused with the CLI remedy', () => {
  const sessionPayload = {
    ok: true,
    mode: 'session',
    rules: { bytes: 40, tokens: 10, share: 40 },
    fileReads: { bytes: 30, tokens: 8, share: 30 },
    toolOutput: { bytes: 30, tokens: 8, share: 30 },
    total: { bytes: 100, tokens: 25 },
  };
  const split = sessionSplit(sessionPayload);
  assert.deepEqual(split.map((part) => [part.label, part.bytes]), [
    ['rules', 40],
    ['file reads', 30],
    ['tool output', 30],
  ]);
  assert.equal(split.reduce((sum, part) => sum + part.share, 0), 1);
  assert.match(budget(sessionPayload), /session split/);

  const refused = sessionPathError('https://example.com/session.jsonl');
  assert.match(refused.error, /remote URLs are refused/);
  assert.match(refused.error, /ADR-075/);
  assert.match(refused.remedy, /local file path/);
  assert.equal(sessionPathError('./session.jsonl'), null);
});

test('the tokens payload equals `tokens --json`, and the session route reads a local transcript', async (t) => {
  const root = await realpath(await fixtureRepo({ 'AGENTS.md': '# House rules\n' }));
  const cli = await simt(['tokens', '--root', root, '--json'], { cwd: root });
  assert.equal(cli.code, 0, cli.stderr + cli.stdout);
  const studio = await startStudio(root);
  t.after(() => studio.stop());
  const cookie = await session(studio);
  const response = await httpReq(studio.port, { path: '/api/tokens', headers: { cookie } });
  assert.equal(response.status, 200, response.body);
  assert.deepEqual(JSON.parse(response.body), JSON.parse(cli.stdout));

  const transcript = join(root, 'session.jsonl');
  await writeFile(transcript, `${JSON.stringify({ role: 'system', content: 'System rule text here.' })}\n${JSON.stringify({ role: 'user', content: 'hello' })}\n`);
  const sessionCli = await simt(['tokens', '--session', transcript, '--root', root, '--json'], { cwd: root });
  assert.equal(sessionCli.code, 0, sessionCli.stderr + sessionCli.stdout);
  const sessionResponse = await httpReq(studio.port, {
    path: `/api/tokens/session?session=${encodeURIComponent(transcript)}`,
    headers: { cookie },
  });
  assert.equal(sessionResponse.status, 200, sessionResponse.body);
  assert.deepEqual(JSON.parse(sessionResponse.body), JSON.parse(sessionCli.stdout));

  const remote = await httpReq(studio.port, {
    path: '/api/tokens/session?session=https%3A%2F%2Fexample.com%2Fsession.jsonl',
    headers: { cookie },
  });
  assert.equal(remote.status, 400, remote.body);
  assert.match(JSON.parse(remote.body).error, /remote URLs are refused/);
});
