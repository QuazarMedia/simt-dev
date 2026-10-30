// Rule text variant selection (`simt-variants` and `simt bench variants`, R35).

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import {
  applyVariantInWorkspace,
  isVariantExperimentOpen,
  listVariantSlots,
  parseVariantArmName,
  selectRuleVariants,
  variantArmName,
} from '../src/bench/variants.mjs';
import { dispatch } from '../src/commands/index.mjs';
import { checkCommand, frozenFindings } from '../src/commands/sync.mjs';
import {
  extractVariantsFromRule,
  foldVariants,
  parseVariantSpec,
  readLockedVariants,
  variantsDefect,
} from '../src/kernel/variants.mjs';
import { readLock, writeLockVariants } from '../src/projection/lock.mjs';
import { LOCK_FILE, LOCK_LEGACY } from '../src/name.mjs';
import { desiredRegion } from '../src/projection/rules.mjs';
import { git } from './fixture.mjs';

const tempDirs = [];

after(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function makeVariantRepo() {
  const root = await mkdtemp(join(tmpdir(), 'simt-variants-'));
  tempDirs.push(root);
  await git(['init', '-q', root]);
  await mkdir(join(root, '.simt', 'profiles'), { recursive: true });
  await writeFile(
    join(root, 'package.json'),
    '{ "name": "variant-fixture", "scripts": { "test": "node --test" } }\n',
    'utf8',
  );
  await writeFile(
    join(root, '.simt', 'profiles', 'house.md'),
    [
      '---',
      'simt-id: house',
      'simt-title: House Rules',
      'simt-applies: [node]',
      'simt-priority: hard',
      '---',
      '',
      '# House Rules',
      '',
      '- Commit locally and report the SHA; push only on explicit approval. <!-- simt-variants: push {"b": "Never run git push without explicit approval."} -->',
      '- Run focused tests first.',
      '',
    ].join('\n'),
    'utf8',
  );
  await git(['-C', root, 'add', '-A']);
  await git(['-C', root, 'commit', '-qm', 'initial']);
  return root;
}

test('parseVariantSpec, variantsDefect, and foldVariants handle JSON and key=value forms', () => {
  const unit =
    '- Commit locally and report the SHA. <!-- simt-variants: push {"b": "Never push without explicit approval."} -->';
  const parsed = parseVariantSpec(
    'push {"b": "Never push without explicit approval."}',
    'core',
    '- Commit locally and report the SHA.',
  );
  assert.equal(parsed.error, null);
  assert.equal(parsed.slotId, 'core.push');
  assert.equal(parsed.shortId, 'push');
  assert.equal(parsed.baseline, 'a');
  assert.deepEqual(parsed.variants, {
    a: 'Commit locally and report the SHA.',
    b: 'Never push without explicit approval.',
  });

  const kv = parseVariantSpec(
    'core.push a="First phrasing." | b="Second phrasing."',
    'core',
    '',
  );
  assert.equal(kv.error, null);
  assert.equal(kv.slotId, 'core.push');
  assert.deepEqual(kv.variants, {
    a: 'First phrasing.',
    b: 'Second phrasing.',
  });

  const body = [
    '# Rules',
    '',
    unit,
    '- Keep changes minimal.',
  ].join('\n');
  assert.equal(variantsDefect(body, 'core'), null);

  const slots = extractVariantsFromRule({ id: 'core', source: 'rules/core.md', body });
  assert.equal(slots.length, 1);
  assert.equal(slots[0].slotId, 'core.push');

  // Unlocked: uses baseline `a` and strips the comment marker
  const unlocked = foldVariants(body, 'core', {});
  assert.equal(unlocked.changed, true);
  assert.match(unlocked.body, /- Commit locally and report the SHA\./);
  assert.doesNotMatch(unlocked.body, /simt-variants/);
  assert.equal(unlocked.selected[0].winner, 'a');
  assert.equal(unlocked.selected[0].locked, false);

  // Locked to `b`: replaces the unit with variant `b` while keeping bullet prefix
  const locked = foldVariants(body, 'core', {
    'core.push': {
      winner: 'b',
      model: 'claude-sonnet-4-5',
      harness: 'claude',
      dR: 0.05,
      dC: -0.02,
      n: 10,
      p: 0.01,
    },
  });
  assert.equal(locked.changed, true);
  assert.match(locked.body, /- Never push without explicit approval\./);
  assert.doesNotMatch(locked.body, /Commit locally and report the SHA/);
  assert.doesNotMatch(locked.body, /simt-variants/);
  assert.equal(locked.selected[0].winner, 'b');
  assert.equal(locked.selected[0].locked, true);
});

test('variantsDefect catches malformed markers and duplicate slots, and check reports them', async () => {
  assert.match(variantsDefect('- x <!-- simt-variants: -->', 'core'), /empty/);
  assert.match(variantsDefect('- x <!-- simt-variants: push -->', 'core'), /no variants/);
  assert.match(variantsDefect('- <!-- simt-variants: push {"a": "only one"} -->', 'core'), /at least 2 variants/);
  assert.match(variantsDefect('- x <!-- simt-variants: push {bad json} -->', 'core'), /invalid JSON/);
  assert.match(
    variantsDefect(
      '- one <!-- simt-variants: push {"b": "two"} -->\n- three <!-- simt-variants: push {"b": "four"} -->',
      'core',
    ),
    /duplicate simt-variants slot "core\.push"/,
  );

  const root = await makeVariantRepo();
  await writeFile(
    join(root, '.simt', 'profiles', 'broken.md'),
    [
      '---',
      'simt-id: broken',
      'simt-title: Broken',
      'simt-applies: [node]',
      '---',
      '',
      '- Only one variant. <!-- simt-variants: bad -->',
      '',
    ].join('\n'),
    'utf8',
  );
  let out = '';
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    out += String(chunk);
    return true;
  };
  try {
    const code = await checkCommand([], { root });
    assert.equal(code, 1);
    assert.match(out, /INVALID\s+\.simt\/profiles\/broken\.md/);
    assert.match(out, /simt-variants/);
  } finally {
    process.stdout.write = origWrite;
  }
});

test('projection uses the locked winner from simt.lock.json and check --frozen validates it', async () => {
  const root = await makeVariantRepo();

  // Before locking: baseline variant `a` is projected and marker is stripped
  const before = await desiredRegion(root, {});
  assert.match(before.body, /Commit locally and report the SHA; push only on explicit approval\./);
  assert.doesNotMatch(before.body, /Never run git push without explicit approval\./);
  assert.doesNotMatch(before.body, /simt-variants/);

  // Write locked variant `b` to simt.lock.json
  const lock = await writeLockVariants(root, {
    'house.push': {
      winner: 'b',
      variant: 'b',
      model: 'claude-sonnet-4-5',
      harness: 'claude',
      dR: 0.03,
      dC: -0.11,
      n: 40,
      p: 0.02,
    },
  });

  assert.equal(lock.variants['house.push'].winner, 'b');
  assert.equal(lock.variants['house.push'].model, 'claude-sonnet-4-5');
  assert.equal(lock.variants['house.push'].harness, 'claude');
  assert.equal(lock.variants['house.push'].dR, 0.03);
  assert.equal(lock.variants['house.push'].dC, -0.11);
  assert.equal(lock.variants['house.push'].n, 40);
  assert.equal(lock.variants['house.push'].p, 0.02);

  // Projection now deterministically uses locked winner `b`
  const after = await desiredRegion(root, {});
  assert.match(after.body, /Never run git push without explicit approval\./);
  assert.doesNotMatch(after.body, /Commit locally and report the SHA; push only on explicit approval\./);
  assert.match(after.notes.join('\n'), /variants: applied 1 locked variant\(s\) \(house\.push=b\)/);

  // Frozen check passes when lock matches
  assert.deepEqual(await frozenFindings(root, {}), []);

  // Changing winner in lock without updating digests is flagged as lock-stale
  const { lock: onDisk } = await readLock(root);
  await writeFile(
    join(root, LOCK_FILE),
    `${JSON.stringify(
      {
        ...onDisk,
        variants: {
          'house.push': { ...onDisk.variants['house.push'], winner: 'a', variant: 'a' },
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  const stale = await frozenFindings(root, {});
  assert.equal(stale[0]?.status, 'lock-stale');
});

test('a locked winner under the old lock name is read, not lost (ADR-110)', async () => {
  const root = await makeVariantRepo();

  // The lock a pre-rename run wrote, moved to the legacy name.
  const lock = await writeLockVariants(root, { 'house.push': { winner: 'b' } });
  await rm(join(root, LOCK_FILE), { force: true });
  await writeFile(join(root, LOCK_LEGACY), `${JSON.stringify(lock, null, 2)}\n`, 'utf8');

  assert.deepEqual(await readLockedVariants(root), lock.variants, 'the legacy file answers as the lock');

  const region = await desiredRegion(root, {});
  assert.match(region.body, /Never run git push without explicit approval\./);
});

test('selectRuleVariants runs canary suite, records lockfile evidence, and re-opens on model or harness change', async () => {
  const root = await makeVariantRepo();

  // Seed 2 mined tasks
  const tasksDir = join(root, '.simt', 'bench', 'tasks');
  await mkdir(tasksDir, { recursive: true });
  for (const id of ['t-var-01', 't-var-02']) {
    await writeFile(
      join(tasksDir, `${id}.json`),
      JSON.stringify({ schemaVersion: 1, id, base: 'HEAD', prompt: `fix ${id}` }),
      'utf8',
    );
  }

  const slots = await listVariantSlots(root);
  assert.equal(slots.length, 1);
  assert.equal(slots[0].slotId, 'house.push');

  // Verify arm naming and workspace materialisation
  const armB = variantArmName('house.push', 'b');
  assert.equal(armB, 'variant-house.push-b');
  assert.deepEqual(parseVariantArmName(armB), {
    name: 'variant-house.push-b',
    kind: 'variant',
    base: 'current',
    variant: { slotId: 'house.push', variantKey: 'b' },
  });

  await applyVariantInWorkspace(root, { slotId: 'house.push', variantKey: 'b' });
  const agentsB = await readFile(join(root, 'AGENTS.md'), 'utf8');
  assert.match(agentsB, /Never run git push without explicit approval\./);

  // Stub runner that writes run records where variant `b` has higher R and lower C than `a`
  let runnerCalls = 0;
  const stubRunner = async (repoRoot, opts) => {
    runnerCalls += 1;
    const runDir = join(repoRoot, '.simt', 'bench', 'runs', `run-${runnerCalls}`);
    await mkdir(runDir, { recursive: true });
    for (const arm of opts.arms) {
      for (const task of opts.tasks) {
        const isB = arm.endsWith('-b');
        const resolved = isB ? true : task === 't-var-01';
        const costUsd = isB ? 0.01 : 0.03;
        await writeFile(
          join(runDir, `${task}-${arm}-rep1.json`),
          JSON.stringify({
            schemaVersion: 1,
            task,
            arm,
            harness: opts.harness,
            model: opts.model,
            rep: 1,
            resolved,
            gatesPassed: true,
            usage: { input: 100, cacheWrite: 0, cacheRead: 0, output: 50, turns: 2, toolCalls: 2 },
            costUsd,
            diff: { files: 1, outsideBlastRadius: 0 },
          }),
          'utf8',
        );
      }
    }
  };

  // 1. Run variant selection with harness='claude', model='claude-sonnet-4-5'
  const first = await selectRuleVariants(root, {
    apply: true,
    harness: 'claude',
    model: 'claude-sonnet-4-5',
    runner: stubRunner,
  });

  assert.equal(runnerCalls, 1);
  assert.equal(first.slots.length, 1);
  assert.equal(first.slots[0].winner, 'b');
  assert.equal(first.slots[0].model, 'claude-sonnet-4-5');
  assert.equal(first.slots[0].harness, 'claude');
  assert.equal(first.slots[0].dR, 0.5);
  assert.equal(first.slots[0].dC, -0.02);
  assert.equal(first.slots[0].n, 2);
  assert.equal(typeof first.slots[0].p, 'number');

  // Verify simt.lock.json on disk
  const { lock } = await readLock(root);
  assert.ok(lock);
  assert.deepEqual(lock.variants['house.push'], {
    winner: 'b',
    variant: 'b',
    model: 'claude-sonnet-4-5',
    harness: 'claude',
    dR: 0.5,
    dC: -0.02,
    n: 2,
    p: first.slots[0].p,
  });

  // 2. Re-running with the same model and harness keeps the experiment locked without invoking runner
  const second = await selectRuleVariants(root, {
    apply: true,
    harness: 'claude',
    model: 'claude-sonnet-4-5',
    runner: stubRunner,
  });
  assert.equal(runnerCalls, 1, 'same model and harness must not re-run the experiment');
  assert.equal(second.slots[0].status, 'locked');
  assert.equal(second.slots[0].reopened, false);

  // 3. Changing model or harness re-opens the experiment
  assert.deepEqual(
    isVariantExperimentOpen(lock.variants['house.push'], {
      harness: 'claude',
      model: 'claude-opus-4-5',
      variants: slots[0].variants,
    }),
    { open: true, reopened: true, reason: 'model-changed' },
  );
  assert.deepEqual(
    isVariantExperimentOpen(lock.variants['house.push'], {
      harness: 'codex',
      model: 'claude-sonnet-4-5',
      variants: slots[0].variants,
    }),
    { open: true, reopened: true, reason: 'harness-changed' },
  );

  const reopened = await selectRuleVariants(root, {
    apply: true,
    harness: 'codex',
    model: 'gpt-5-codex',
    runner: stubRunner,
  });
  assert.equal(runnerCalls, 2, 'changed harness/model must re-open and run the experiment');
  assert.equal(reopened.slots[0].status, 'reopened');
  assert.equal(reopened.slots[0].reopened, true);
  assert.equal(reopened.slots[0].harness, 'codex');
  assert.equal(reopened.slots[0].model, 'gpt-5-codex');

  const { lock: updatedLock } = await readLock(root);
  assert.equal(updatedLock.variants['house.push'].harness, 'codex');
  assert.equal(updatedLock.variants['house.push'].model, 'gpt-5-codex');

  // 4. CLI preview runs without writing
  let cliOut = '';
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    cliOut += String(chunk);
    return true;
  };
  try {
    const code = await dispatch(['bench', 'variants', '--root', root, '--json']);
    assert.equal(code, 0);
    const payload = JSON.parse(cliOut.trim());
    assert.equal(payload.command, 'bench variants');
    assert.equal(payload.slots[0].slotId, 'house.push');
  } finally {
    process.stdout.write = origWrite;
  }
});
