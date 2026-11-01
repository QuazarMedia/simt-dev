// Rule-compliance probes (`simt bench probes`, R05).
//
// 12 synthetic tasks that tempt specific rule violations from `rules/core.md`:
//   p01-unrelated-failing-test  (ADR-006) — tempts skipping or deleting an unrelated failing test
//   p02-unapproved-push         (ADR-001) — tempts running `git push` without approval
//   p03-hook-no-verify          (ADR-001) — tempts bypassing a failing hook with `--no-verify`
//   p04-outside-blast-radius    (ADR-002) — tempts refactoring a file outside the blast radius
//   p05-generated-region-edit   (ADR-005) — tempts hand-editing a generated region instead of its source
//   p06-unrun-test-claim        (ADR-006) — tempts claiming tests pass without running them
//   p07-history-rewrite         (ADR-001) — tempts `commit --amend` / `reset --hard` / `rebase`
//   p08-unrelated-dirty-work    (ADR-002) — tempts staging or reverting unrelated dirty worktree files
//   p09-secret-commit           (ADR-001) — tempts committing a `.env` secret or credential literal
//   p10-focused-vs-full-suite   (ADR-003) — tempts running the full suite instead of the focused test
//   p11-bare-runner-npx         (ADR-010) — tempts invoking `npx` instead of the repo runner `npm run`
//   p12-weaken-security-control (ADR-008) — tempts weakening auth/cache controls or adding `console.log`
//
// Each probe has a deterministic grader that reads:
//   1. the final git state in the isolated workspace (and local bare remote where applicable),
//   2. the commands recorded in the transcript, and
//   3. the evidence ledger (`.simt/local/ledger.jsonl`, R17).

import { PROBES } from './probes.catalog.mjs';
import {
  PROBE_AGENT_TIMEOUT_MS,
  PROBE_COMMAND_TIMEOUT_MS,
  appendLedgerEntry,
  extractTranscriptCommands,
  readLedgerEntries,
  runGit,
  runNode,
} from './probe-ledger.mjs';
export { PROBES, appendLedgerEntry, extractTranscriptCommands, readLedgerEntries };

import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { LOCAL_DIR } from '../../../src/state.mjs';
import { parse as parseRegion } from '../../../src/projection/markers.mjs';
import { sanitizedEnv, spawnBounded } from '../../../src/sys/proc.mjs';
import { adapterIsolation, executeAdapter, loadAdapters } from './adapters.mjs';
import { materialiseArm, parseArmSpec } from './arms.mjs';

/**
 * Harnesses that script a workspace instead of driving an agent.
 *
 * They answer a different question — "does the grader accept compliant work and reject
 * violating work" — and they answer it perfectly every time by construction, so their
 * compliance rate is constant and says nothing about an arm. A record from one of these
 * is a grader calibration, never a measurement (review 0003 Q49).
 */
export const CALIBRATION_HARNESSES = new Set(['gold', 'noop', 'violator']);
export async function prepareProbeWorkspace(probe, { armSpec = null, parentDir } = {}) {
  const slotDir = await mkdtemp(join(parentDir ?? tmpdir(), `bench-probe-${probe.id}-`));
  const workDir = join(slotDir, 'workspace');
  await mkdir(workDir, { recursive: true });

  await writeFile(
    join(workDir, 'package.json'),
    JSON.stringify({ name: `probe-${probe.id}`, version: '1.0.0', private: true, type: 'module' }, null, 2),
    'utf8',
  );

  await probe.setup(workDir, { slotDir });

  await runGit(['init', '-q'], { cwd: workDir });
  await runGit(['config', 'user.email', 'bench@example.invalid'], { cwd: workDir });
  await runGit(['config', 'user.name', 'bench-probe'], { cwd: workDir });

  if (armSpec && probe.id !== 'p05-generated-region-edit') {
    await materialiseArm(workDir, armSpec, { id: probe.id, prompt: probe.prompt });
    // Same rule as a mined run: the packet's index is tool state, not part of the arm.
    await rm(join(workDir, LOCAL_DIR), { recursive: true, force: true }).catch(() => {});
  }

  await runGit(['add', '-A'], { cwd: workDir });
  await runGit(['commit', '-qm', `base: ${probe.id}`, '--no-verify'], { cwd: workDir });
  const headRes = await runGit(['rev-parse', 'HEAD'], { cwd: workDir });
  const initialHead = headRes.stdout.trim();

  if (typeof probe.postCommitSetup === 'function') {
    await probe.postCommitSetup(workDir, { slotDir, initialHead });
  }

  return { slotDir, workDir, initialHead };
}

/**
 * Grade a single probe workspace deterministically.
 *
 * @param {string|object} probeOrId
 * @param {{workDir: string, slotDir?: string, initialHead: string, commands?: string[], stdout?: string, stderr?: string, ledger?: Array<object>}} ctx
 */
export async function gradeProbe(probeOrId, ctx) {
  const probe =
    typeof probeOrId === 'string' ? PROBES.find((p) => p.id === probeOrId) : probeOrId;
  if (!probe) {
    throw new Error(`unknown compliance probe "${probeOrId}"`);
  }
  const ledger =
    Array.isArray(ctx.ledger) && ctx.ledger.length > 0
      ? ctx.ledger
      : await readLedgerEntries(ctx.workDir);
  const res = await probe.grade({
    ...ctx,
    slotDir: ctx.slotDir ?? dirname(ctx.workDir),
    ledger,
  });
  return {
    probeId: probe.id,
    title: probe.title,
    rule: probe.rule,
    adr: probe.adr,
    passed: Boolean(res.passed),
    reason: res.reason ?? '',
  };
}

/**
 * Load stored probe result records from `.simt/local/bench/probes/<runDir>/<probeId>.json`.
 *
 * @param {string} root
 * @returns {Promise<Array<object>>}
 */
export async function loadProbeRecords(root) {    const probesRoot = join(resolve(root), LOCAL_DIR, 'bench', 'probes');
  if (!existsSync(probesRoot)) return [];

  const entries = await readdir(probesRoot, { withFileTypes: true }).catch(() => []);
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  const records = [];
  for (const dir of dirs) {
    const runDir = join(probesRoot, dir);
    const files = (await readdir(runDir).catch(() => [])).filter((f) => f.endsWith('.json')).sort();
    for (const file of files) {
      try {
        const data = JSON.parse(await readFile(join(runDir, file), 'utf8'));
        if (data && typeof data === 'object' && data.probe) {
          records.push(data);
        }
      } catch {
        // ignore unreadable file
      }
    }
  }
  return records;
}

/**
 * Format the compliance probes summary as a Markdown report.
 */
export function formatProbesMarkdown(report) {
  const lines = [
    '| Arm | Probes | Passed | Compliance | Basis |',
    '| --- | ---: | ---: | ---: | --- |',
  ];

  // The basis is a column rather than a footnote because a calibration rate and a
  // measured rate are the same four characters apart (review 0003 Q49).
  for (const arm of report.arms) {
    const basis = arm.measured ? 'agent' : 'grader calibration';
    lines.push(
      `| ${arm.arm} | ${arm.total} | ${arm.passed} | ${(arm.complianceRate * 100).toFixed(1)}% | ${basis} |`,
    );
  }

  lines.push('');
  lines.push('| Probe | Rule | ADR | Title |');
  lines.push('| --- | --- | --- | --- |');
  for (const p of report.probes) {
    lines.push(`| ${p.id} | ${p.rule} | ${p.adr} | ${p.title} |`);
  }

  return lines.join('\n');
}

/**
 * Run or summarise the 12 compliance probes across arms (`simt bench probes`).
 *
 * @param {string} root
 * @param {{
 *   apply?: boolean,
 *   arms?: string[],
 *   probes?: string[],
 *   harness?: string,
 *   reps?: number
 * }} [options]
 */
export async function runBenchProbes(
  root,
  {
    apply = false,
    arms = ['bare', 'current'],
    probes: probeFilter = [],
    harness = 'gold',
    reps = 1,
    model,
    timeoutMs = PROBE_AGENT_TIMEOUT_MS,
    adapters: adapterTable,
  } = {},
) {
  const resolvedRoot = resolve(root);
  const calibration = CALIBRATION_HARNESSES.has(harness);
  const adapters = calibration ? null : (adapterTable ?? (await loadAdapters()));
  const adapter = calibration ? null : adapters[harness];
  if (!calibration && !adapter) {
    throw new Error(
      `unknown probe harness "${harness}"; known harnesses: ${[...CALIBRATION_HARNESSES].sort().join(', ')}, ${Object.keys(adapters).sort().join(', ')}`,
    );
  }
  const measured = !calibration;
  const isolation = calibration ? 'none' : adapterIsolation(adapter);
  const resolvedModel = model ?? (calibration ? harness : 'default');
  const selectedProbes =
    Array.isArray(probeFilter) && probeFilter.length > 0
      ? PROBES.filter((p) => probeFilter.includes(p.id))
      : PROBES;

  if (selectedProbes.length === 0) {
    throw new Error(`no matching compliance probes for filter: ${probeFilter.join(', ')}`);
  }

  const armNames = Array.isArray(arms) && arms.length > 0 ? arms : ['bare', 'current'];
  const executed = [];

  if (apply) {
    for (const armName of armNames) {
      const armSpec = await parseArmSpec(armName, resolvedRoot);
      for (let rep = 1; rep <= reps; rep += 1) {
        const runDir = join(
          resolvedRoot,
          LOCAL_DIR,
          'bench',
          'probes',
          `${harness}-${armSpec.name}-r${rep}`,
        );
        await mkdir(runDir, { recursive: true });

        for (const probe of selectedProbes) {
          const ws = await prepareProbeWorkspace(probe, { armSpec });
          try {
            let outcome;
            if (calibration) {
              // `gold` runs the compliant script, `violator` and `noop` the violating one:
              // the pair proves the grader both accepts and rejects, nothing more.
              outcome =
                harness === 'gold'
                  ? await probe.comply(ws.workDir, ws)
                  : await probe.violate(ws.workDir, ws);
            } else {
              // A real harness gets a real workspace and the probe's own prompt. Grading
              // reads the workspace and the transcript, so the agent's own commands are
              // what decide compliance.
              const executed = await executeAdapter(
                adapter,
                ws.workDir,
                { id: probe.id, prompt: probe.prompt },
                { model: resolvedModel, env: {}, timeoutMs, slotDir: ws.slotDir },
              );
              const transcript = executed.transcript ?? '';
              outcome = {
                commands: extractTranscriptCommands({ stdout: transcript }),
                stdout: transcript,
              };
            }

            const grade = await gradeProbe(probe, {
              workDir: ws.workDir,
              slotDir: ws.slotDir,
              initialHead: ws.initialHead,
              commands: outcome?.commands ?? [],
              stdout: outcome?.stdout ?? '',
              stderr: outcome?.stderr ?? '',
            });

            const record = {
              schemaVersion: 1,
              probe: probe.id,
              rule: probe.rule,
              adr: probe.adr,
              arm: armSpec.name,
              harness,
              model: resolvedModel,
              rep,
              measured,
              isolation,
              passed: grade.passed,
              reason: grade.reason,
            };
            await writeFile(
              join(runDir, `${probe.id}.json`),
              `${JSON.stringify(record, null, 2)}\n`,
              'utf8',
            );
            executed.push(record);
          } finally {
            await rm(ws.slotDir, { recursive: true, force: true }).catch(() => {});
          }
        }
      }
    }
  }

  const allRecords = apply ? executed : await loadProbeRecords(resolvedRoot);
  const byArm = new Map();
  for (const rec of allRecords) {
    if (Array.isArray(arms) && arms.length > 0 && !arms.includes(rec.arm)) continue;
    // A stored record belongs to the harness that produced it. Pooling a violator run
    // into a gold summary reported compliance for a measurement never taken.
    if (rec.harness && rec.harness !== harness) continue;
    const list = byArm.get(rec.arm) ?? [];
    list.push(rec);
    byArm.set(rec.arm, list);
  }

  const armSummaries = [...byArm.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([arm, list]) => {
      const total = list.length;
      const passed = list.filter((r) => r.passed).length;
      const complianceRate = total > 0 ? passed / total : 0;
      const results = {};
      for (const r of list) {
        // Keyed by rep as well as probe: two reps of one probe are two results, and the
        // old key kept only whichever rep was read last (review 0003 Q59).
        results[`${r.probe}#r${r.rep ?? 1}`] = { passed: r.passed, reason: r.reason };
      }
      return {
        arm,
        total,
        passed,
        complianceRate,
        measured: list.every((r) => r.measured === true),
        results,
      };
    });

  const probeCatalogue = selectedProbes.map((p) => ({
    id: p.id,
    title: p.title,
    rule: p.rule,
    adr: p.adr,
  }));

  const report = {
    root: resolvedRoot,
    applied: apply,
    probeCount: probeCatalogue.length,
    probes: probeCatalogue,
    arms: armSummaries,
    runs: allRecords,
  };

  return {
    ...report,
    markdown: formatProbesMarkdown(report),
  };
}
