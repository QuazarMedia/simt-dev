// `simt skills compile [<name>]` - compile skills to Agent Skills standard, flag bodies
// over 5k tokens with a progressive-disclosure split plan, and report per-skill trigger
// recall and precision from R02 transcripts (plan 0003 R30).

import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { EXIT, emit, emitJson, fail, isJson, note, writeMode } from '../output/index.mjs';
import { loadRegistry } from '../graph/load.mjs';
import {
  BODY_TOKEN_BUDGET,
  compileSkill,
  evaluateSkillTriggers,
  proposeSkillDescription,
} from '../graph/compile.mjs';
import { loadRunRecords } from '../bench/report.mjs';
import { extractPatchFiles } from '../bench/grade.mjs';
import { resolveVaultDir } from '../bench/mine.mjs';
import { locateSource, sourceHeldLocally } from '../resolve/source.mjs';
import { nearMatches } from '../resolve/near.mjs';
import { resolveWorkspace, WORKSPACE_REMEDY } from '../workspace.mjs';
import { CLI } from '../name.mjs';
import { LOCAL_DIR } from '../state.mjs';

async function readSkillRawText(skill, workspaceRoot, root) {
  const canonical = skill.sources?.find((s) => s.role === 'canonical') ?? skill.sources?.[0];
  let full = null;
  if (canonical) {
    const found = await locateSource(canonical, { workspaceRoot, root });
    if (found.path) full = found.path;
  }
  if (!full) {
    const held = await sourceHeldLocally(skill, root, { workspaceRoot });
    if (held && !held.ambiguous) full = held.path;
  }
  if (!full || !existsSync(full)) return null;
  try {
    const target = existsSync(join(full, 'SKILL.md')) ? join(full, 'SKILL.md') : full;
    return await readFile(target, 'utf8');
  } catch {
    return null;
  }
}

async function loadGoldPathsByTask(root) {
  const map = new Map();
  const tasksDir = join(root, '.simt', 'bench', 'tasks');
  const vaultRoot = resolveVaultDir(root);
  const entries = (await readdir(tasksDir).catch(() => [])).filter((f) => f.endsWith('.json')).sort();
  for (const entry of entries) {
    try {
      const task = JSON.parse(await readFile(join(tasksDir, entry), 'utf8'));
      const patch = await readFile(join(vaultRoot, task.id, 'gold.patch'), 'utf8').catch(() => '');
      if (patch) map.set(task.id, extractPatchFiles(patch));
    } catch {
      // ignore unreadable task
    }
  }
  return map;
}

function fmtMetric(v) {
  return v === null || v === undefined ? 'n/a' : v.toFixed(3);
}

export async function compileCommand(args, flags) {
  const { registry, errors, ok } = await loadRegistry(null, flags);
  if (!ok) return fail(errors[0], EXIT.REGISTRY, WORKSPACE_REMEDY);

  const root = resolve(flags.root ?? process.cwd());
  const ws = await resolveWorkspace(flags);
  const targetName = args[0] ?? null;

  if (targetName) {
    const skill = registry.skills.find((s) => s.name === targetName);
    if (!skill) {
      const near = nearMatches(targetName, registry.skills.map((s) => s.name));
      return fail(
        `no skill named "${targetName}"${near.length ? ` (did you mean ${near.join(', ')}?)` : ''}`,
        EXIT.USAGE,
        `run: ${CLI} skills find <query>`,
      );
    }
    return runSingleSkillCompile(skill, registry, { root, workspaceRoot: ws.root, flags });
  }

  const [runs, goldPathsByTask] = await Promise.all([
    loadRunRecords(root),
    loadGoldPathsByTask(root),
  ]);

  const bodiesBySkill = new Map();
  for (const skill of registry.skills) {
    const raw = await readSkillRawText(skill, ws.root, root);
    if (raw) bodiesBySkill.set(skill.name, raw);
  }

  const report = evaluateSkillTriggers(registry, runs, { bodiesBySkill, goldPathsByTask });
  const flagged = report.skills.filter((s) => s.flagged);

  if (isJson(flags)) {
    emitJson(
      {
        ok: true,
        command: 'skills compile',
        root,
        tokenBudget: BODY_TOKEN_BUDGET,
        runCount: report.runCount,
        skillCount: report.skillCount,
        flaggedCount: report.flaggedCount,
        skills: report.skills,
        flagged: flagged.map((s) => ({
          name: s.name,
          bytes: s.bytes,
          tokens: s.tokens,
          splitPlan: s.splitPlan,
        })),
      },
      { maxBytes: flags.maxBytes ?? 0 },
    );
    return EXIT.OK;
  }

  const lines = [
    `skills   ${report.skillCount} total, ${report.flaggedCount} over ${BODY_TOKEN_BUDGET} tokens (flagged with split plan)`,
    `runs     ${report.runCount} benchmark run(s) in ${root}`,
    '',
    'TRIGGER REPORT',
    'name                          tokens  exp  open  recall  precision  split',
    ...report.skills.map((s) => {
      const name = s.name.padEnd(28);
      const tok = String(s.tokens).padStart(6);
      const exp = String(s.expected).padStart(4);
      const opn = String(s.opened).padStart(5);
      const rec = fmtMetric(s.recall).padStart(7);
      const prec = fmtMetric(s.precision).padStart(10);
      const split = s.flagged ? `SPLIT (${s.splitPlan.references.length} refs)` : 'ok';
      return `${name} ${tok} ${exp} ${opn} ${rec} ${prec}  ${split}`;
    }),
  ];

  if (flagged.length > 0) {
    lines.push('', `SPLIT PLANS (${flagged.length} over ${BODY_TOKEN_BUDGET} tokens)`);
    for (const s of flagged) {
      const refs = s.splitPlan.references.map((r) => `${r.path} (~${r.tokens}t)`).join(', ');
      lines.push(
        `  ${s.name.padEnd(26)} ~${s.tokens}t (${s.bytes} B) -> SKILL.md (~${s.splitPlan.mainTokens}t) + ${s.splitPlan.references.length} ref(s): ${refs}`,
      );
    }
  }

  emit(lines.join('\n'), { maxBytes: flags.maxBytes ?? 0 });
  return EXIT.OK;
}

async function runSingleSkillCompile(skill, registry, { root, workspaceRoot, flags }) {
  const mode = writeMode(flags);
  const [rawText, runs, goldPathsByTask] = await Promise.all([
    readSkillRawText(skill, workspaceRoot, root),
    loadRunRecords(root),
    loadGoldPathsByTask(root),
  ]);

  const bodiesBySkill = new Map();
  if (rawText) bodiesBySkill.set(skill.name, rawText);

  const triggerReport = evaluateSkillTriggers(registry, runs, { bodiesBySkill, goldPathsByTask });
  const triggerStats = triggerReport.skills.find((s) => s.name === skill.name) ?? null;
  const compiled = compileSkill(skill, rawText);
  const proposal = await proposeSkillDescription(skill, {
    currentDescription: compiled.description,
    triggerStats,
  });

  const outDir = join(root, LOCAL_DIR, 'compiled', 'skills', skill.name);
  const proposalPath = join(root, LOCAL_DIR, 'proposals', 'skills', `${skill.name}.json`);
  const writtenFiles = [];

  if (mode.apply) {
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, 'SKILL.md'), compiled.mainText, 'utf8');
    writtenFiles.push(`${LOCAL_DIR}/compiled/skills/${skill.name}/SKILL.md`);

    for (const ref of compiled.references) {
      if (!ref.content) continue;
      const refFull = join(outDir, ref.path);
      await mkdir(dirname(refFull), { recursive: true });
      await writeFile(refFull, ref.content, 'utf8');
      writtenFiles.push(`${LOCAL_DIR}/compiled/skills/${skill.name}/${ref.path}`);
    }

    await mkdir(dirname(proposalPath), { recursive: true });
    await writeFile(proposalPath, `${JSON.stringify(proposal, null, 2)}\n`, 'utf8');
    writtenFiles.push(`${LOCAL_DIR}/proposals/skills/${skill.name}.json`);
  }

  if (isJson(flags)) {
    emitJson(
      {
        ok: true,
        command: 'skills compile',
        root,
        skill: skill.name,
        dryRun: mode.dryRun,
        written: mode.apply,
        files: writtenFiles,
        description: compiled.description,
        mainBytes: compiled.mainBytes,
        mainTokens: compiled.mainTokens,
        conformance: compiled.conformance,
        splitPlan: compiled.splitPlan,
        trigger: triggerStats
          ? {
              expected: triggerStats.expected,
              opened: triggerStats.opened,
              tp: triggerStats.tp,
              fp: triggerStats.fp,
              fn: triggerStats.fn,
              recall: triggerStats.recall,
              precision: triggerStats.precision,
            }
          : null,
        proposal,
      },
      { maxBytes: flags.maxBytes ?? 0 },
    );
    return EXIT.OK;
  }

  const lines = [
    `compile     ${skill.name}`,
    `mode        ${mode.apply ? 'applied' : mode.dryRun ? 'dry-run (writes nothing)' : `preview (pass --yes to write compiled skill)`}`,
    `source      ${rawText ? 'body on disk' : 'registry metadata'}`,
    `tokens      ~${compiled.splitPlan.totalTokens} (${compiled.splitPlan.totalBytes} bytes)`,
    `split       ${compiled.splitPlan.flagged ? `flagged (${compiled.splitPlan.reason}) -> SKILL.md (~${compiled.splitPlan.mainTokens}t) + ${compiled.splitPlan.references.length} reference(s)` : 'within 5000-token budget'}`,
    `conformance ${compiled.conformance.errors.length === 0 ? 'pass' : `fail (${compiled.conformance.errors.length})`}`,
    `trigger     expected=${triggerStats?.expected ?? 0}  opened=${triggerStats?.opened ?? 0}  recall=${fmtMetric(triggerStats?.recall)}  precision=${fmtMetric(triggerStats?.precision)}`,
    `proposal    ${proposal.provenance.model} (${proposal.provenance.digest})`,
  ];

  if (compiled.splitPlan.references.length > 0) {
    lines.push('', 'REFERENCES');
    for (const ref of compiled.splitPlan.references) {
      lines.push(`  ${ref.path.padEnd(36)} ~${String(ref.tokens).padStart(5)}t  (${ref.bytes} B)  ${ref.title}`);
    }
  }

  emit(lines.join('\n'), { maxBytes: flags.maxBytes ?? 0 });
  if (!mode.apply) {
    note(`note    dry-run  nothing written; apply with: ${CLI} skills compile ${skill.name} --yes`);
  }
  return EXIT.OK;
}
