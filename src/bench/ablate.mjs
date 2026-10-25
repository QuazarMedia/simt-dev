// Leave-one-out rule section ablation (`simt bench ablate`, R04).
//
// Enumerates every section of `core`, every selected stack profile, and every
// eligible process rule. Leaves one section out at a time (`no-core-<slug>`,
// `no-profile-<id>`, `no-process-<id>`), runs on a 10-task canary subset first,
// escalates significant deltas to the full suite, ranks every section by
// value per KB (`dR / kb`), and flags sections with `dR ≈ 0` and `dC > 0` as
// deletion candidates.

import { mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { MANIFEST_FILE, STATE_DIR } from '../name.mjs';
import { readManifest } from '../projection/manifest.mjs';
import { inject, parse as parseRegion } from '../projection/markers.mjs';
import { loadMdcRules, renderMdc, ruleName } from '../projection/mdc.mjs';
import { plan } from '../projection/project.mjs';
import { isEligible, loadRules, readDeclared, ruleValues, select } from '../projection/rules.mjs';
import { resolveSurfaces, rulePath, SURFACES } from '../projection/surfaces.mjs';
import { fingerprint } from '../resolve/fingerprint.mjs';
import {
  DEFAULT_BOOTSTRAP_SAMPLES,
  DEFAULT_BOOTSTRAP_SEED,
  compareArms,
  evaluateRunRecord,
  loadPrices,
  loadRunRecords,
} from './report.mjs';

export const DEFAULT_CANARY_SIZE = 10;
export const DEL_R_TOLERANCE = 0.01;
export const CANARY_ALPHA = 0.05;

export function slugifyHeading(title) {
  return String(title)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function demoteHeadings(text) {
  let fence = false;
  return text
    .split('\n')
    .map((line) => {
      if (/^(```|~~~)/.test(line)) {
        fence = !fence;
        return line;
      }
      if (fence) return line;
      return line.replace(/^(#{1,5})(?=\s)/, '$1#');
    })
    .join('\n');
}

/**
 * Split `core` rule body into its `## <Heading>` sections.
 */
export function parseCoreSections(coreBody) {
  const lines = String(coreBody ?? '').split('\n');
  const sections = [];
  let current = null;
  let fence = false;

  for (const line of lines) {
    if (/^(```|~~~)/.test(line)) {
      fence = !fence;
    }
    const m = !fence ? /^##\s+(.+?)\s*$/.exec(line) : null;
    if (m) {
      if (current) sections.push(current);
      current = { title: m[1].trim(), lines: [line] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) sections.push(current);

  return sections.map((sec) => {
    const raw = sec.lines.join('\n').trim();
    const rendered = demoteHeadings(raw).trim();
    const slug = slugifyHeading(sec.title);
    const bytes = Buffer.byteLength(rendered, 'utf8');
    return {
      id: `core:${slug}`,
      arm: `no-core-${slug}`,
      kind: 'core',
      targetId: slug,
      title: sec.title,
      bytes,
      kb: bytes / 1024,
    };
  });
}

/**
 * Discover every ablatable section for `root`:
 *   1. Each `##` section of `core` (`core:<slug>`)
 *   2. Each stack profile (`profile:<id>`)
 *   3. Each process rule (`process:<id>`)
 */
export async function listAblationSections(root, { includeAll = false } = {}) {
  const resolvedRoot = resolve(root);
  const [{ stack, facts, manifest }, allRules, mdcRules, declared] = await Promise.all([
    fingerprint(resolvedRoot),
    loadRules(resolvedRoot),
    loadMdcRules(),
    readDeclared(resolvedRoot),
  ]);

  const signals = new Set([...(stack ?? []), ...(facts ?? [])]);
  const { selected } = select(allRules, stack ?? [], facts ?? []);
  const resolvedSurfaces = resolveSurfaces(manifest, {});

  const sections = [];

  // 1. Core sections
  const coreRule = allRules.find((r) => r.id === 'core');
  if (coreRule) {
    sections.push(...parseCoreSections(coreRule.body));
  }

  // 2. Stack profiles
  const profileSource = includeAll
    ? allRules.filter((r) => r.id && r.id !== 'core')
    : selected.filter((r) => r.id && r.id !== 'core');

  const sortedProfiles = [...profileSource].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  for (const prof of sortedProfiles) {
    const rendered = `## Stack: ${prof.id}\n\n${demoteHeadings(String(prof.body ?? '').trim()).trim()}`;
    const bytes = Buffer.byteLength(rendered, 'utf8');
    sections.push({
      id: `profile:${prof.id}`,
      arm: `no-profile-${prof.id}`,
      kind: 'profile',
      targetId: prof.id,
      title: prof.title ?? prof.id,
      bytes,
      kb: bytes / 1024,
    });
  }

  // 3. Process rules
  const processSource = includeAll
    ? mdcRules.filter((r) => r.id && r.error === null)
    : mdcRules.filter((r) => r.id && r.error === null && isEligible(r, signals, declared.optIn));

  const sortedProcess = [...processSource].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  for (const rule of sortedProcess) {
    const values = ruleValues(rule, declared.values[rule.id] ?? {}, resolvedSurfaces.surfaces);
    const { body } = renderMdc(rule, values);
    const rendered = `## Process: ${rule.id}\n\n${demoteHeadings(String(body ?? '').trim()).trim()}`;
    const bytes = Buffer.byteLength(rendered, 'utf8');
    sections.push({
      id: `process:${rule.id}`,
      arm: `no-process-${rule.id}`,
      kind: 'process',
      targetId: rule.id,
      title: rule.title ?? rule.id,
      bytes,
      kb: bytes / 1024,
    });
  }

  return sections;
}

/**
 * Parse an ablation arm name (`no-core-<slug>`, `no-profile-<id>`, `no-process-<id>`)
 * or return null when `armName` is not an ablation arm.
 */
export function parseAblationArmName(armName) {
  const s = String(armName ?? '').trim();
  if (s.startsWith('no-core-') && s.length > 'no-core-'.length) {
    const slug = s.slice('no-core-'.length);
    return {
      name: s,
      kind: 'ablate',
      base: 'current',
      ablate: { kind: 'core', targetId: slug, sectionId: `core:${slug}` },
    };
  }
  if (s.startsWith('no-profile-') && s.length > 'no-profile-'.length) {
    const id = s.slice('no-profile-'.length);
    return {
      name: s,
      kind: 'ablate',
      base: 'current',
      ablate: { kind: 'profile', targetId: id, sectionId: `profile:${id}` },
    };
  }
  if (s.startsWith('no-process-') && s.length > 'no-process-'.length) {
    const id = s.slice('no-process-'.length);
    return {
      name: s,
      kind: 'ablate',
      base: 'current',
      ablate: { kind: 'process', targetId: id, sectionId: `process:${id}` },
    };
  }
  return null;
}

/**
 * Remove a `### <Heading>` block inside `## Core` from a region body string.
 */
export function removeCoreSectionFromBody(body, targetSlug) {
  const lines = String(body ?? '').split('\n');
  const out = [];
  let inCore = false;
  let skipping = false;
  let fence = false;

  for (const line of lines) {
    if (/^(```|~~~)/.test(line)) {
      fence = !fence;
    }
    if (!fence && /^##\s+/.test(line)) {
      inCore = /^##\s+Core\s*$/.test(line);
      skipping = false;
    } else if (!fence && inCore && /^###\s+(.+?)\s*$/.test(line)) {
      const heading = /^###\s+(.+?)\s*$/.exec(line)[1];
      skipping = slugifyHeading(heading) === targetSlug;
    }
    if (!skipping) out.push(line);
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Remove a top-level `## Stack: <id>` or `## Process: <id>` block from a region body string.
 */
export function removeTopSectionFromBody(body, headingPrefix, targetId) {
  const lines = String(body ?? '').split('\n');
  const out = [];
  let skipping = false;
  let fence = false;
  const targetHeader = `## ${headingPrefix}: ${targetId}`;

  for (const line of lines) {
    if (/^(```|~~~)/.test(line)) {
      fence = !fence;
    }
    if (!fence && /^##\s+/.test(line)) {
      skipping = line.trim() === targetHeader;
    }
    if (!skipping) out.push(line);
  }

  return out
    .filter((line) => !line.startsWith(`- Stack: ${targetId} —`))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Ensure `workDir` has a full `current` projection materialised, then strip the
 * specified ablation section (`core`, `profile`, or `process`).
 */
export async function ablateSectionInWorkspace(workDir, ablate) {
  if (!ablate || typeof ablate !== 'object') return;

  // Ensure a full projection exists in `workDir` so leaving one section out is
  // well-defined even if the base commit predates adoption.
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

  const planned = await plan(workDir);
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

  const agentsPath = join(workDir, 'AGENTS.md');
  const agentsText = await readFile(agentsPath, 'utf8').catch(() => null);
  if (agentsText !== null) {
    const parsed = parseRegion(agentsText, 'html');
    if (parsed.status === 'ok') {
      let nextBody = parsed.body;
      if (ablate.kind === 'core') {
        nextBody = removeCoreSectionFromBody(nextBody, ablate.targetId);
      } else if (ablate.kind === 'profile') {
        nextBody = removeTopSectionFromBody(nextBody, 'Stack', ablate.targetId);
      } else if (ablate.kind === 'process') {
        nextBody = removeTopSectionFromBody(nextBody, 'Process', ablate.targetId);
      }
      const injected = inject(agentsText, nextBody, {
        sha: parsed.sha ?? '0000000000000000000000000000000000000000',
        sources: parsed.sources ?? [],
      });
      await writeFile(agentsPath, injected.text, 'utf8');
    }
  }

  if (ablate.kind === 'profile' || ablate.kind === 'process') {
    const names = new Set([ablate.targetId]);
    if (ablate.kind === 'process') {
      const mdc = await loadMdcRules();
      const matched = mdc.find((r) => r.id === ablate.targetId);
      if (matched) {
        const rn = ruleName(matched);
        if (rn) names.add(rn);
      }
    }
    for (const s of SURFACES) {
      if (!s.rule) continue;
      for (const name of names) {
        const rel = rulePath(s.id, name);
        if (rel) {
          await rm(join(workDir, rel), { force: true }).catch(() => {});
        }
      }
    }
  }
}

/**
 * Decide whether a canary comparison warrants escalating the section arm to the full task suite.
 */
export function shouldEscalateCanary(comparison, { alpha = CANARY_ALPHA } = {}) {
  if (!comparison || !comparison.pairedTasks) return false;
  if (comparison.mcnemar.pValue < alpha) return true;
  if (comparison.wilcoxon.pValue < alpha) return true;
  if (comparison.ci95.R[0] > 0 || comparison.ci95.R[1] < 0) return true;
  if (Math.abs(comparison.deltas.R) >= 0.2) return true;
  return false;
}

/**
 * Whether a section is a deletion candidate (`ΔR ≈ 0` or `< 0`, and `ΔC > 0`).
 */
export function isDeletionCandidate({ measured, dR, dC }, { rTolerance = DEL_R_TOLERANCE } = {}) {
  if (!measured) return false;
  return dR <= rTolerance && dC > 0;
}

function fmtSignedPct(v) {
  const sign = v > 0 ? '+' : '';
  return `${sign}${(v * 100).toFixed(1)}%`;
}

function fmtSignedUsd(v) {
  const sign = v > 0 ? '+' : '';
  return `${sign}$${v.toFixed(4)}`;
}

/**
 * Render the ablation report as a Markdown table ranked by value per KB.
 */
export function formatAblationMarkdown(report) {
  const lines = [
    '| Rank | Section | Kind | KB | Stage | Tasks | ΔR | 95% CI (ΔR) | ΔC ($) | 95% CI (ΔC) | Value / KB (ΔR/KB) | Status |',
    '| ---: | --- | --- | ---: | --- | ---: | ---: | --- | ---: | --- | ---: | --- |',
  ];

  for (const row of report.ranking) {
    const stage = !row.measured ? 'planned' : row.escalated ? 'full' : 'canary';
    const rCi = `[${fmtSignedPct(row.ci95.dR[0])}, ${fmtSignedPct(row.ci95.dR[1])}]`;
    const cCi = `[${fmtSignedUsd(row.ci95.dC[0])}, ${fmtSignedUsd(row.ci95.dC[1])}]`;
    const status = !row.measured
      ? 'UNMEASURED'
      : row.deletionCandidate
        ? 'DELETE CANDIDATE'
        : row.dR > DEL_R_TOLERANCE
          ? 'KEEP'
          : 'NEUTRAL';

    lines.push(
      `| ${row.rank} | ${row.id} | ${row.kind} | ${row.kb.toFixed(2)} | ${stage} | ${row.tasks} | ${fmtSignedPct(row.dR)} | ${rCi} | ${fmtSignedUsd(row.dC)} | ${cCi} | ${fmtSignedPct(row.valuePerKb)} | ${status} |`,
    );
  }

  return lines.join('\n');
}

/**
 * Run or summarise a leave-one-out ablation across every core section, profile and process rule.
 */
export async function ablateBench(
  root,
  {
    apply = false,
    harness = 'gold',
    model,
    reps = 1,
    canarySize = DEFAULT_CANARY_SIZE,
    includeAll = false,
    sections: customSections,
    prices: customPrices,
    samples = DEFAULT_BOOTSTRAP_SAMPLES,
    seed = DEFAULT_BOOTSTRAP_SEED,
    vaultRoot,
    runner,
  } = {},
) {
  const resolvedRoot = resolve(root);
  const sections = customSections ?? (await listAblationSections(resolvedRoot, { includeAll }));
  const prices = customPrices !== undefined ? customPrices : await loadPrices(resolvedRoot);

  // Discover mined tasks if present.
  const tasksDir = join(resolvedRoot, STATE_DIR, 'bench', 'tasks');
  let taskIds = [];
  try {
    const { readdir: rd } = await import('node:fs/promises');
    const files = (await rd(tasksDir)).filter((f) => f.endsWith('.json')).sort();
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
  const escalatedArms = new Set();

  if (apply) {
    if (taskIds.length === 0) {
      throw new Error(`no mined benchmark tasks found in ${tasksDir}; run bench mine --yes first`);
    }
    const execRunBench = runner ?? (await import('./run.mjs')).runBench;

    // 1. Run canary subset for `current` and every leave-one-out section arm.
    const allArmNames = ['current', ...sections.map((s) => s.arm)];
    await execRunBench(resolvedRoot, {
      apply: true,
      arms: allArmNames,
      harness,
      model,
      reps,
      tasks: canaryTaskIds,
      ...(vaultRoot ? { vaultRoot } : {}),
    });

    // 2. Check canary deltas and escalate only significant arms to the remaining tasks.
    if (remainingTaskIds.length > 0) {
      const canaryRecords = (await loadRunRecords(resolvedRoot)).filter(
        (rec) =>
          canaryTaskIds.includes(rec.task) &&
          (!harness || rec.harness === harness) &&
          (!model || rec.model === model),
      );
      const canaryEvaluated = canaryRecords.map((rec) => evaluateRunRecord(rec, prices));
      const currentCanary = canaryEvaluated.filter((r) => r.arm === 'current');

      for (const sec of sections) {
        const armCanary = canaryEvaluated.filter((r) => r.arm === sec.arm);
        if (currentCanary.length > 0 && armCanary.length > 0) {
          const cmp = compareArms(sec.arm, armCanary, 'current', currentCanary, { samples, seed });
          if (shouldEscalateCanary(cmp)) {
            escalatedArms.add(sec.arm);
          }
        }
      }

      if (escalatedArms.size > 0) {
        await execRunBench(resolvedRoot, {
          apply: true,
          arms: ['current', ...escalatedArms],
          harness,
          model,
          reps,
          tasks: remainingTaskIds,
          ...(vaultRoot ? { vaultRoot } : {}),
        });
      }
    }
  }

  const rawRecords = await loadRunRecords(resolvedRoot);
  const filtered = rawRecords.filter((rec) => {
    if (harness && apply && rec.harness !== harness) return false;
    if (model && rec.model !== model) return false;
    return true;
  });

  const evaluated = filtered.map((rec) => evaluateRunRecord(rec, prices));
  const byArm = new Map();
  for (const row of evaluated) {
    const list = byArm.get(row.arm) ?? [];
    list.push(row);
    byArm.set(row.arm, list);
  }

  const currentRuns = byArm.get('current') ?? [];

  const sectionEntries = sections.map((sec) => {
    const ablatedRuns = byArm.get(sec.arm) ?? [];
    if (currentRuns.length === 0 || ablatedRuns.length === 0) {
      return {
        ...sec,
        measured: false,
        escalated: false,
        tasks: 0,
        runs: 0,
        dR: 0,
        dQ: 0,
        dC: 0,
        valuePerKb: 0,
        ci95: {
          dR: [0, 0],
          dQ: [0, 0],
          dC: [0, 0],
          valuePerKb: [0, 0],
        },
        mcnemar: { statistic: 0, pValue: 1, b: 0, c: 0 },
        wilcoxon: { statistic: 0, pValue: 1, wPlus: 0, wMinus: 0 },
        deletionCandidate: false,
      };
    }

    // Pair `sec.arm` (without section) as baseline and `current` (with section) as candidate
    // so deltas represent the marginal contribution of keeping `sec`.
    const cmp = compareArms(sec.arm, ablatedRuns, 'current', currentRuns, { samples, seed });
    const dR = cmp.deltas.R;
    const dQ = cmp.deltas.Q;
    const dC = cmp.deltas.C;
    const valuePerKb = sec.kb > 0 ? dR / sec.kb : 0;
    const vCi =
      sec.kb > 0 ? [cmp.ci95.R[0] / sec.kb, cmp.ci95.R[1] / sec.kb] : [0, 0];
    const escalated =
      escalatedArms.has(sec.arm) ||
      cmp.pairedTasks > canarySize ||
      shouldEscalateCanary(cmp);
    const deletionCandidate = isDeletionCandidate({ measured: true, dR, dC });

    return {
      ...sec,
      measured: true,
      escalated,
      tasks: cmp.pairedTasks,
      runs: cmp.pairedRuns,
      dR,
      dQ,
      dC,
      valuePerKb,
      ci95: {
        dR: cmp.ci95.R,
        dQ: cmp.ci95.Q,
        dC: cmp.ci95.C,
        valuePerKb: vCi,
      },
      mcnemar: {
        statistic: cmp.mcnemar.statistic,
        pValue: cmp.mcnemar.pValue,
        b: cmp.mcnemar.b,
        c: cmp.mcnemar.c,
      },
      wilcoxon: {
        statistic: cmp.wilcoxon.statistic,
        pValue: cmp.wilcoxon.pValue,
        wPlus: cmp.wilcoxon.wPlus,
        wMinus: cmp.wilcoxon.wMinus,
      },
      deletionCandidate,
    };
  });

  const ranking = [...sectionEntries]
    .sort((a, b) => {
      if (Math.abs(b.valuePerKb - a.valuePerKb) > 1e-12) {
        return b.valuePerKb - a.valuePerKb;
      }
      if (Math.abs(a.dC - b.dC) > 1e-12) {
        return a.dC - b.dC;
      }
      return a.id.localeCompare(b.id);
    })
    .map((entry, idx) => ({
      rank: idx + 1,
      ...entry,
    }));

  const deletionCandidates = ranking
    .filter((entry) => entry.deletionCandidate)
    .map((entry) => entry.id);

  const result = {
    root: resolvedRoot,
    applied: apply,
    pricesLoaded: prices !== null,
    canarySize,
    canaryTasks: canaryTaskIds.length,
    totalTasks: taskIds.length,
    sections: sectionEntries,
    ranking,
    deletionCandidates,
  };

  const markdown = formatAblationMarkdown(result);

  if (apply) {
    const outPath = join(resolvedRoot, STATE_DIR, 'bench', 'ablation.json');
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, `${JSON.stringify({ schemaVersion: 1, ...result }, null, 2)}\n`, 'utf8');
  }

  return {
    ...result,
    markdown,
  };
}
