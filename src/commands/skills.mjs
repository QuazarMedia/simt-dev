// `simt-dev skills` - tier 0 (index), tier 1 (brief), tier 2 (show), plus find/why.
//
// Implementation sequence steps 4 and 5.
//
// Output design (plan 0002 section 6): one fact per line, fixed field order, no
// wrapping, no colour when piped, bounded by --max-bytes with an explicit
// TRUNCATED line. The NOT SELECTED block is as important as the resolved block -
// the agent can see what exists and why it was excluded, and override in one
// token instead of guessing. Suppressing it is how a discovery tool becomes a
// black box.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

import { EXIT, emit, emitJson, fail, isJson, note as emitNote } from '../output/index.mjs';
import { loadRegistry, REGISTRY_PATH } from '../graph/load.mjs';
import { locateSource, sourceHeldLocally } from '../resolve/source.mjs';
import { resolveWorkspace, WORKSPACE_REMEDY } from '../workspace.mjs';
import { fingerprint } from '../resolve/fingerprint.mjs';
import { tokenize, rankSkills, closure, selectWithinBudget, resolveAlias, scoreSkill, selectionVerdict, stackCompatible } from '../resolve/resolve.mjs';
import { nearMatches } from '../resolve/near.mjs';

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

export function parsePathList(value) {
  return String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
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
  const { registry, errors, ok } = await loadRegistry(REGISTRY_PATH, flags);
  if (!ok) return fail(errors[0], EXIT.REGISTRY);
  const workspace = await workspaceLine(flags);

  if (isJson(flags)) {
    emit(
      `${JSON.stringify(
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
        null,
        2,
      )}\n`,
      { maxBytes: flags.maxBytes ?? 0 },
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
      'deferred entries return a pointer, not a body. Fetch one with: simt-dev skills show <name>',
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
async function emitAll(registry, repoStack, flags, warning) {
  const repo = new Set(repoStack);
  const usable = registry.skills.filter((s) => stackCompatible(s, repoStack));
  const deferred = usable.filter((s) => s.deferred);
  const inline = usable.filter((s) => !s.deferred);

  if (isJson(flags)) {
    emit(
      `${JSON.stringify(
        {
          ok: true,
          all: true,
          repoStack,
          inline: inline.map((s) => s.name),
          deferred: deferred.map((s) => s.name),
          ...(warning ? { warning } : {}),
        },
        null,
        2,
      )}\n`,
      { maxBytes: flags.maxBytes ?? 0 },
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
  const query = args.join(' ').trim();
  if (!query) return fail('find needs a query', EXIT.USAGE, 'usage: simt-dev skills find <query>');

  const { registry, errors, ok } = await loadRegistry(REGISTRY_PATH, flags);
  if (!ok) return fail(errors[0], EXIT.REGISTRY);

  const tokens = tokenize(query);
  const workspace = await workspaceLine(flags);
  const results = registry.skills
    .map((skill) => ({ skill, ...scoreSkill(skill, { repoStack: [], taskTokens: tokens, paths: [] }) }))
    .filter((r) => selectionVerdict(r.evidence, r.reasons) === null)
    .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name));

  if (isJson(flags)) {
    emit(`${JSON.stringify({ ok: true, query, workspace, results: results.map((r) => ({ name: r.skill.name, score: r.score, reasons: r.reasons })) }, null, 2)}\n`, { maxBytes: flags.maxBytes ?? 0 });
    return EXIT.OK;
  }

  if (results.length === 0) {
    emit([`no skill matches "${query}"`, '', 'run: simt-dev skills index  (the full catalogue)'].join('\n'));
    return EXIT.OK;
  }

  emit(
    [
      `${results.length} match${results.length === 1 ? '' : 'es'} for "${query}"`,
      workspace,
      '',
      ...results.map(
        (r) =>
          `${r.skill.name.padEnd(26)} ${kb(r.skill.bytes).padStart(7)}  ${r.reasons.join(' ')}`,
      ),
    ].join('\n'),
    { maxBytes: flags.maxBytes ?? 0 },
  );
  return EXIT.OK;
}

// --- brief: tier 1 ------------------------------------------------------------

export async function briefCommand(args, flags) {
  const { registry, errors, ok } = await loadRegistry(REGISTRY_PATH, flags);
  if (!ok) return fail(errors[0], EXIT.REGISTRY);

  const root = flags.root ?? process.cwd();
  const repo = await fingerprint(root);
  const { note: workspace, root: workspaceRoot } = await announceWorkspace(flags);
  // stack ∪ facts: a skill may declare either, so the gate must see both.
  const repoStack = repo.signals;
  const paths = flags.paths ? parsePathList(flags.paths) : await dirtyPaths(root);
  const taskTokens = tokenize(flags.task ?? '');
  const forced = parsePathList(flags.skill);
  const budget = flags.budget ?? DEFAULT_BUDGET;

  // A brief with no task and no paths resolves on stack alone, which produces a
  // plausible-looking list the agent may act on. It is the most likely way this
  // tool gets misused, so it warns rather than silently answering.
  //
  // Under `--json` the warning is a FIELD, not prose on stdout. It used to be
  // emitted as text with no `isJson` check, so `brief --json` printed a paragraph
  // and then nothing a caller could parse - and with `--all` the text came first
  // and a second document followed, so stdout was neither one document nor none.
  if (!flags.task && paths.length === 0 && forced.length === 0) {
    const warning =
      'no --task and no staged files, so selection can only use the repo signals. ' +
      'pass --task "<what you are doing>" or stage files so the diff drives selection, ' +
      'or pass --all to take everything for this stack.';
    if (isJson(flags)) {
      // `ok: true` because the command did what was asked; the answer being weak
      // is what `warning` carries. Failing here would tell a caller the tool
      // broke when in fact it is telling them their query was.
      if (flags.all) return emitAll(registry, repoStack, flags, warning);
      emit(
        `${JSON.stringify(
          {
            ok: true,
            repo: { root, stack: repoStack },
            workspace,
            task: null,
            budget,
            resolved: [],
            deferred: [],
            excluded: [],
            warning,
          },
          null,
          2,
        )}\n`,
        { maxBytes: flags.maxBytes ?? 0 },
      );
      return EXIT.OK;
    }
    emit(
      [
        `repo ${root.split('/').pop()} (${repoLine(repo)})`,
        '',
        warning,
      ].join('\n'),
      { maxBytes: flags.maxBytes ?? 0 },
    );
    if (flags.all) return emitAll(registry, repoStack, flags, warning);
    return EXIT.OK;
  }

  const context = { repoStack, taskTokens, paths };
  const { selected, excluded } = rankSkills(registry.skills, context, { forced });

  // Hard dependencies are pulled in even when they did not score, and even past
  // budget: a skill that is useless without its dependency is worse than a large
  // context, because it silently misleads.
  const expanded = closure(selected, registry.skills);
  const order = new Map(expanded.map((e, i) => [e.skill.name, i]));
  expanded.sort((a, b) => (order.get(a.skill.name) - order.get(b.skill.name)));

  // Budget, by one shared function. The loop this replaced existed here and in the MCP
  // tool, and the copies had already drifted: this one skipped a `deferred` skill before
  // looking at the budget and the other checked it after, so a deferred dependency was
  // inlined by one command and not the other. `selectWithinBudget` is the whole
  // arithmetic, and it is the only place that knows a dependency does not get to exceed
  // the budget on its own — which is what let a 2,000-byte budget resolve 13,503 bytes.
  const { picked, deferred, used: bytesUsed } = selectWithinBudget(expanded, {
    budget,
    all: flags.all === true,
  });
  const closureNames = new Set(expanded.map((e) => e.skill.name));

  const excludedNames = new Set(excluded.map((e) => e.skill.name));
  const lines = [];

  if (isJson(flags)) {
    emit(
      `${JSON.stringify(
        {
          ok: true,
          repo: { root, stack: repoStack },
          workspace,
          task: flags.task ?? null,
          budget,
          resolved: picked.map((e) => ({ name: e.skill.name, bytes: e.skill.bytes, why: [...e.reasons, ...[...e.via].map((v) => `requires:${v}`)] })),
          deferred: deferred.map((e) => ({ name: e.skill.name, bytes: e.skill.bytes })),
          excluded: excluded.filter((e) => !closureNames.has(e.skill.name)).map((e) => ({ name: e.skill.name, reason: e.reason })),
        },
        null,
        2,
      )}\n`,
      { maxBytes: flags.maxBytes ?? 0 },
    );
    return EXIT.OK;
  }

  lines.push(
    `RESOLVED ${picked.length} skills, ${kb(bytesUsed)}${flags.all || bytesUsed <= budget ? '' : ' (budget capped)'} - repo ${root.split('/').pop()} (${repoLine(repo)})`,
  );
  lines.push(workspace);
  lines.push('');

  for (const entry of picked) {
    const why = [...entry.reasons, ...[...entry.via].map((v) => `requires:${v}`)];
    lines.push(
      `SKILL ${entry.skill.name.padEnd(26)} ${kb(entry.skill.bytes).padStart(7)}  ${why.join(' ')}`,
    );
  }

  if (flags.plan) {
    lines.push('', 'PLAN (fetch each body only when a step needs it)');
    for (const entry of picked) {
      lines.push(`  simt-dev skills show ${entry.skill.name}`);
    }
  } else {
    lines.push('', 'BODIES');
    for (const entry of picked) {
      lines.push('', `--- ${entry.skill.name} (${entry.skill.summary})`);
      lines.push(await readBody(entry.skill, workspaceRoot, root));
    }
  }

  if (deferred.length > 0) {
    lines.push('', `DEFERRED ${deferred.length} (over ${kb(budget)} or marked deferred)`);
    for (const entry of deferred) {
      const reason = entry.skill.deferred ? 'marked deferred' : 'over budget';
      lines.push(`  ${entry.skill.name.padEnd(26)} ${kb(entry.skill.bytes).padStart(7)}  ${reason}`);
    }
  }

  const notSelected = excluded.filter((e) => !closureNames.has(e.skill.name));
  if (notSelected.length > 0) {
    lines.push('', 'NOT SELECTED');
    for (const { skill, reason } of notSelected) {
      lines.push(`  ${skill.name.padEnd(26)} ${reason}`);
    }
    lines.push('', '  notes: simt-dev skills why <name> | simt-dev skills show <name>');
  }

  lines.push('', 'OVERRIDE  --skill <name> | --budget <bytes> | --all | --paths <globs>');
  emit(lines.join('\n'), { maxBytes: flags.maxBytes ?? 0 });
  return EXIT.OK;
}

// --- show: tier 2 -------------------------------------------------------------

export async function showCommand(args, flags) {
  const name = args[0];
  if (!name) return fail('show needs a skill name', EXIT.USAGE, 'usage: simt-dev skills show <name>');

  const { registry, errors, ok } = await loadRegistry(REGISTRY_PATH, flags);
  if (!ok) return fail(errors[0], EXIT.REGISTRY);

  const skill = registry.skills.find((s) => s.name === name);
  if (!skill) {
    const near = nearMatches(name, registry.skills.map((s) => s.name));
    return fail(
      `no skill named "${name}"${near.length ? ` (did you mean ${near.join(', ')}?)` : ''}`,
      EXIT.USAGE,
      'run: simt-dev skills find <query>',
    );
  }

  const source = skill.sources?.find((s) => s.role === 'canonical') ?? skill.sources?.[0];
  const { note: workspace, root: workspaceRoot } = await announceWorkspace(flags);
  // The repo is a location for a declared source too, so `show` reads a body the
  // caller already has instead of reporting the body missing (ADR-015).
  const root = flags.root ?? process.cwd();
  const body = await sourcePath(skill, workspaceRoot, root);
  const bodyFrom = body === null ? 'none' : body.startsWith(`${root}/`) ? 'repo' : 'workspace';
  if (isJson(flags)) {
    emit(
      `${JSON.stringify({ ok: true, ...skill, workspace, body, bodyFrom }, null, 2)}\n`,
      { maxBytes: flags.maxBytes ?? 0 },
    );
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
      await readBody(skill, workspaceRoot, root),
    ]
      .filter((l) => l !== null)
      .join('\n'),
    { maxBytes: flags.maxBytes ?? 0 },
  );
  return EXIT.OK;
}

// --- why ----------------------------------------------------------------------

export async function whyCommand(args, flags) {
  const name = args[0];
  if (!name) return fail('why needs a skill name', EXIT.USAGE, 'usage: simt-dev skills why <name>');

  const { registry, errors, ok } = await loadRegistry(REGISTRY_PATH, flags);
  if (!ok) return fail(errors[0], EXIT.REGISTRY);

  const skill = registry.skills.find((s) => s.name === name);
  if (!skill) {
    const near = nearMatches(name, registry.skills.map((s) => s.name));
    return fail(
      `no skill named "${name}"${near.length ? ` (did you mean ${near.join(', ')}?)` : ''}`,
      EXIT.USAGE,
      'run: simt-dev skills find <query>',
    );
  }

  const root = flags.root ?? process.cwd();
  const repo = await fingerprint(root);
  const paths = flags.paths ? parsePathList(flags.paths) : await dirtyPaths(root);
  const tokens = tokenize(flags.task ?? '');

  const { score, reasons } = scoreSkill(skill, { repoStack: repo.signals, taskTokens: tokens, paths });
  const compatible = stackCompatible(skill, repo.signals);

  // Every other command honours `--json`; this one built its answer as text and
  // emitted it, so `--json` was silently ignored and a caller got prose it could
  // not parse. The doc carries the same facts as the text below, and `gate` is
  // the field that makes it machine-readable rather than something a reader has
  // to scrape: a skill that can never be selected in this repo is a decision, not
  // a line of output.
  if (isJson(flags)) {
    const workspace = await resolveWorkspace(flags);
    emitJson({
      ok: true,
      command: 'skills why',
      skill: skill.name,
      score,
      compatible,
      gate: compatible ? 'pass' : 'fail',
      repo: { root, stack: repo.stack, facts: repo.facts, evidence: repo.evidence },
      workspace: { root: workspace.root ?? null, source: workspace.source, detail: workspace.detail },
      paths: paths.slice(0, 8),
      taskTokens: tokens,
      signals: reasons,
      variants: (skill.variants ?? []).map((v) => ({ id: v.id, stack: v.stack, bytes: v.bytes })),
      aliasOf: skill.aliasOf ?? null,
      variantOf: skill.variantOf ?? null,
      requires: skill.requires ?? [],
    }, { maxBytes: flags.maxBytes ?? 0 });
    return EXIT.OK;
  }

  const lines = [
    `${skill.name} - score ${score}`,
    '',
    `repo stack     ${repo.stack.join(', ') || 'undetected'}`,
    `repo facts     ${repo.facts.join(', ') || 'none'}`,
    `repo evidence  ${repo.evidence.join(' ') || 'none'}`,
    await workspaceLine(flags),
    `paths seen     ${paths.length > 0 ? paths.slice(0, 8).join(' ') : '(none - pass --paths or stage files)'}`,
    `task tokens    ${tokens.length > 0 ? tokens.join(' ') : '(none - pass --task)'}`,
    '',
    `gate           ${compatible ? 'pass (stack overlaps the repo)' : 'FAIL (no stack overlap, so it can never be selected)'}`,
    `signals        ${reasons.length > 0 ? reasons.join(' ') : '(none - this skill scores 0 for the current context)'}`,
  ];

  if (skill.variants?.length > 0) {
    lines.push('', 'variants (one body per stack):');
    for (const v of skill.variants) lines.push(`  ${v.id.padEnd(8)} ${v.stack.join('+').padEnd(30)} ${kb(v.bytes)}`);
  }
  if (skill.aliasOf) lines.push('', `alias-of        ${skill.aliasOf} (retired name, resolves to that skill)`);
  if (skill.variantOf) lines.push('', `variant-of      ${skill.variantOf} (sibling group, one body per stack)`);
  if (skill.requires?.length > 0) lines.push(`requires        ${skill.requires.join(', ')}`);

  emit(lines.join('\n'), { maxBytes: flags.maxBytes ?? 0 });
  return EXIT.OK;
}

// --- bodies -------------------------------------------------------------------

/**
 * Resolve a skill's body to an absolute path.
 *
 * Sources are declared as `repo/path`, so finding one needs the workspace that
 * CONTAINS the repos. That used to be `resolve(here, '..', '..', '..')`, which is
 * right in the checkout and wrong in `node_modules` - so every source resolved to a
 * path that could not exist and `skills` failed with 38 ENOENT lines. Now it comes
 * from configuration, and `null` is a legitimate answer meaning "this installation
 * has no workspace" (ADR-014).
 *
 * A second location exists and is not a fallback: the repo being read is itself a
 * location for a declared source, matched on bytes rather than on hope (ADR-015).
 * The canonical source is still tried first, so a workspace body always wins.
 */
export async function sourcePath(skill, workspaceRoot, root) {
  const canonical = skill.sources?.find((s) => s.role === 'canonical') ?? skill.sources?.[0];

  if (canonical) {
    const found = await locateSource(canonical, { workspaceRoot, root });
    if (found.path) return found.path;
  }

  const held = await sourceHeldLocally(skill, root, { workspaceRoot });
  if (held && !held.ambiguous) return held.path;

  // A skill with no canonical source, or one whose bytes match nothing, has no
  // body. Say so rather than printing an empty section.
  return canonical && workspaceRoot ? join(workspaceRoot, canonical.repo, canonical.path) : null;
}

export async function readBody(skill, workspaceRoot, root) {
  const full = await sourcePath(skill, workspaceRoot, root);
  if (!full) {
    return `(body unavailable: this installation has no workspace and ${root ?? 'this directory'} does not hold ${skill.name}; ${WORKSPACE_REMEDY})`;
  }
  if (!existsSync(full)) return `(body unavailable: ${full} is not on this machine)`;
  try {
    const target = existsSync(join(full, 'SKILL.md')) ? join(full, 'SKILL.md') : full;
    return (await readFile(target, 'utf8')).trimEnd();
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

