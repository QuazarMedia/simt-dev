import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { assembleBrief } from '../src/brief/assemble.mjs';
import { SEEN_MULTIPLIER } from '../src/brief/session.mjs';
import { reindex } from '../src/index/store.mjs';
import { ensureGit, simt, tempDir } from './fixture.mjs';

test('session ledger penalizes unchanged Turn-1 items at 0.20x on Turn 2 and resets to 1.00x when modified', async () => {
  const root = await tempDir('brief-seen-');
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'test'), { recursive: true });
  await writeFile(join(root, 'src', 'authPrimary.mjs'), 'export function validateAuthSessionToken(tok) { return Boolean(tok); }\n');
  await writeFile(join(root, 'src', 'authFallback.mjs'), 'export function validateAuthSessionBackup(tok) { return tok === "ok"; }\n');
  await writeFile(join(root, 'test', 'authPrimary.test.mjs'), "import '../src/authPrimary.mjs';\n");
  await writeFile(join(root, 'test', 'authFallback.test.mjs'), "import '../src/authFallback.mjs';\n");
  await ensureGit(root);
  await reindex(root, { fielded: true });

  // Default single-call without --seen writes no ledger and keeps identical output
  const baselineA = await assembleBrief({ root, task: 'Fix validateAuthSessionToken and validateAuthSessionBackup', retrieval: 'v2', budget: 520 });
  const baselineB = await assembleBrief({ root, task: 'Fix validateAuthSessionToken and validateAuthSessionBackup', retrieval: 'v2', budget: 520 });
  assert.equal(baselineA.packed.text, baselineB.packed.text);
  assert.equal(existsSync(join(root, '.simt', 'session-brief.json')), false);

  // Turn 1 with session ledger
  const ledgerRel = '.simt/session-brief.json';
  const turn1 = await assembleBrief({
    root,
    task: 'Fix validateAuthSessionToken and validateAuthSessionBackup',
    retrieval: 'v2',
    budget: 520,
    seen: ledgerRel,
  });
  assert.equal(existsSync(join(root, ledgerRel)), true);
  const ledger = JSON.parse(await readFile(join(root, ledgerRel), 'utf8'));
  assert.equal(ledger.version, 1);
  assert.ok(Object.keys(ledger.entries).length >= 1);

  const turn1Files = turn1.sections.FILES ?? [];
  assert.ok(turn1Files.some((line) => line.includes('src/authPrimary.mjs')));

  // Turn 2 with unchanged tree: Turn-1 items are weighted 0.20x so fresh items surface
  const turn2 = await assembleBrief({
    root,
    task: 'Fix validateAuthSessionToken and validateAuthSessionBackup',
    retrieval: 'v2',
    budget: 520,
    seen: ledgerRel,
  });
  assert.equal(turn2.seen.active, true);
  assert.equal(turn2.seen.multiplier, SEEN_MULTIPLIER);
  assert.ok(turn2.seen.penalized.length >= 1);
  const turn2Files = turn2.sections.FILES ?? [];
  assert.ok(
    turn2Files.some((line) => line.includes('src/authFallback.mjs'))
      || (turn2.sections.TESTS ?? []).some((line) => line.includes('authPrimary') || line.includes('authFallback')),
    `expected Turn 2 to surface fresh items, got: ${turn2.packed.text}`,
  );
  assert.notEqual(turn2.packed.text, turn1.packed.text);

  // Modify authPrimary.mjs in worktree -> revision changes -> weight immediately resets to 1.00x
  await writeFile(
    join(root, 'src', 'authPrimary.mjs'),
    'export function validateAuthSessionToken(tok) { return typeof tok === "string" && tok.length > 0; }\n',
  );
  const turn3 = await assembleBrief({
    root,
    task: 'Fix validateAuthSessionToken and validateAuthSessionBackup',
    retrieval: 'v2',
    budget: 520,
    seen: ledgerRel,
  });
  assert.ok(turn3.seen.reset.includes('FILES:src/authPrimary.mjs'), `expected reset for modified file, got ${JSON.stringify(turn3.seen)}`);
  const modifiedItem = turn3.items.find((item) => item.key === 'FILES:src/authPrimary.mjs');
  assert.equal(modifiedItem.utilityWeight, 1);
});

test('CLI brief --seen accepts explicit comma-separated paths cleanly', async () => {
  const root = await tempDir('brief-seen-cli-');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'alphaToken.mjs'), 'export function alphaTokenHandler() { return 1; }\n');
  await writeFile(join(root, 'src', 'betaToken.mjs'), 'export function betaTokenHandler() { return 2; }\n');
  await ensureGit(root);
  await reindex(root, { fielded: true });

  const { code, stdout, stderr } = await simt(
    ['brief', 'Update alphaTokenHandler and betaTokenHandler', '--seen', 'src/alphaToken.mjs', '--budget', '480', '--json'],
    { cwd: root },
  );
  assert.equal(code, 0, stderr);
  const payload = JSON.parse(stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.seen.active, true);
  assert.ok(payload.seen.penalized.some((id) => id.includes('src/alphaToken.mjs')));
});
