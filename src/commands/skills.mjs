// `simt skills` - tier 0 (index), tier 1 (brief), tier 2 (show), plus find/why.
//
// Implementation sequence steps 4 and 5.
//
// Output design (plan 0002 section 6): one fact per line, fixed field order, no
// wrapping, no ANSI on any stream, bounded by --max-bytes with an explicit
// TRUNCATED line. The NOT SELECTED block is as important as the resolved block -
// the agent can see what exists and why it was excluded, and override in one
// token instead of guessing. Suppressing it is how a discovery tool becomes a
// black box.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

import { EXIT, emit, emitJson, fail, isJson, note as emitNote } from '../output/index.mjs';
import { loadRegistry } from '../graph/load.mjs';
import { bodyFile, sourcePath } from '../resolve/body.mjs';
import { unknownSkills, scoreCorpus } from '../resolve/eval.mjs';
import { PACKAGE_ROOT, resolveWorkspace, WORKSPACE_REMEDY } from '../workspace.mjs';
import { fingerprint } from '../resolve/fingerprint.mjs';
import { tokenize, rankSkills, closure, selectWithinBudget, resolveAlias, scoreSkill, selectionVerdict, stackCompatible } from '../resolve/resolve.mjs';
import { nearMatches } from '../resolve/near.mjs';
import { CLI } from '../name.mjs';
import { parsePathList } from '../argv.mjs';

export { parsePathList };

const DEFAULT_BUDGET = 20480;

/** git status paths, so path signals come from the real diff. */
export async function dirtyPaths(root) {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const { stdout } = await run('git', ['-C', root, 'status', '--porcelain=v1'], { maxBuffer: 8 << 20 });
    return stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => line.slice(3).trim())
      .filter((p) => !p.includes(' -> '));
  } catch {
    return [];
  }
}

export function listFlag(value) {
  return (Array.isArray(value) ? value : [value])
    .flatMap((v) => parsePathList(v))
    .filter(Boolean);
}

// --- cores: one computation for the CLI and the MCP tools (Q15) ----------------
//
// `skills_brief`, `skills_find`, `skills_show` and `skills_why` in the MCP
// surface used to rebuild these answers from the same modules with different
// loops, and the copies had already drifted: the budget loop inlined a deferred
// dependency on one surface and not the other, and the payloads disagreed on
// field names (`resolved`/`selected`, `reasons`/`why`, `signals`). The commands
// below render these facts for terminals; the tools return them as JSON. The
// CLI keeps its field names; the tools adopt them.
//
// A core throws when it cannot answer: the message names the problem, `remedy`
// names the next command, and `exitCode` is the exit the CLI leaves with. The
// MCP handler turns the same throw into an error result, so both surfaces
// report the same failure for the same cause.
function skillsFailure(message, remedy, exitCode) {
  throw Object.assign(new Error(message), { remedy, exitCode });
}

async function skillsRegistry(args) {
  const { registry, errors, ok } = await loadRegistry(null, args);
  if (!ok) skillsFailure(errors[0], WORKSPACE_REMEDY, EXIT.REGISTRY);
  return registry;
}

function findSkill(registry, name, verb) {
  if (!name) skillsFailure(`${verb} needs a skill name`, `usage: ${CLI} skills ${verb} <name>`, EXIT.USAGE);
  const skill = registry.skills.find((s) => s.name === name);
  if (!skill) {
    const near = nearMatches(name, registry.skills.map((s) => s.name));
    skillsFailure(
      `no skill named "${name}"${near.length ? ` (did you mean ${near.join(', ')}?)` : ''}`,
      `run: ${CLI} skills find <query>`,
      EXIT.USAGE,
    );
  }
  return skill;
}

/** The JSON-safe skill facts both surfaces spread: absent lists read as empty, not missing. */
function skillFacts(skill) {
  return {
    ...skill,
    capabilities: skill.capabilities ?? [],
    stack: skill.stack ?? [],
    keywords: skill.keywords ?? [],
    requires: skill.requires ?? [],
    variants: skill.variants ?? [],
    aliasOf: skill.aliasOf ?? null,
    variantOf: skill.variantOf ?? null,
  };
}

/** Tier 1: the selection the task resolves to, with the text packet's display sets. */
export async function skillsBriefFacts(root, args = {}) {
  const registry = await skillsRegistry(args);
  const repo = await fingerprint(root);
  const { note: workspace, root: workspaceRoot } = await announceWorkspace(args);
  const repoStack = repo.signals;
  const paths = args.paths ? parsePathList(args.paths) : await dirtyPaths(root);
  const taskTokens = tokenize(args.task ?? '');
  const forced = listFlag(args.skill);
  const budget = args.budget ?? DEFAULT_BUDGET;
  const task = args.task ?? null;
  const repoFacts = { root, stack: repoStack, facts: repo.facts };

  // A brief with no task and no paths resolves on stack alone, which produces a
  // plausible-looking list the agent may act on. It warns rather than silently
  // answering; under `--json` the warning is a field, not prose on stdout.
  if (!args.task && paths.length === 0 && forced.length === 0) {
    const warning =
      'no --task and no staged files, so selection can only use the repo signals. ' +
      'pass --task "<what you are doing>" or stage files so the diff drives selection, ' +
      'or pass --all to take everything for this stack.';
    if (args.all) {
      const usable = registry.skills.filter((s) => stackCompatible(s, repoStack));
      return {
        kind: 'all',
        repoStack,
        inline: usable.filter((s) => !s.deferred),
        deferred: usable.filter((s) => s.deferred),
        warning,
      };
    }
    return {
      kind: 'brief',
      repo: repoFacts,
      workspace,
      task,
      budget,
      inlineBytes: 0,
      resolved: [],
      deferred: [],
      excluded: [],
      shown: [],
      shownDeferred: [],
      shownUsed: 0,
      pointerOnly: false,
      warning,
    };
  }

  const context = { repoStack, taskTokens, paths };
  const { selected, excluded } = rankSkills(registry.skills, context, { forced });

  // Hard dependencies are pulled in even when they did not score, and even past
  // budget: a skill that is useless without its dependency is worse than a large
  // context, because it silently misleads.
  const expanded = closure(selected, registry.skills);
  const { picked, deferred, used: inlineBytes } = selectWithinBudget(expanded, {
    budget,
    all: args.all === true,
  });
  const closureNames = new Set(expanded.map((e) => e.skill.name));

  const plain = (entry) => ({
    name: entry.skill.name,
    bytes: entry.skill.bytes,
    summary: entry.skill.summary,
    why: [...entry.reasons, ...[...entry.via].map((v) => `requires:${v}`)],
  });
  // A body the packet cannot paste costs nothing. Charging the catalogue size
  // is how a brief with no workspace reports "budget capped" and then prints
  // the same remedy once per skill.
  const readable = new Set();
  for (const entry of expanded) {
    if (await bodyReadable(entry.skill, workspaceRoot, root)) readable.add(entry.skill.name);
  }
  const pointerOnly = expanded.length > 0 && readable.size === 0;

  let shown = picked;
  let shownDeferred = deferred;
  let shownUsed = inlineBytes;
  if (pointerOnly) {
    const priced = expanded.map((e) =>
      e.skill.deferred ? e : { ...e, skill: { ...e.skill, bytes: 0 } },
    );
    const again = selectWithinBudget(priced, { budget, all: args.all === true });
    shown = again.picked;
    shownDeferred = again.deferred;
    shownUsed = again.used;
  }

  return {
    kind: 'brief',
    repo: repoFacts,
    workspace,
    workspaceRoot,
    task,
    budget,
    inlineBytes,
    resolved: picked.map(plain),
    deferred: deferred.map((e) => ({
      name: e.skill.name,
      bytes: e.skill.bytes,
      reason: e.skill.deferred ? 'marked deferred' : 'over budget',
    })),
    excluded: excluded.filter((e) => !closureNames.has(e.skill.name)).map((e) => ({ name: e.skill.name, reason: e.reason })),
    shown,
    shownDeferred,
    shownUsed,
    pointerOnly,
    excludedEntries: excluded.filter((e) => !closureNames.has(e.skill.name)),
  };
}

/** Raw search across capability, keyword and summary. */
export async function skillsFindFacts(query, args = {}) {
  const q = String(query ?? '').trim();
  if (!q) skillsFailure('find needs a query', `usage: ${CLI} skills find <query>`, EXIT.USAGE);
  const registry = await skillsRegistry(args);
  const tokens = tokenize(q);
  const results = registry.skills
    .map((skill) => ({ skill, ...scoreSkill(skill, { repoStack: [], taskTokens: tokens, paths: [] }) }))
    .filter((r) => selectionVerdict(r.evidence, r.reasons) === null)
    .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name));
  return {
    query: q,
    results: results.map((r) => ({ name: r.skill.name, score: r.score, summary: r.skill.summary, reasons: r.reasons })),
  };
}

/** Tier 2: one skill body and the metadata needed to judge it. */
export async function skillsShowFacts(root, name, args = {}) {
  const registry = await skillsRegistry(args);
  const skill = findSkill(registry, name, 'show');
  const { note: workspace, root: workspaceRoot } = await announceWorkspace(args);
  // The repo is a location for a declared source too, so `show` reads a body the
  // caller already has instead of reporting the body missing.
  const body = await sourcePath(skill, workspaceRoot, root);
  const bodyFrom = body === null ? 'none' : body.startsWith(`${root}/`) ? 'repo' : 'workspace';
  return {
    skill: skillFacts(skill),
    workspace,
    body,
    bodyFrom,
    bodyText: await readBody(skill, workspaceRoot, root),
  };
}

/** The signal chain for one skill in one repository. */
export async function skillsWhyFacts(root, name, args = {}) {
  const registry = await skillsRegistry(args);
  const skill = findSkill(registry, name, 'why');
  const repo = await fingerprint(root);
  const paths = args.paths ? parsePathList(args.paths) : await dirtyPaths(root);
  const tokens = tokenize(args.task ?? '');
  const { score, reasons } = scoreSkill(skill, { repoStack: repo.signals, taskTokens: tokens, paths });
  const compatible = stackCompatible(skill, repo.signals);
  const ws = await resolveWorkspace(args);
  return {
    skill: skill.name,
    score,
    compatible,
    gate: compatible ? 'pass' : 'fail',
    repo: { root, stack: repo.stack, facts: repo.facts, evidence: repo.evidence },
    workspace: { root: ws.root ?? null, source: ws.source, detail: ws.detail },
    paths: paths.slice(0, 8),
    taskTokens: tokens,
    signals: reasons,
    variants: (skill.variants ?? []).map((v) => ({ id: v.id, stack: v.stack, bytes: v.bytes })),
    aliasOf: skill.aliasOf ?? null,
    variantOf: skill.variantOf ?? null,
    requires: skill.requires ?? [],
  };
}

/** Compact stack label: the tags that actually discriminate, not all of them. */
function stackLabel(tags = []) {
  const DISCRIMINATING = [
    'cloudflare-workers',
    'connectiq',
    'gradle',
    'wear-os',
    'react',
    'react-router',
    'typescript',
    'python',
    'less',
    'hono',
    'firebase',
    'maplibre',
    'vitest',
    'playwright',
  ];
  const kept = tags.filter((t) => DISCRIMINATING.includes(t));
  return (kept.length > 0 ? kept : tags).slice(0, 2).join('+') || '-';
}

const kb = (bytes) => `${(bytes / 1000).toFixed(1)}k`;

// --- tier 0: index ------------------------------------------------------------

export async function indexCommand(args, flags) {
  const { registry, errors, ok } = await loadRegistry(null, flags);
  if (!ok) return fail(errors[0], EXIT.REGISTRY, WORKSPACE_REMEDY);
  const workspace = await workspaceLine(flags);

  if (isJson(flags)) {
    emitJson(
      {
                ok: true,
                workspace,
                skills: registry.skills.map((s) => ({
                  name: s.name,
                  summary: s.summary,
                  capabilities: s.capabilities,
                  stack: s.stack,
                  bytes: s.bytes,
                  deferred: Boolean(s.deferred),
                })),
              },
    );
    return EXIT.OK;
  }

  // Fixed field order, name-sorted: the output is diffable across releases, so
  // an agent can tell what changed in the catalogue between two runs.
  const rows = [...registry.skills]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((s) => {
      const name = s.name.padEnd(26);
      const bytes = kb(s.bytes).padStart(7);
      const stack = stackLabel(s.stack).padEnd(22);
      return `${name} ${bytes} ${stack} ${s.summary}${s.deferred ? ' [deferred]' : ''}`;
    });

  // Total body bytes, and the subset tier 0 actually costs an agent: a deferred
  // skill costs one line here and nothing more until it is fetched. That gap is
  // the whole argument for progressive disclosure, so it is printed.
  const total = registry.skills.reduce((n, s) => n + s.bytes, 0);
  const deferredCount = registry.skills.filter((s) => s.deferred).length;
  emit(
    [
      `${registry.skills.length} skills, ${kb(total)} total, ${deferredCount} deferred`,
      workspace,
      '',
      'name                          bytes    stack                  summary',
      ...rows,
      '',
      `deferred entries return a pointer, not a body. Fetch one with: ${CLI} skills show <name>`,
    ].join('\n'),
    { maxBytes: flags.maxBytes ?? 0 },
  );
  return EXIT.OK;
}

/**
 * Header label. Platform tags are named; facts are counted, because a repo can
 * easily carry a dozen of them and the count is what tells the reader the gate
 * had more to work with than the stack alone (ADR-013).
 */
function repoLine(repo) {
  const stack = repo.stack.length > 0 ? repo.stack.join(',') : 'undetected';
  return repo.facts.length > 0 ? `${stack} +${repo.facts.length} facts` : stack;
}

/** `--all` with no other signal: everything this stack can use, deferred excluded. */
async function emitAllFacts(facts, flags) {
  const { inline, deferred, repoStack, warning } = facts;

  if (isJson(flags)) {
    emitJson(
      {
                ok: true,
                all: true,
                repoStack,
                inline: inline.map((s) => s.name),
                deferred: deferred.map((s) => s.name),
                ...(warning ? { warning } : {}),
              },
    );
    return EXIT.OK;
  }

  const total = inline.reduce((n, s) => n + s.bytes, 0);
  const lines = [
    `ALL ${inline.length} skills for this stack, ${kb(total)} (deferred excluded, use skills show)`,
    '',
    ...inline.map((s) => `${s.name.padEnd(26)} ${kb(s.bytes).padStart(7)}  ${s.stack.join('+')}`),
  ];
  if (warning) lines.push('', warning);
  if (deferred.length > 0) {
    lines.push('', `DEFERRED ${deferred.length}: ${deferred.map((s) => s.name).join(', ')}`);
  }
  emit(lines.join('\n'), { maxBytes: flags.maxBytes ?? 0 });
  return EXIT.OK;
}

// --- find ---------------------------------------------------------------------

export async function findCommand(args, flags) {
  let facts;
  try {
    facts = await skillsFindFacts(args.join(' '), flags);
  } catch (error) {
    return fail(error.message, error.exitCode ?? EXIT.FAIL, error.remedy);
  }
  const { query, results } = facts;
  const workspace = await workspaceLine(flags);

  if (isJson(flags)) {
    emitJson(
      { ok: true, query, workspace, results },
      { maxBytes: flags.maxBytes ?? 0 },
    );
    return EXIT.OK;
  }

  if (results.length === 0) {
    emit([`no skill matches "${query}"`, '', `run: ${CLI} skills index  (the full catalogue)`].join('\n'));
    return EXIT.OK;
  }

  emit(
    [
      `${results.length} match${results.length === 1 ? '' : 'es'} for "${query}"`,
      workspace,
      '',
      ...results.map(
        (r) =>
          `${r.name.padEnd(26)} ${kb(r.bytes).padStart(7)}  ${r.reasons.join(' ')}`,
      ),
    ].join('\n'),
    { maxBytes: flags.maxBytes ?? 0 },
  );
  return EXIT.OK;
}

// --- brief: tier 1 ------------------------------------------------------------
export async function briefCommand(args, flags) {
  const root = flags.root ?? process.cwd();
  let facts;
  try {
    facts = await skillsBriefFacts(root, flags);
  } catch (error) {
    return fail(error.message, error.exitCode ?? EXIT.FAIL, error.remedy);
  }

  if (facts.kind === 'all') {
    return emitAllFacts(facts, flags);
  }

  // `ok: true` because the command did what was asked; the answer being weak
  // is what `warning` carries. Failing here would tell a caller the tool
  // broke when in fact it is telling them their query was.
  if (isJson(flags)) {
    const { shown, shownDeferred, shownUsed, pointerOnly, excludedEntries, workspaceRoot, kind, ...doc } = facts;
    emitJson({ ok: true, ...doc });
    return EXIT.OK;
  }

  if (facts.warning) {
    const repo = await fingerprint(root);
    emit(
      [
        `repo ${root.split('/').pop()} (${repoLine(repo)})`,
        '',
        facts.warning,
      ].join('\n'),
      { maxBytes: flags.maxBytes ?? 0 },
    );
    return EXIT.OK;
  }

  const { shown, shownDeferred, shownUsed, pointerOnly, excludedEntries, workspace, workspaceRoot, budget } = facts;
  const lines = [];
  const repo = await fingerprint(root);

  lines.push(
    `RESOLVED ${shown.length} skills, ${kb(shownUsed)}${flags.all || shownUsed <= budget ? '' : ' (budget capped)'} - repo ${root.split('/').pop()} (${repoLine(repo)})`,
  );

  if (pointerOnly) {
    // One remedy, then a pointer per skill. The exclusion reasons stay available
    // through `skills why`; printing every one of them is a second copy of the
    // catalogue, which is what pushed this packet over the budget it was saving.
    lines.push(`bodies: not on this machine — ${WORKSPACE_REMEDY}`, '');
    for (const entry of shown) lines.push(pointerLine(entry));
    if (shownDeferred.length > 0) {
      lines.push('', `DEFERRED ${shownDeferred.length} (marked deferred)`);
      for (const entry of shownDeferred) lines.push(pointerLine(entry));
    }
    const hidden = excludedEntries;
    if (hidden.length > 0) {
      lines.push('', `NOT SELECTED ${hidden.length}`, '', `  notes: ${CLI} skills why <name> | ${CLI} skills show <name>`);
    }
    lines.push('', 'OVERRIDE  --skill <name> | --budget <bytes> | --all | --paths <globs>');
    emit(lines.join('\n'), { maxBytes: flags.maxBytes ?? 0 });
    return EXIT.OK;
  }

  lines.push(workspace);
  lines.push('');

  for (const entry of shown) {
    const why = [...entry.reasons, ...[...entry.via].map((v) => `requires:${v}`)];
    lines.push(
      `SKILL ${entry.skill.name.padEnd(26)} ${kb(entry.skill.bytes).padStart(7)}  ${why.join(' ')}`,
    );
  }

  if (flags.plan) {
    lines.push('', 'PLAN (fetch each body only when a step needs it)');
    for (const entry of shown) {
      lines.push(`  ${CLI} skills show ${entry.skill.name}`);
    }
  } else {
    lines.push('', 'BODIES');
    for (const entry of shown) {
      lines.push('', `--- ${entry.skill.name} (${entry.skill.summary})`);
      lines.push(await readBody(entry.skill, workspaceRoot, root));
    }
  }

  if (shownDeferred.length > 0) {
    lines.push('', `DEFERRED ${shownDeferred.length} (over ${kb(budget)} or marked deferred)`);
    for (const entry of shownDeferred) {
      const reason = entry.skill.deferred ? 'marked deferred' : 'over budget';
      lines.push(`  ${entry.skill.name.padEnd(26)} ${kb(entry.skill.bytes).padStart(7)}  ${reason}`);
    }
  }

  const notSelected = excludedEntries;
  if (notSelected.length > 0) {
    lines.push('', 'NOT SELECTED');
    for (const { skill, reason } of notSelected) {
      lines.push(`  ${skill.name.padEnd(26)} ${reason}`);
    }
    lines.push('', `  notes: ${CLI} skills why <name> | ${CLI} skills show <name>`);
  }

  lines.push('', 'OVERRIDE  --skill <name> | --budget <bytes> | --all | --paths <globs>');
  emit(lines.join('\n'), { maxBytes: flags.maxBytes ?? 0 });
  return EXIT.OK;
}

// --- show: tier 2 -------------------------------------------------------------

export async function showCommand(args, flags) {
  const root = flags.root ?? process.cwd();
  let facts;
  try {
    facts = await skillsShowFacts(root, args[0], flags);
  } catch (error) {
    return fail(error.message, error.exitCode ?? EXIT.FAIL, error.remedy);
  }
  const { skill, workspace, body, bodyFrom, bodyText } = facts;
  const source = skill.sources?.find((s) => s.role === 'canonical') ?? skill.sources?.[0];
  if (isJson(flags)) {
    emitJson({ ok: true, ...skill, workspace, body, bodyFrom, bodyText }, { maxBytes: flags.maxBytes ?? 0 });
    return EXIT.OK;
  }
  emit(
    [
      `${skill.name}`,
      `${skill.summary}`,
      '',
      `capabilities  ${skill.capabilities.join(', ')}`,
      `stack         ${skill.stack.join(', ')}`,
      `keywords      ${skill.keywords.join(', ')}`,
      `bytes         ${skill.bytes}`,
      skill.deferred ? 'deferred      true (large body; this is the pointer)' : null,
      skill.requires?.length ? `requires      ${skill.requires.join(', ')}` : null,
      '',
      `source        ${source ? `${source.repo}/${source.path} (${source.role})` : 'none'}`,
      `body          ${body === null ? '(unavailable)' : `${bodyFrom}  ${body}`}`,
      workspace,
      '',
      bodyText,
    ]
      .filter((l) => l !== null)
      .join('\n'),
    { maxBytes: flags.maxBytes ?? 0 },
  );
  return EXIT.OK;
}

// --- why ----------------------------------------------------------------------

export async function whyCommand(args, flags) {
  const root = flags.root ?? process.cwd();
  let facts;
  try {
    facts = await skillsWhyFacts(root, args[0], flags);
  } catch (error) {
    return fail(error.message, error.exitCode ?? EXIT.FAIL, error.remedy);
  }

  // Every other command honours `--json`; this one built its answer as text and
  // emitted it, so `--json` was silently ignored and a caller got prose it could
  // not parse. The doc carries the same facts as the text below, and `gate` is
  // the field that makes it machine-readable rather than something a reader has
  // to scrape: a skill that can never be selected in this repo is a decision, not
  // a line of output.
  if (isJson(flags)) {
    emitJson({ ok: true, command: 'skills why', ...facts }, { maxBytes: flags.maxBytes ?? 0 });
    return EXIT.OK;
  }

  const lines = [
    `${facts.skill} - score ${facts.score}`,
    '',
    `repo stack     ${facts.repo.stack.join(', ') || 'undetected'}`,
    `repo facts     ${facts.repo.facts.join(', ') || 'none'}`,
    `repo evidence  ${facts.repo.evidence.join(' ') || 'none'}`,
    await workspaceLine(flags),
    `paths seen     ${facts.paths.length > 0 ? facts.paths.join(' ') : '(none - pass --paths or stage files)'}`,
    `task tokens    ${facts.taskTokens.length > 0 ? facts.taskTokens.join(' ') : '(none - pass --task)'}`,
    '',
    `gate           ${facts.compatible ? 'pass (stack overlaps the repo)' : 'FAIL (no stack overlap, so it can never be selected)'}`,
    `signals        ${facts.signals.length > 0 ? facts.signals.join(' ') : '(none - this skill scores 0 for the current context)'}`,
  ];

  if (facts.variants?.length > 0) {
    lines.push('', 'variants (one body per stack):');
    for (const v of facts.variants) lines.push(`  ${v.id.padEnd(8)} ${v.stack.join('+').padEnd(30)} ${kb(v.bytes)}`);
  }
  if (facts.aliasOf) lines.push('', `alias-of        ${facts.aliasOf} (retired name, resolves to that skill)`);
  if (facts.variantOf) lines.push('', `variant-of      ${facts.variantOf} (sibling group, one body per stack)`);
  if (facts.requires?.length > 0) lines.push(`requires        ${facts.requires.join(', ')}`);

  emit(lines.join('\n'), { maxBytes: flags.maxBytes ?? 0 });
  return EXIT.OK;
}

// --- eval ---------------------------------------------------------------------

/**
 * The gold corpus when the reader names none. A checkout holds one at this fixed path;
 * `test/` is not in the published files, so an installed copy does not. That absence is
 * a fact about where this copy runs, reported as such (ADR-061's tiered resolution is
 * the same shape: explicit path, then the package's own file, then an honest absence).
 */
const DEFAULT_CORPUS = join(PACKAGE_ROOT, 'test', 'fixtures', 'eval-corpus.json');

/**
 * `simt skills eval [corpus]` - measure the resolver against the gold corpus.
 *
 * Plan 0002 section 9: "Reports precision and recall and fails on regression." The
 * corpus states, per case, which skills must come back (`select`) and which must not
 * (`reject`); a case that names no selection is exhaustive, and anything it returns is
 * a miss. The exit code rests on `clean`, because the two ratios can both read 1.0
 * while an exhaustive case returns a skill neither list named (see src/resolve/eval.mjs).
 */
export async function evalCommand(positional, flags) {
  const corpusPath = positional[0] ?? (existsSync(DEFAULT_CORPUS) ? DEFAULT_CORPUS : null);

  if (corpusPath === null) {
    return fail(
      `no eval corpus: ${DEFAULT_CORPUS} is not on this machine (test data does not ship in the package)`,
      EXIT.FAIL,
      `run: ${CLI} skills eval <path-to-corpus>  (a file of cases with select and reject lists)`,
    );
  }

  let corpus;
  try {
    corpus = JSON.parse(await readFile(corpusPath, 'utf8'));
  } catch (error) {
    return fail(
      `${corpusPath}: unreadable or invalid JSON (${error.message})`,
      EXIT.FAIL,
      `run: ${CLI} skills eval <path-to-corpus>`,
    );
  }
  if (!Array.isArray(corpus.cases) || corpus.cases.length === 0) {
    return fail(
      `${corpusPath}: no cases (a corpus is {"cases": [{"name", "repo", "task", "select", "reject"}]})`,
      EXIT.FAIL,
      `run: ${CLI} skills eval <path-to-corpus>`,
    );
  }

  // The corpus is measured against the registry it cites, so it needs the same
  // resolution and the same failure as every other skills command.
  const { registry, errors, ok, path } = await loadRegistry(null, flags);
  if (!ok) return fail(errors[0], EXIT.REGISTRY, WORKSPACE_REMEDY);

  const unknown = unknownSkills(registry, corpus);
  const score = scoreCorpus(registry, corpus);
  const okRun = unknown.length === 0 && score.clean;

  if (isJson(flags)) {
    emitJson(
      {
                ok: okRun,
                command: 'skills eval',
                corpus: corpusPath,
                registry: path,
                cases: score.cases.map((c) => ({
                  name: c.name,
                  selected: c.selected,
                  missing: c.missing,
                  unexpected: c.unexpected,
                })),
                unknownSkills: unknown,
                precision: score.precision,
                recall: score.recall,
              },
    );
    return okRun ? EXIT.OK : EXIT.FAIL;
  }

  const failed = score.cases.filter((c) => c.missing.length > 0 || c.unexpected.length > 0);
  const lines = [
    `corpus    ${corpusPath} (${score.cases.length} cases)`,
    `registry  ${path}`,
    `${score.cases.length - failed.length} pass, ${failed.length} fail`,
    `precision ${score.precision.toFixed(3)}  recall ${score.recall.toFixed(3)}`,
    '',
  ];

  for (const c of score.cases) {
    if (c.missing.length === 0 && c.unexpected.length === 0) {
      lines.push(`PASS  ${c.name}`);
      continue;
    }
    lines.push(`FAIL  ${c.name}`);
    for (const name of c.missing) lines.push(`      missed     ${name}`);
    for (const name of c.unexpected) lines.push(`      unexpected ${name}`);
  }

  if (unknown.length > 0) {
    lines.push('', `FAIL  corpus cites skills the registry does not declare: ${unknown.join(', ')}`);
  }

  lines.push('', okRun ? 'OK the resolver meets the gold corpus' : 'REGRESSION: the resolver no longer meets the gold corpus');
  emit(lines.join('\n'), { maxBytes: flags.maxBytes ?? 0 });
  return okRun ? EXIT.OK : EXIT.FAIL;
}

// --- bodies -------------------------------------------------------------------

/** A one-line pointer. The reasons stay, so a brief that cannot inline still says why. */
function pointerLine(entry) {
  const why = [...entry.reasons, ...[...entry.via].map((v) => `requires:${v}`)];
  return `pointer  ${entry.skill.name.padEnd(26)} ${why.join(' ')}`;
}

/** True when `readBody` would return the skill text rather than an explanation of its absence. */
async function bodyReadable(skill, workspaceRoot, root) {
  const full = await sourcePath(skill, workspaceRoot, root);
  return Boolean(full && existsSync(full));
}

async function readBody(skill, workspaceRoot, root) {
  const full = await sourcePath(skill, workspaceRoot, root);
  if (!full) {
    return `(body unavailable: this installation has no workspace and ${root ?? 'this directory'} does not hold ${skill.name}; ${WORKSPACE_REMEDY})`;
  }
  if (!existsSync(full)) return `(body unavailable: ${full} is not on this machine)`;
  try {
    return (await readFile(bodyFile(full), 'utf8')).trimEnd();
  } catch (error) {
    return `(body unreadable: ${error.message})`;
  }
}

/**
 * Which source answered the workspace question, and what to do when none did.
 * Printed once, not per skill - 38 identical remedies is the same noise as 38
 * ENOENTs.
 */
async function workspaceLine(flags) {
  const ws = await resolveWorkspace(flags);
  if (ws.root) return `workspace ${ws.root} (${ws.source}: ${ws.detail})`;
  // The wording states only the workspace fact. Whether a body is reachable is a
  // different question with a different answer per skill, because the repo itself
  // can hold a declared source (ADR-015) - claiming bodies are unavailable here
  // would contradict the `body repo ...` line printed directly above it.
  return `workspace none configured - set one with ${WORKSPACE_REMEDY}`;
}

/** Commands that print bodies or install them announce the workspace up front. */
async function announceWorkspace(flags) {
  const note = await workspaceLine(flags);
  const { root } = await resolveWorkspace(flags);
  return { note, root };
}

