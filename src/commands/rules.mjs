// `simt rules` - the rule catalogue and its provenance.
//
// A rule is only meaningful if you can answer "why is this here?". Three
// commands, mirroring the skill surface deliberately: `list` is the catalogue,
// `show` is one body, `why` is the decision chain behind it.
//
// The load-bearing one is `why`. Every rule body cites the ADR that settled it,
// so the citation can be resolved: title, status, and - the part that matters -
// whether the record is still in force. ADR-011 was accepted and reversed by
// ADR-012 the same day; printing 011's ruling without that would hand a reader a
// decision nobody is following.
//
// A rule that cites nothing is a finding, not an empty answer. It is reported as
// one, because "this rule has no decision behind it" is exactly the fact a
// reviewer needs and exactly the fact an empty output would hide.

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { EXIT, emit, emitJson, fail, isJson } from '../output/index.mjs';
import { loadRules, select } from '../projection/project.mjs';
import { loadMdcRules } from '../projection/mdc.mjs';
import { fingerprint } from '../resolve/fingerprint.mjs';
import { byId, citations, loadDecisionsCached, redactEstate } from '../decisions/index.mjs';
import { DECISIONS_DIR } from '../decisions/index.mjs';
import { decisionsDir } from '../decisions/dir.mjs';
import { nearMatches } from '../resolve/near.mjs';
import { CLI } from '../name.mjs';

const kb = (bytes) => `${(bytes / 1000).toFixed(1)}k`;

/**
 * `simt-applies` is the string "always" for core and an array for profiles.
 *
 * An opt-in rule has an EMPTY array, and `-` is a true reading of that which answers
 * none of the questions a reader has. `simt-opt-in` is why it is empty — detection cannot
 * distinguish a repository with the problem from one without it, so the repository
 * declares it — and that is the fact worth printing. It only became visible when the
 * per-surface rules entered this catalogue; before that the rule was not listed at all.
 */
function appliesLabel(rule) {
  if (rule.applies === 'always') return 'always';
  if (rule.optIn === true) return 'opt-in (the repo declares it)';
  if (Array.isArray(rule.applies)) return rule.applies.join(',') || '-';
  return '-';
}

/** Sorted for run-to-run diffability: the catalogue is read by agents, not just humans. */
function sorted(rules) {
  return [...rules].sort((a, b) => a.id.localeCompare(b.id));
}

async function load(root) {
  const rules = await loadRules(root ?? null);
  const broken = rules.filter((r) => r.error);
  return { rules: [...rules, ...(await loadPerSurfaceRules())], broken };
}

/**
 * The `.mdc` rules, in the shape this file's three commands print.
 *
 * `loadRules` reads `rules/*.md` and `rules/stacks/*.md`, which is every rule that is a
 * *stack profile* — and the four per-surface rules are not that. They are projected by
 * `ruleBodies` inside `desiredRegion` rather than by `select`, so they were invisible to
 * `rules list`, `rules show` and `rules why`: a reader could be told by an agent to run
 * `simt rules why test-gate` and be met with "no rule with that id", for a rule that was
 * in their own `AGENTS.md` at the time.
 *
 * Deliberately NOT added to `loadRules`. That function's result is `select`ed and
 * `render`ed into the region, so putting these there would project every one of them
 * twice — once as a profile section and once as `## Process: <id>` — which is the
 * duplication ADR-046 exists to prevent. The catalogue is the right layer for this: it is
 * a view, and a view may be wider than what one projection writes.
 */
async function loadPerSurfaceRules() {
  const mdc = await loadMdcRules();
  return mdc.map((r) => ({
    ...r,
    // These have no `simt-title`; their `description` is what a reader sees in the
    // generated file, so it is the title here rather than a column of blanks.
    title: r.title ?? r.description ?? null,
    // `mdc` rather than `central`: the column exists so a reader can tell where a rule
    // came from, and "central" is true of all of them and useless for this distinction.
    origin: 'per-surface',
    fallback: false,
  }));
}

// --- list ---------------------------------------------------------------------

export async function listCommand(args, flags) {
  const root = flags.root ?? null;
  // With --root the question becomes "which of these apply to me", which is a
  // different answer from the catalogue and the one an agent usually wants.
  const { rules, broken, notes } = await rulesCatalogue(root, { selectFor: root });
  const selection = root ? new Set(rules.filter((r) => r.selected).map((r) => r.id)) : null;

  if (isJson(flags)) {
    emitJson(
      {
                ok: broken.length === 0,
                command: 'rules list',
                root,
                rules,
                notes,
              },
    );
    return broken.length === 0 ? EXIT.OK : EXIT.FAIL;
  }

  const total = rules.reduce((n, r) => n + r.bytes, 0);
  const local = rules.filter((r) => r.origin === 'local').length;
  const rows = sorted(rules);

  // Column widths are measured from the data rather than hardcoded. `simt-applies` is a
  // list of signals whose length is the whole point of the column, so a fixed pad
  // silently pushed the title out of alignment for exactly the profiles a reader
  // most wants to compare. Measured widths are still deterministic for a given
  // rule set, which is what run-to-run diffability needs.
  const widths = {
    id: Math.max(2, ...rows.map((r) => r.id.length)),
    bytes: Math.max(5, ...rows.map((r) => kb(r.bytes).length)),
    origin: Math.max(6, ...rows.map((r) => r.origin.length)),
    applies: Math.max(7, ...rows.map((r) => appliesLabel(r).length)),
  };

  // The selection marker stays welded to the id: it is a mark on that row, not a
  // column of its own, and `*connectiq` is greppable where `*  connectiq` is not.
  const render = (mark, id, bytes, origin, applies, title) =>
    `${mark}${id.padEnd(widths.id)}  ${bytes.padStart(widths.bytes)}  ${origin.padEnd(widths.origin)}  ${applies.padEnd(widths.applies)}  ${title}`;

  const lines = [
    `${rules.length} rules, ${kb(total)}${local > 0 ? `, ${local} local` : ''}${selection ? '' : ' (pass --root to see which apply to a repo)'}`,
    '',
    render(' ', 'id', 'bytes', 'origin', 'applies', 'title'),
  ];

  for (const rule of rows) {
    const mark = selection && selection.has(rule.id) ? '*' : ' ';
    lines.push(
      render(mark, rule.id, kb(rule.bytes), rule.origin, appliesLabel(rule), rule.title ?? '(no title)'),
    );
  }

  for (const rule of broken) {
    lines.push('', `BROKEN  ${rule.source}: ${rule.error}`);
  }
  if (selection) {
    lines.push('', `* selected for ${root}`);
    for (const note of notes) lines.push(`  note ${note}`);
  }
  if (root) {
    const locals = rules.filter((r) => r.origin === 'local');
    if (locals.length > 0) lines.push('', `local profiles come from ${locals.map((r) => r.source).join(', ')}`);
  }

  emit(lines.join('\n'), { maxBytes: flags.maxBytes ?? 0 });
  return broken.length === 0 ? EXIT.OK : EXIT.FAIL;
}

async function selectionFor(rules, root) {
  const { stack, facts } = await fingerprint(root);
  const { selected, notes } = select(rules, stack, facts);
  return { selected: new Set(selected.map((r) => r.id)), notes };
}

// --- cores: one computation for the CLI and the MCP tools (Q15) ----------------
//
// `rules_list` and `rules_why` in the MCP surface rebuilt this catalogue from the
// same modules with narrower loads: the MCP list missed the per-surface rules and
// the MCP why failed on them, because neither shared the catalogue below. The
// commands render these facts for terminals; the tools return them as JSON. The
// CLI keeps its field names; the tools adopt them.
//
// A core throws when it cannot answer: the message names the problem, `remedy`
// names the next command, and `exitCode` is the exit the CLI leaves with.
function rulesFailure(message, remedy, exitCode) {
  throw Object.assign(new Error(message), { remedy, exitCode });
}

/**
 * The merged decision index: the package's shipped records underlay the
 * repository's own, which win on an id collision (review 0003 Q34).
 *
 * Before this, a consumer with its own ADR-001/002 read `rules why core` as
 * settled by *their* ADR-001 while the package's ADR-003…009 — the ones the
 * shipped rules actually cite — reported MISSING. The overlay keeps both
 * visible: every decision carries which layer it came from, so a same-number
 * collision reads as two records, never as one answer wearing the wrong title.
 *
 * @returns {{ok: boolean, decisions: object[], errors: string[], origins: Record<string,'repo'|'package'>}}
 */
async function loadDecisionsFor(root, all) {
  // Q55: one resolution (manifest key, then detection) and the shared cache,
  // so `rules why` answers from the repository's own records without re-parsing
  // every record on every call. No root means the package's own records.
  const pkg = await loadDecisionsCached({ root, dir: DECISIONS_DIR, all });
  if (!root) return { ...pkg, origins: Object.fromEntries(pkg.decisions.map((d) => [d.id, 'package'])) };
  const relDir = await decisionsDir(root);
  const absDir = join(root, relDir);
  const hasLocal = (await readdir(absDir).catch(() => [])).some((n) => /^ADR-\d{3,}-.*\.md$/i.test(n));
  if (!hasLocal) return { ...pkg, origins: Object.fromEntries(pkg.decisions.map((d) => [d.id, 'package'])) };
  const local = await loadDecisionsCached({ root, dir: absDir, all });
  const merged = new Map(pkg.decisions.map((d) => [d.id, d]));
  const origins = Object.fromEntries(pkg.decisions.map((d) => [d.id, 'package']));
  for (const d of local.decisions) {
    merged.set(d.id, d);
    origins[d.id] = 'repo';
  }
  return { ok: pkg.ok && local.ok, decisions: [...merged.values()], errors: [...pkg.errors, ...local.errors], origins };
}

/** The catalogue both surfaces answer from: every rule, its decisions, and the selection. */
export async function rulesCatalogue(root, { selectFor = null } = {}) {
  const { rules, broken } = await load(root);
  const selection = selectFor ? await selectionFor(rules, selectFor) : null;
  return {
    rules: sorted(rules).map((r) => ({
      id: r.id,
      title: r.title,
      origin: r.origin,
      source: r.source,
      applies: r.applies,
      optIn: r.optIn ?? false,
      fallback: r.fallback,
      bytes: r.bytes,
      error: r.error,
      adrs: citations(r.body),
      selected: selection ? selection.selected.has(r.id) : null,
    })),
    broken,
    notes: selection?.notes ?? [],
  };
}

/**
 * The provenance facts for one rule or one decision record, in the shape the
 * JSON documents carry. Text renders from the same facts; nothing re-derives.
 */
export async function rulesWhyFacts(root, what, { all = false } = {}) {
  const { rules } = await load(root);
  if (/^ADR-\d{3,}$/i.test(what)) {
    const id = what.toUpperCase();
    const { ok, decisions, errors, origins } = await loadDecisionsFor(root, all);
    if (!ok) {
      rulesFailure(errors[0], 'the decision records must be readable for provenance to work', EXIT.CONFIG);
    }
    const record = decisions.find((x) => x.id === id) ?? null;
    // Was 'list them with: ls docs/decisions/' - a path relative to simt-dev's own
    // tree, which resolves to nothing in the repo the reader is standing in. The
    // remedy must be a command they can run (Q34: the decisions list, not the
    // rules list - the reader asked about a decision, not a rule).
    if (!record) rulesFailure(`no decision record ${id}`, `list the known decisions with: ${CLI} rules decisions`, EXIT.USAGE);
    const replacement = record.supersededBy ? decisions.find((x) => x.id === record.supersededBy) : null;
    return {
      direction: 'decision',
      id,
      adr: { ...record, origin: origins[id] ?? 'package' },
      origins,
      supersededBy: replacement ? { id: replacement.id, title: replacement.title } : null,
      inForce: replacement
        ? { id: replacement.id, status: replacement.status, summary: replacement.summary }
        : { id: record.id, status: record.status, summary: record.summary },
      rules: rules.filter((r) => citations(r.body).includes(id)).map((r) => r.id),
    };
  }
  const rule = rules.find((r) => r.id === what);
  if (!rule) {
    const near = nearMatches(what, rules.map((r) => r.id));
    rulesFailure(
      `no rule with id "${what}"${near.length > 0 ? ` (did you mean ${near.join(', ')}?)` : ''}`,
      `run: ${CLI} rules list`,
      EXIT.USAGE,
    );
  }
  const { ok, decisions, errors, origins } = await loadDecisionsFor(root, all);
  if (!ok) {
    rulesFailure(errors[0], 'the decision records must be readable for provenance to work', EXIT.CONFIG);
  }
  const index = byId(decisions);
  const cited = citations(rule.body);
  const others = rules.filter((r) => r.id !== rule.id && citations(r.body).some((c) => cited.includes(c)));
  return {
    direction: 'rule',
    id: rule.id,
    rule: rule.id,
    title: rule.title ?? null,
    source: rule.source,
    origin: rule.origin,
    adrs: cited.map((c) => (index.has(c) ? { ...index.get(c), origin: origins[c] ?? 'package' } : { id: c, missing: true })),
    uncited: cited.length === 0,
    others: others.map((r) => r.id),
    origins,
  };
}

// --- show ---------------------------------------------------------------------

export async function showCommand(args, flags) {
  const id = args[0];
  if (!id) return fail('rules show needs a rule id', EXIT.USAGE, `usage: ${CLI} rules show <id>`);

  const { rules } = await load(flags.root ?? null);
  const rule = rules.find((r) => r.id === id);
  if (!rule) {
    const near = nearMatches(id, rules.map((r) => r.id));
    return fail(
      `no rule with id "${id}"${near.length > 0 ? ` (did you mean ${near.join(', ')}?)` : ''}`,
      EXIT.USAGE,
      `run: ${CLI} rules list`,
    );
  }

  const adrs = citations(rule.body);
  if (isJson(flags)) {
    emitJson({ ok: !rule.error, ...rule, adrs }, { maxBytes: flags.maxBytes ?? 0 });
    return rule.error ? EXIT.FAIL : EXIT.OK;
  }

  emit(
    [
      rule.id,
      rule.title ?? '(no title)',
      '',
      `applies     ${appliesLabel(rule)}${rule.fallback ? ' (fallback)' : ''}`,
      `origin      ${rule.origin}`,
      `source      ${rule.source}`,
      `bytes       ${rule.bytes}`,
      `adrs        ${adrs.length > 0 ? adrs.join(', ') : 'NONE - no decision is cited by this rule'}`,
      '',
      rule.body,
    ].join('\n'),
    { maxBytes: flags.maxBytes ?? 0 },
  );
  return rule.error ? EXIT.FAIL : EXIT.OK;
}

// --- why ----------------------------------------------------------------------

/**
 * Two directions, because both questions get asked:
 *   `rules why <rule-id>`  -> which decisions settled this rule, and are they in force
 *   `rules why <ADR-010>`  -> which rules rest on this decision
 */
export async function whyCommand(args, flags) {
  const what = args[0];
  if (!what) return fail('rules why needs a rule id or an ADR id', EXIT.USAGE, `usage: ${CLI} rules why <rule-id|ADR-NNN>`);

  let facts;
  try {
    facts = await rulesWhyFacts(flags.root ?? null, what, { all: flags.all === true });
  } catch (error) {
    return fail(error.message, error.exitCode ?? EXIT.FAIL, error.remedy);
  }

  if (isJson(flags)) {
    emitJson({ ok: true, command: 'rules why', ...facts });
    return EXIT.OK;
  }

  return facts.direction === 'decision' ? adrDirection(facts, flags) : ruleDirection(facts, flags);
}

function ruleDirection(facts, flags) {
  const lines = [`${facts.rule} - ${facts.title ?? '(no title)'}`, '', `source  ${facts.source} (${facts.origin})`];

  if (facts.uncited) {
    lines.push(
      '',
      'provenance  NONE',
      '  this rule cites no decision, so nothing settles it and nothing can overturn it.',
      '  Either cite the ADR that produced it, or accept that it is this repo\'s own policy.',
    );
    emit(lines.join('\n'), { maxBytes: flags.maxBytes ?? 0 });
    return EXIT.OK;
  }

  lines.push('', `settled by ${facts.adrs.length} decision${facts.adrs.length === 1 ? '' : 's'}`);
  for (const d of facts.adrs) {
    if (d.missing) {
      lines.push(`  ${d.id}  MISSING - the rule cites it, but neither this repo nor this installation has a record of it`);
      lines.push(`          remedy: list the known decisions with: ${CLI} rules decisions`);
      continue;
    }
    lines.push(`  ${d.id}  [${d.origin ?? 'package'}]  ${d.title}`);
    lines.push(`          ${d.status}`);
    if (d.supersededBy) {
      // Never print a reversed ruling as if it were current.
      lines.push(`          SUPERSEDED by ${d.supersededBy} - read that record instead`);
    }
  }

  // The reverse edge is what makes this useful for maintaining the set: which
  // rules would a change to one decision touch?
  if (facts.others.length > 0) {
    lines.push('', `shares a decision with ${facts.others.join(', ')}`);
  }

  emit(lines.join('\n'), { maxBytes: flags.maxBytes ?? 0 });
  return EXIT.OK;
}

function adrDirection(facts, flags) {
  const d = facts.adr;
  const restates = facts.rules;

  const lines = [
    `${d.id} - ${d.title}`,
    '',
    `origin    ${d.origin ?? 'package'}${d.origin === 'repo' ? ' (this repository overlays the shipped record of the same number)' : ''}`,
    `status    ${d.status}`,
    `restates  ${restates.length > 0 ? restates.join(', ') : '(no rule cites it)'}`,
  ];
  if (d.supersededBy) lines.push(`SUPERSEDED by ${d.supersededBy} - this record is retained as evidence, not as policy.`);
  if (d.supersedes.length > 0) lines.push(`supersedes  ${d.supersedes.join(', ')}`);
  const partialForward = (d.supersedesRulings ?? []).filter((s) => s.ruling !== null);
  if (partialForward.length > 0) {
    lines.push(
      `supersedes  ${partialForward.map((s) => `${s.adr} ruling ${s.ruling} (${s.kind})`).join('; ')}`,
    );
  }
  // A partial supersession is named here as well as on the ruling it moved, because the
  // two print different sets: this prints every ruling the record lost, and the
  // annotation prints the ones inside the excerpt below. A ruling past the excerpt
  // exists in the estate but not in this output, and the status line above is the only
  // other place it appears - which is the sentence the parser used to truncate.
  if (d.partial.length > 0) {
    lines.push(
      `partial    ${d.partial
        .map((p) => `ruling ${p.ruling ?? '(not numbered)'} ${p.kind} by ${p.by ?? 'an unnamed record'}`)
        .join('; ')}`,
    );
  }

  // A superseded record must not print its own ruling. ADR-011 ruled that Windows is
  // supported; ADR-012 reversed it the same day. Printing "Windows is a supported v1
  // platform" under a SUPERSEDED banner is a reversed instruction with a warning
  // attached, and an agent that skims the ruling and not the banner acts on the
  // reversal. This is the failure the decision index's own header names: a provenance
  // feature that proves provenance but not currency.
  const replacement = facts.replacement;
  const effective = replacement ?? d;

  if (replacement) {
    lines.push(
      '',
      `instead     ${replacement.id} - ${replacement.title}`,
      `            status ${replacement.status}`,
    );
  }

  // The reason the ruling is printed at all, and not a pointer to this command: the
  // reader arrived here from a `(ADR-NNN)` citation in a rule, and the only question
  // that citation raises is "why am I being told this?". A title and a status answer
  // "does it exist and is it current", which is the smaller half.
  //
  // `## Context` is deliberately absent. It is a survey of what particular
  // repositories used to say - true, citable, and following none of it from a repo
  // that owns none of those files.
  if (effective.summary.ruled.length > 0) {
    lines.push('', replacement ? 'ruled now' : 'ruled');
    for (const r of effective.summary.ruled) lines.push(`  - ${redactEstate(r)}`);
    // The count, because the excerpt above is two rulings and a record may carry eight.
    // Without it the header reads as a claim about everything the record settled, which
    // is how a reader goes looking for a ruling that was never printed and concludes it
    // does not exist.
    const shown = effective.summary.ruled.length;
    const total = effective.summary.rulingCount ?? shown;
    if (total > shown) {
      lines.push(
        `  (${shown} of ${total} rulings shown; the rest: ${CLI} rules why ${effective.id} --all)`,
      );
    }
  }
  if (effective.summary.rejected.length > 0) {
    // The rejected alternatives are the part a reader cannot reconstruct. A ruling is
    // only legible against the option it refused. Estate names in that option are
    // redacted: they name files the reader does not have.
    lines.push('', 'rejected');
    for (const r of effective.summary.rejected) lines.push(`  - ${redactEstate(r)}`);
  }
  if (effective.summary.writtenAgainst.length > 0) {
    lines.push(
      '',
      'written against  repositories this record surveyed',
      '                the ruling above is the part that generalises; those files are not yours.',
    );
  }

  emit(lines.join('\n'), { maxBytes: flags.maxBytes ?? 0 });
  // A superseded record is not a failure; it is the supersession rule working.
  // The caller asked a question and got a true answer.
  return EXIT.OK;
}

// --- decisions ------------------------------------------------------------------

/**
 * `simt rules decisions`: every known decision record, both layers.
 *
 * The shipped records underlay the repository's own, which win on a number
 * collision (review 0003 Q34). The column that matters is `origin`: a reader in
 * a consumer repository must be able to tell the package's ADR-001 from their
 * own, because they are two records that happen to share a number.
 */
export async function decisionsCommand(args, flags) {
  const root = flags.root ?? null;
  const { ok, decisions, errors, origins } = await loadDecisionsFor(root, flags.all === true);
  if (!ok) {
    return fail(errors[0], EXIT.CONFIG, 'the decision records must be readable to list them');
  }
  const rows = [...decisions]
    .sort((a, b) => Number(a.id.replace(/^ADR-/i, '')) - Number(b.id.replace(/^ADR-/i, '')))
    .map((d) => ({
      id: d.id,
      title: d.title,
      status: d.status,
      origin: origins[d.id] ?? 'package',
      supersededBy: d.supersededBy ?? null,
      file: d.file,
    }));

  if (isJson(flags)) {
    emitJson({ ok: true, command: 'rules decisions', root, decisions: rows });
    return EXIT.OK;
  }

  const repo = rows.filter((r) => r.origin === 'repo').length;
  const lines = [
    `${rows.length} decisions${root && repo > 0 ? ` (${repo} from this repo overlay the shipped set)` : ''}`,
    '',
    'id       origin   title',
  ];
  for (const r of rows) {
    const head = r.status.length > 80 ? `${r.status.slice(0, 80)}...` : r.status;
    lines.push(`${r.id.padEnd(8)}  ${r.origin.padEnd(7)}  ${r.title} — ${head}`);
  }
  emit(lines.join('\n'), { maxBytes: flags.maxBytes ?? 0 });
  return EXIT.OK;
}