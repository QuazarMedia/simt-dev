// ST04: the Overview view-model, asserted without a DOM. The fixtures mirror the
// snapshot's shapes (src/status-snapshot.mjs) so the pure module is tested against
// the same documents the doors serve; one server test closes the loop by rendering
// what the studio actually answers.

import test from 'node:test';
import assert from 'node:assert/strict';

import { overview } from '../src/studio/public/overview.js';
import { escapeHtml } from '../src/studio/public/components.js';
import { simt } from './fixture.mjs';
import { fixtureRepo, httpReq, session, startStudio } from './studio-fixture.mjs';

function base() {
  return {
    ok: true,
    command: 'status',
    root: '/repo',
    at: 1,
    head: 'abc123',
    check: {
      at: 1, head: 'abc123', stale: false, line: 'gate green (2/2 gates)',
      rulesOk: true, hooksOk: true, gatesRun: 2, gatesTotal: 2, blocking: 0, warnings: 0,
    },
    gitHooks: {
      hooksPath: '.githooks', liveDir: '.githooks',
      events: [
        { event: 'pre-commit', present: true, stale: false },
        { event: 'pre-push', present: true, stale: false },
        { event: 'post-merge', present: false, stale: false },
      ],
      foreign: 1,
      gates: { preCommit: ['lint'], prePush: ['lint', 'test'] },
      gatesError: null,
    },
    agentHooks: {
      wired: 2, total: 3,
      harnesses: [
        { id: 'claude', path: '.claude/settings.json', state: 'present' },
        { id: 'codex', path: '.codex/config.toml', state: 'present' },
        { id: 'cursor', path: '.cursor/rules', state: 'absent' },
      ],
    },
    evidence: { entries: 4, errors: 0, headTree: 'tree1', testsRecorded: true },
    leases: { active: 2, paths: ['src/a.mjs', 'src/b.mjs'] },
    slices: { ready: 1, totals: { Queued: 2, 'In progress': 1, Done: 3 } },
    journal: { sets: 2, last: '2026-11-20T10-00-00' },
  };
}

const CHECK = {
  ok: false,
  command: 'check',
  root: '/repo',
  findings: [
    { file: 'simt.toml', status: 'drift', detail: 'hooks drifted', remedy: 'run: simt sync --yes' },
    { file: 'src/x.mjs', status: 'missing', detail: 'pointer target is gone', remedy: 'run: simt doctor' },
    { file: 'src/y.mjs', status: 'invalid', detail: 'rule does not parse', remedy: 'fix the rule by hand' },
  ],
};

const WORK = {
  ok: true,
  command: 'work inspect',
  root: '/repo',
  work: { declared: true, ok: true, version: 1, problems: [] },
  next: { step: 'bind evidence to the open scope', remedy: 'run: simt work verify --scope core' },
};

/** The rows behind a named count, so "3 findings" can be checked against 3 rows. */
function rowsUnder(html, summary) {
  const block = html.split(`<summary>${escapeHtml(summary)}</summary>`)[1]?.split('</details>')[0] ?? '';
  const body = block.split('<tbody>')[1]?.split('</tbody>')[0] ?? '';
  return (body.match(/<tr>/g) ?? []).length;
}

test('a failed slot is named and the other slots still answer', () => {
  const snapshot = base();
  snapshot.leases = { error: 'the lease file is not readable' };
  snapshot.journal = { error: 'journal directory refused <access>' };
  const html = overview(snapshot, CHECK, WORK);
  assert.match(html, /the lease file is not readable/);
  assert.match(html, /journal directory refused &lt;access&gt;/);
  assert.equal((html.match(/unreadable/g) ?? []).length, 2);
  assert.match(html, /4 run\(s\) recorded/);
  assert.match(html, /2\/3 harnesses wired/);
  assert.match(html, /1 ready/);
  assert.match(html, /gate green \(2\/2 gates\)/);
});

test('every finding renders with its remedy and the count equals the rows', () => {
  const html = overview(base(), CHECK, WORK);
  for (const finding of CHECK.findings) {
    assert.ok(html.includes(escapeHtml(finding.file)), finding.file);
    assert.ok(html.includes(escapeHtml(finding.detail)), finding.detail);
    assert.ok(html.includes(escapeHtml(finding.remedy)), finding.remedy);
  }
  assert.match(html, /<summary>3 findings<\/summary>/);
  assert.equal(rowsUnder(html, '3 findings'), CHECK.findings.length);
  assert.match(html, /gate red/);
});

test('counts equal the named rows\' length', () => {
  const html = overview(base(), { ...CHECK, ok: true, findings: [] }, WORK);
  assert.match(html, /<p>0 findings<\/p>/);
  assert.match(html, /2\/3 events wired/);
  assert.equal(rowsUnder(html, '3 events'), 3);
  assert.equal(rowsUnder(html, '3 harnesses'), 3);
  assert.match(html, /2 active/);
  assert.equal(rowsUnder(html, '2 paths'), 2);
  assert.equal(rowsUnder(html, '3 states'), 3);
  assert.match(html, /1 foreign/);
});

test('the unconfigured repository shows the setup next step, not an error page', () => {
  const snapshot = base();
  snapshot.check = null;
  snapshot.gitHooks = { hooksPath: null, liveDir: '.git/hooks', events: [], foreign: 0, gates: null, gatesError: null };
  const work = {
    ok: true,
    command: 'work inspect',
    root: '/repo',
    work: { declared: false, ok: true, version: null, problems: [] },
    next: {
      step: 'declare one scope so work has a name',
      remedy: 'run: simt work setup --scope <id> --path <dir> --kind <kind>',
    },
  };
  const html = overview(snapshot, { ok: true, command: 'check', root: '/repo', findings: [] }, work);
  assert.match(html, /no cache yet/);
  assert.ok(html.includes(escapeHtml(work.next.remedy)));
  assert.ok(!html.includes('role="alert"'));
});

test('a refused check is confined to the gate card', () => {
  const refusal = { ok: false, error: 'the manifest does not parse', remedy: 'fix simt.toml by hand', exitCode: 2 };
  const html = overview(base(), refusal, WORK);
  assert.equal((html.match(/role="alert"/g) ?? []).length, 1);
  assert.match(html, /the manifest does not parse/);
  assert.match(html, /fix simt\.toml by hand/);
  assert.match(html, /exit 2/);
  assert.match(html, /2 active/);
  assert.match(html, /4 run\(s\) recorded/);
});

test('a refused work read is confined to the next step card', () => {
  const refusal = { ok: false, error: 'work declaration is unreadable', remedy: 'run: simt doctor' };
  const html = overview(base(), CHECK, refusal);
  assert.equal((html.match(/role="alert"/g) ?? []).length, 1);
  assert.match(html, /work declaration is unreadable/);
  assert.match(html, /3 findings/);
});

test('an empty row set opens no disclosure', () => {
  const snapshot = base();
  snapshot.leases = { active: 0, paths: [] };
  snapshot.gitHooks = { hooksPath: null, liveDir: '.git/hooks', events: [], foreign: 0, gates: null, gatesError: null };
  snapshot.agentHooks = { wired: 0, total: 0, harnesses: [] };
  snapshot.slices = { ready: 0, totals: {} };
  const html = overview(snapshot, { ok: true, command: 'check', root: '/repo', findings: [] }, WORK);
  assert.ok(!html.includes('<details'), 'an empty count must not render an empty disclosure');
  assert.match(html, /0 active/);
  assert.match(html, /0\/0 events wired/);
});

test('the footer names the commands that computed the view', () => {
  const html = overview(base(), CHECK, WORK);
  assert.match(html, /<code>simt status --json<\/code>/);
  assert.match(html, /<code>simt check --json<\/code>/);
  assert.match(html, /<code>simt work inspect --json<\/code>/);
});

test('repository-sourced text is escaped, never mounted as markup', () => {
  const snapshot = base();
  snapshot.root = '/repo/<img src=x onerror=alert(1)>';
  const check = {
    ok: false,
    command: 'check',
    root: snapshot.root,
    findings: [{ file: '<script>.mjs', status: 'invalid', detail: '<b>bold</b>', remedy: 'rm <script>' }],
  };
  const html = overview(snapshot, check, WORK);
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<b>'));
  assert.ok(html.includes(escapeHtml(snapshot.root)));
  assert.ok(html.includes('&lt;script&gt;.mjs'));
});

test('the overview renders the snapshot the studio actually serves', async (t) => {
  const root = await fixtureRepo();
  const studio = await startStudio(root);
  t.after(() => studio.stop());
  const cookie = await session(studio);

  const read = async (path) => {
    const res = await httpReq(studio.port, { path, headers: { cookie } });
    assert.equal(res.status, 200, `${path}: ${res.body}`);
    return JSON.parse(res.body);
  };
  const [snapshot, check, work] = await Promise.all([read('/api/status'), read('/api/check'), read('/api/work')]);

  const cli = await simt(['status', '--json'], { cwd: root });
  assert.equal(cli.code, 0, cli.stderr);
  const printed = JSON.parse(cli.stdout);
  assert.equal(typeof snapshot.at, 'number');
  assert.equal(typeof printed.at, 'number');
  delete snapshot.at;
  delete printed.at;
  assert.deepEqual(snapshot, printed);

  const html = overview(snapshot, check, work);
  assert.ok(html.includes(escapeHtml(snapshot.root)));
  assert.match(html, /how this was computed/);
});
