// ST09: the Harness wall joins the two doors that answer different questions. A harness
// is never inferred to be installed from the presence of its directory, and a denial
// keeps the hook's own verdict and rule ids.

import test from 'node:test';
import assert from 'node:assert/strict';

import { harnessTiles, harnessWall, policyEvent, policyEventItem } from '../src/studio/public/harness.js';
import { simt } from './fixture.mjs';
import { fixtureRepo, httpReq, session, startStudio } from './studio-fixture.mjs';

const detected = (id, dir, extra = {}) => ({
  dir,
  kind: 'rules',
  label: id,
  surface: id,
  channel: true,
  readsAgentsMd: 'all',
  ...extra,
});

const hook = (id, state, extra = {}) => ({ id, path: `.${id}/hooks.json`, state, entries: 1, note: null, ...extra });

test('every harness state has its own class and label, including detection-only and untrusted', () => {
  const payload = {
    detect: {
      repo: {
        rows: [
          detected('claude', '.claude'),
          detected('codex', '.codex'),
          detected('cursor', '.cursor', { channel: false }),
          detected('windsurf', '.windsurf'),
        ],
      },
    },
    hooks: {
      harnesses: [
        hook('claude', 'present'),
        hook('codex', 'present', { note: 'Codex requires the hook to be trusted by hand' }),
        hook('cursor', 'drift', { entries: 0 }),
        hook('windsurf', 'unreadable', { entries: 0, note: 'not a JSON object' }),
      ],
    },
    policies: [],
  };
  const tiles = harnessTiles(payload);
  const byId = Object.fromEntries(tiles.map((tile) => [tile.id, tile]));
  assert.equal(byId.claude.state, 'present');
  assert.equal(byId.codex.state, 'untrusted');
  assert.equal(byId.cursor.state, 'drift');
  assert.equal(byId.windsurf.state, 'unreadable');

  const html = harnessWall(payload);
  assert.match(html, /harness-present/);
  assert.match(html, /harness-untrusted/);
  assert.match(html, /harness-drift/);
  assert.match(html, /harness-unreadable/);
  assert.match(html, /installed, not trusted/);

  const only = harnessTiles({
    detect: { repo: { rows: [detected('future', '.future', { channel: false })] } },
    hooks: { harnesses: [] },
  });
  assert.equal(only[0].state, 'detection-only');
  assert.match(harnessWall({ detect: { repo: { rows: [detected('future', '.future', { channel: false })] } }, hooks: { harnesses: [] }, policies: [] }), /harness-detection-only/);
  assert.match(harnessWall({ detect: { repo: { rows: [detected('future', '.future', { channel: false })] } }, hooks: { harnesses: [] }, policies: [] }), /Detection only/);
});

test('a denial shows the rule id and the verdict verbatim, not a warning', () => {
  const event = {
    id: '01J',
    kind: 'policy.decided',
    harness: 'claude',
    subject: 'git push origin main',
    data: { decision: 'deny', blocked: ['push'], messages: ['Push needs explicit approval (ADR-001); ask the user.'] },
  };
  const read = policyEvent(event);
  assert.equal(read.verdict, 'deny');
  assert.deepEqual(read.rules, ['push']);
  const html = policyEventItem(event);
  assert.match(html, /data-verdict="deny"/);
  assert.match(html, /harness-deny/);
  assert.match(html, /<code>push<\/code>/);
  assert.match(html, /Push needs explicit approval/);
  assert.doesNotMatch(html, /warning/i);
});

test('the wall payload equals the detect and status documents the CLI prints', async (t) => {
  const root = await fixtureRepo({
    'simt.json': '{\n  "surfaces": ["claude"]\n}\n',
    '.claude/settings.json': '{}\n',
  });
  const detect = await simt(['harness', 'detect', '--json'], { cwd: root });
  const status = await simt(['agent-hooks', 'status', '--json'], { cwd: root });
  assert.equal(detect.code, 0, detect.stderr + detect.stdout);
  assert.equal(status.code, 0, status.stderr + status.stdout);
  const studio = await startStudio(root);
  t.after(() => studio.stop());
  const cookie = await session(studio);
  const response = await httpReq(studio.port, { path: '/api/harness', headers: { cookie } });
  assert.equal(response.status, 200, response.body);
  const payload = JSON.parse(response.body);
  assert.deepEqual(payload.detect, JSON.parse(detect.stdout));
  assert.deepEqual(payload.hooks, JSON.parse(status.stdout));
  assert.ok(payload.policies.some((policy) => policy.id === 'push'));
  assert.equal(harnessTiles(payload).find((tile) => tile.id === 'claude')?.state, 'absent');
});
