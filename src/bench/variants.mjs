// Variant selection for rule text (`simt bench variants`, plan 0003 R35).
//
// Discovers `simt-variants` slots across applicable rules, runs candidate
// variants on the 10-task canary suite (escalating when significant), records
// the winning variant with `{winner, variant, model, harness, dR, dC, n, p}`
// in `simt.lock.json`, and re-opens the experiment whenever the target
// model or harness changes.

import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { extractVariantsFromRule, readLockedVariants } from '../kernel/variants.mjs';
import { LOCK_FILE, MANIFEST_FILE, STATE_DIR } from '../name.mjs';
import { writeLockVariants } from '../projection/lock.mjs';
import { readManifest } from '../projection/manifest.mjs';
import { loadMdcRules } from '../projection/mdc.mjs';
import { plan } from '../projection/project.mjs';
import { isEligible, loadRules, readDeclared, select } from '../projection/rules.mjs';
import { fingerprint } from '../resolve/fingerprint.mjs';
import { CANARY_ALPHA, DEFAULT_CANARY_SIZE, DEL_R_TOLERANCE, shouldEscalateCanary } from './ablate.mjs';
import {
  DEFAULT_BOOTSTRAP_SAMPLES,
  DEFAULT_BOOTSTRAP_SEED,
  compareArms,
  evaluateRunRecord,
  loadPrices,
  loadRunRecords,
} from './report.mjs';

/**
 * Discover every `simt-variants` slot across applicable rules for `root`.
 */
export async function listVariantSlots(root, { includeAll = false } = {}) {
  const resolvedRoot = resolve(root);
  const [{ stack, facts }, allRules, mdcRules, declared] = await Promise.all([
    fingerprint(resolvedRoot),
    loadRules(resolvedRoot),
    loadMdcRules(),
    readDeclared(resolvedRoot),
  ]);

  const signals = new Set([...(stack ?? []), ...(facts ?? [])]);
  const { selected } = select(allRules, stack ?? [], facts ?? []);
  const rulePool = includeAll ? allRules : selected;
  const mdcPool = includeAll
    ? mdcRules.filter((r) => r.id && r.error === null)
    : mdcRules.filter((r) => r.id && r.error === null && isEligible(r, signals, declared.optIn));

  const slots = [];
  for (const rule of [...rulePool, ...mdcPool]) {
    if (!rule || rule.error !== null) continue;
    slots.push(...extractVariantsFromRule(rule));
  }
  return slots.sort((a, b) => a.slotId.localeCompare(b.slotId));
}

/**
 * Parse a variant benchmark arm name (`variant-<slotId>-<variantKey>`) or return null.
 */
export function parseVariantArmName(armName) {
  const s = String(armName ?? '').trim();
  if (!s.startsWith('variant-')) return null;
  const rest = s.slice('variant-'.length);
  const dash = rest.lastIndexOf('-');
  if (dash <= 0 || dash === rest.length - 1) return null;
  const slotId = rest.slice(0, dash);
  const variantKey = rest.slice(dash + 1);
  return {
    name: s,
    kind: 'variant',
    base: 'current',
    variant: { slotId, variantKey },
  };
}

/**
 * Format the arm name for a `(slotId, variantKey)` pair.
 */
export function variantArmName(slotId, variantKey) {
  return `variant-${slotId}-${variantKey}`;
}

/**
 * Determine whether a locked variant entry is still valid or re-opened by a model/harness change.
 */
export function isVariantExperimentOpen(
  lockedEntry,
  { harness, model, variants, force = false } = {},
) {
  if (force) return { open: true, reopened: Boolean(lockedEntry), reason: 'forced' };
  if (!lockedEntry || typeof lockedEntry !== 'object') {
    return { open: true, reopened: false, reason: 'unlocked' };
  }
  const winner = lockedEntry.winner ?? lockedEntry.variant;
  if (typeof winner !== 'string' || winner === '') {
    return { open: true, reopened: true, reason: 'missing-winner' };
  }
  if (variants && typeof variants === 'object' && !Object.hasOwn(variants, winner)) {
    return { open: true, reopened: true, reason: 'unknown-variant' };
  }
  if (harness && lockedEntry.harness && lockedEntry.harness !== harness) {
    return { open: true, reopened: true, reason: 'harness-changed' };
  }
  if (model && lockedEntry.model && lockedEntry.model !== model) {
    return { open: true, reopened: true, reason: 'model-changed' };
  }
  return { open: false, reopened: false, reason: 'locked' };
}

/**
 * Materialise a variant arm inside an isolated benchmark workspace `workDir`.
 */
export async function applyVariantInWorkspace(workDir, variant) {
  if (!variant || typeof variant !== 'object') return;
  const { slotId, variantKey } = variant;
  if (!slotId || !variantKey) return;

  const manifestRes = await readManifest(workDir);
  const manifestPath = manifestRes.path ?? join(workDir, MANIFEST_FILE);
  const hadManifest = manifestRes.exists;
  const originalManifestBytes = hadManifest
    ? await readFile(manifestPath, 'utf8').catch(() => null)
    : null;

  const baseManifest = manifestRes.data ?? {
    schemaVersion: 1,
    projection: { sha: '0000000000000000000000000000000000000000', sources: [] },
    gates: { preCommit: [], prePush: [] },
  };
  const nextManifest = { ...baseManifest };
  delete nextManifest.mode;
  await writeFile(manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`, 'utf8');

  // plan() writes the lock as a target (Q29). Left behind, it records this arm's
  // winner as locked, and the next selectRuleVariants on the same tree reads the
  // experiment as closed and never runs the runner. Restore it, like the manifest.
  const lockPath = join(workDir, LOCK_FILE);
  let originalLockBytes = null;
  let hadLock = false;
  try {
    originalLockBytes = await readFile(lockPath, 'utf8');
    hadLock = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const planned = await plan(workDir, {
    variants: { [slotId]: { winner: variantKey } },
  });
  for (const t of planned.targets ?? []) {
    if (t.action !== 'unchanged' && typeof t.text === 'string') {
      await mkdir(dirname(t.path), { recursive: true });
      await writeFile(t.path, t.text, 'utf8');
    }
  }

  if (!hadManifest) {
    await unlink(manifestPath).catch(() => {});
  } else if (originalManifestBytes !== null) {
    await writeFile(manifestPath, originalManifestBytes, 'utf8');
  }
  if (!hadLock) {
    await unlink(lockPath).catch(() => {});
  } else {
    await writeFile(lockPath, originalLockBytes, 'utf8');
  }
}

function summarizeEvaluated(evaluated) {
  if (evaluated.length === 0) {
    return { n: 0, R: 0, C: 0 };
  }
  const byTask = new Map();
  for (const row of evaluated) {
    const list = byTask.get(row.task) ?? [];
    list.push(row);
    byTask.set(row.task, list);
  }
  let sumR = 0;
  let sumC = 0;
  for (const list of byTask.values()) {
    sumR += list.reduce((a, x) => a + x.R, 0) / list.length;
    sumC += list.reduce((a, x) => a + x.costUsd, 0) / list.length;
  }
  const n = byTask.size;
  return { n, R: sumR / n, C: sumC / n };
}

/**
 * Run or evaluate variant selection on the canary suite and record winners in `simt.lock.json`.
 */
export async function selectRuleVariants(
  root,
  {
    apply = false,
    force = false,
    harness = 'gold',
    model,
    reps = 1,
    canarySize = DEFAULT_CANARY_SIZE,
    includeAll = false,
    slots: customSlots,
    prices: customPrices,
    samples = DEFAULT_BOOTSTRAP_SAMPLES,
    seed = DEFAULT_BOOTSTRAP_SEED,
    vaultRoot,
    runner,
  } = {},
) {
  const resolvedRoot = resolve(root);
  const resolvedModel = model ?? harness;
  const [slots, existingLocks, prices] = await Promise.all([
    customSlots ? Promise.resolve(customSlots) : listVariantSlots(resolvedRoot, { includeAll }),
    readLockedVariants(resolvedRoot),
    customPrices !== undefined ? Promise.resolve(customPrices) : loadPrices(resolvedRoot),
  ]);

  const tasksDir = join(resolvedRoot, STATE_DIR, 'bench', 'tasks');
  let taskIds = [];
  try {
    const files = (await readdir(tasksDir)).filter((f) => f.endsWith('.json')).sort();
    for (const file of files) {
      const data = JSON.parse(await readFile(join(tasksDir, file), 'utf8'));
      if (data?.id) taskIds.push(data.id);
    }
    taskIds.sort();
  } catch {
    taskIds = [];
  }

  const canaryTaskIds = taskIds.slice(0, Math.max(1, canarySize));
  const remainingTaskIds = taskIds.slice(canaryTaskIds.length);

  const slotStates = slots.map((slot) => {
    const lockedEntry = existingLocks[slot.slotId] ?? null;
    const check = isVariantExperimentOpen(lockedEntry, {
      harness,
      model: resolvedModel,
      variants: slot.variants,
      force,
    });
    return {
      slot,
      lockedEntry,
      ...check,
    };
  });

  const openStates = slotStates.filter((s) => s.open);
  const escalatedArms = new Set();

  if (apply && openStates.length > 0) {
    if (taskIds.length === 0) {
      throw new Error(`no mined benchmark tasks found in ${tasksDir}; run bench mine --yes first`);
    }
    const execRunBench = runner ?? (await import('./run.mjs')).runBench;
    const canaryArms = [];
    for (const { slot } of openStates) {
      for (const key of Object.keys(slot.variants)) {
        canaryArms.push(variantArmName(slot.slotId, key));
      }
    }

    await execRunBench(resolvedRoot, {
      apply: true,
      arms: canaryArms,
      harness,
      model: resolvedModel,
      reps,
      tasks: canaryTaskIds,
      ...(vaultRoot ? { vaultRoot } : {}),
    });

    if (remainingTaskIds.length > 0) {
      const canaryEvaluated = (await loadRunRecords(resolvedRoot))
        .filter(
          (rec) =>
            canaryTaskIds.includes(rec.task) &&
            (!harness || rec.harness === harness) &&
            (!model || rec.model === resolvedModel),
        )
        .map((rec) => evaluateRunRecord(rec, prices));
      const armsToEscalate = [];
      const includeBaseline = new Set();
      for (const { slot } of openStates) {
        const baseArm = variantArmName(slot.slotId, slot.baseline);
        const baseRecs = canaryEvaluated.filter((r) => r.arm === baseArm);
        for (const key of Object.keys(slot.variants)) {
          if (key === slot.baseline) continue;
          const candArm = variantArmName(slot.slotId, key);
          const candRecs = canaryEvaluated.filter((r) => r.arm === candArm);
          if (baseRecs.length > 0 && candRecs.length > 0) {
            const comp = compareArms(baseArm, baseRecs, candArm, candRecs, { samples, seed });
            if (shouldEscalateCanary(comp, { alpha: CANARY_ALPHA })) {
              includeBaseline.add(baseArm);
              armsToEscalate.push(candArm);
              escalatedArms.add(candArm);
            }
          }
        }
      }
      const fullEscalationArms = [...includeBaseline, ...armsToEscalate];
      if (fullEscalationArms.length > 0) {
        await execRunBench(resolvedRoot, {
          apply: true,
          arms: fullEscalationArms,
          harness,
          model: resolvedModel,
          reps,
          tasks: remainingTaskIds,
          ...(vaultRoot ? { vaultRoot } : {}),
        });
      }
    }
  }

  const allEvaluated = (await loadRunRecords(resolvedRoot))
    .filter(
      (rec) =>
        (!harness || rec.harness === harness) &&
        (!model || !rec.model || rec.model === resolvedModel),
    )
    .map((rec) => evaluateRunRecord(rec, prices));

  const results = [];
  const nextVariantsLock = { ...existingLocks };

  for (const state of slotStates) {
    const { slot, lockedEntry, open, reopened, reason } = state;
    if (!open && lockedEntry) {
      const winnerKey = lockedEntry.winner ?? lockedEntry.variant ?? slot.baseline;
      results.push({
        slotId: slot.slotId,
        ruleId: slot.ruleId,
        baseline: slot.baseline,
        variants: slot.variants,
        status: 'locked',
        reopened: false,
        reason,
        measured: true,
        winner: winnerKey,
        model: lockedEntry.model ?? resolvedModel,
        harness: lockedEntry.harness ?? harness,
        dR: Number(lockedEntry.dR ?? 0),
        dC: Number(lockedEntry.dC ?? 0),
        n: Number(lockedEntry.n ?? 0),
        p: Number(lockedEntry.p ?? 1),
      });
      continue;
    }

    const baseArm = variantArmName(slot.slotId, slot.baseline);
    const baseRecs = allEvaluated.filter((r) => r.arm === baseArm);
    const baseSummary = summarizeEvaluated(baseRecs);

    const candidates = [];
    for (const [key, text] of Object.entries(slot.variants)) {
      const arm = variantArmName(slot.slotId, key);
      const recs = allEvaluated.filter((r) => r.arm === arm);
      const summary = summarizeEvaluated(recs);
      const comp =
        key === slot.baseline || baseRecs.length === 0 || recs.length === 0
          ? null
          : compareArms(baseArm, baseRecs, arm, recs, { samples, seed });
      candidates.push({
        key,
        arm,
        bytes: Buffer.byteLength(text, 'utf8'),
        records: recs,
        summary,
        comparison: comp,
        escalated: escalatedArms.has(arm),
      });
    }

    const measured = baseSummary.n > 0 && candidates.every((c) => c.summary.n > 0);
    if (!measured) {
      results.push({
        slotId: slot.slotId,
        ruleId: slot.ruleId,
        baseline: slot.baseline,
        variants: slot.variants,
        status: reopened ? 'reopened' : 'unmeasured',
        reopened,
        reason,
        measured: false,
        winner: slot.baseline,
        model: resolvedModel,
        harness,
        dR: 0,
        dC: 0,
        n: 0,
        p: 1,
      });
      continue;
    }

    // Rank variants: higher R (beyond tolerance), then lower C, then fewer bytes, then key.
    const ranked = [...candidates].sort((a, b) => {
      if (Math.abs(b.summary.R - a.summary.R) > DEL_R_TOLERANCE) {
        return b.summary.R - a.summary.R;
      }
      if (Math.abs(a.summary.C - b.summary.C) > 1e-9) {
        return a.summary.C - b.summary.C;
      }
      if (a.bytes !== b.bytes) return a.bytes - b.bytes;
      return a.key.localeCompare(b.key);
    });

    const best = ranked[0];
    let dR = 0;
    let dC = 0;
    let n = baseSummary.n;
    let p = 1;

    if (best.key !== slot.baseline && best.comparison) {
      dR = Number(best.comparison.deltas.R.toFixed(4));
      dC = Number(best.comparison.deltas.C.toFixed(4));
      n = best.comparison.pairedTasks;
      p = Number(
        Math.min(best.comparison.mcnemar.pValue, best.comparison.wilcoxon.pValue).toFixed(4),
      );
    } else {
      const runnerUp = ranked.find((c) => c.key !== slot.baseline && c.comparison);
      if (runnerUp?.comparison) {
        n = runnerUp.comparison.pairedTasks;
      }
    }

    const lockEntry = {
      winner: best.key,
      variant: best.key,
      model: resolvedModel,
      harness,
      dR,
      dC,
      n,
      p,
    };
    nextVariantsLock[slot.slotId] = lockEntry;

    results.push({
      slotId: slot.slotId,
      ruleId: slot.ruleId,
      baseline: slot.baseline,
      variants: slot.variants,
      status: reopened ? 'reopened' : 'evaluated',
      reopened,
      reason,
      measured: true,
      ...lockEntry,
    });
  }

  let lock = null;
  if (apply && Object.keys(nextVariantsLock).length > 0) {
    lock = await writeLockVariants(resolvedRoot, nextVariantsLock);
  }

  return {
    root: resolvedRoot,
    applied: Boolean(apply),
    harness,
    model: resolvedModel,
    canarySize,
    canaryTasks: canaryTaskIds.length,
    totalTasks: taskIds.length,
    slots: results,
    variants: nextVariantsLock,
    lock,
  };
}
