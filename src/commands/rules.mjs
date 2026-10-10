// `simt-dev rules` - the rule catalogue and its provenance.
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

import { EXIT, emit, fail, isJson } from '../output/index.mjs';
import { loadRules, select } from '../projection/project.mjs';
import { fingerprint } from '../resolve/fingerprint.mjs';
import { byId, citations, loadDecisions, redactEstate } from '../decisions/index.mjs';
import { nearMatches } from '../resolve/near.mjs';
import { CLI } from '../name.mjs';

const kb = (bytes) => `${(bytes / 1000).toFixed(1)}k`;

/** `simt-applies` is the string "always" for core and an array for profiles. */
function appliesLabel(rule) {
  if (rule.applies === 'always') return 'always';
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
  return { rules, broken };
}

// --- list ---------------------------------------------------------------------

export async function listCommand(args, flags) {
  const root = flags.root ?? null;
  const { rules, broken } = await load(root);

  // With --root the question becomes "which of these apply to me", which is a
  // different answer from the catalogue and the one an agent usually wants.
  const selection = root ? await selectionFor(rules, root) : null;

  if (isJson(flags)) {
    emit(
      `${JSON.stringify(
        {
          ok: broken.length === 0,
          command: 'rules list',
          root,
          rules: sorted(rules).map((r) => ({
            id: r.id,
            title: r.title,
            origin: r.origin,
            source: r.source,
            applies: r.applies,
            fallback: r.fallback,
            bytes: r.bytes,
            error: r.error,
            adrs: citations(r.body),
            selected: selection ? selection.selected.has(r.id) : null,
          })),
          notes: selection?.notes ?? [],
        },
        null,
        2,
      )}\n`,
      { maxBytes: flags.maxBytes ?? 0 },
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
    const mark = selection && selection.selected.has(rule.id) ? '*' : ' ';
    lines.push(
      render(mark, rule.id, kb(rule.bytes), rule.origin, appliesLabel(rule), rule.title ?? '(no title)'),
    );
  }

  for (const rule of broken) {
    lines.push('', `BROKEN  ${rule.source}: ${rule.error}`);
  }
  if (selection) {
    lines.push('', `* selected for ${root}`);
    for (const note of selection.notes) lines.push(`  note ${note}`);
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

// --- show ---------------------------------------------------------------------

export async function showCommand(args, flags) {
  const id = args[0];
  if (!id) return fail('rules show needs a rule id', EXIT.USAGE, `usage: ${CLI} rules show <id>`);

  const { rules, broken } = await load(flags.root ?? null);
  const rule = rules.find((r) => r.id === id);
  if (!rule) return unknown(id, rules);

  const adrs = citations(rule.body);
  if (isJson(flags)) {
    emit(`${JSON.stringify({ ok: !rule.error, ...rule, adrs }, null, 2)}\n`, { maxBytes: flags.maxBytes ?? 0 });
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

  const { rules, broken } = await load(flags.root ?? null);
  const { ok, decisions, errors } = await loadDecisions();
  if (!ok) return fail(errors[0], EXIT.CONFIG, 'the decision records must be readable for provenance to work');

  return what.match(/^ADR-\d{3}$/i)
    ? adrDirection(what.toUpperCase(), rules, decisions, flags)
    : ruleDirection(what, rules, decisions, flags, broken);
}

async function ruleDirection(id, rules, decisions, flags, broken) {
  const rule = rules.find((r) => r.id === id);
  if (!rule) return unknown(id, rules);

  const cited = citations(rule.body);
  const index = byId(decisions);

  if (isJson(flags)) {
    emit(
      `${JSON.stringify(
        {
          ok: true,
          command: 'rules why',
          rule: rule.id,
          source: rule.source,
          origin: rule.origin,
          adrs: cited.map((c) => index.get(c) ?? { id: c, missing: true }),
          uncited: cited.length === 0,
        },
        null,
        2,
      )}\n`,
      { maxBytes: flags.maxBytes ?? 0 },
    );
    return EXIT.OK;
  }

  const lines = [`${rule.id} - ${rule.title ?? '(no title)'}`, '', `source  ${rule.source} (${rule.origin})`];

  if (cited.length === 0) {
    lines.push(
      '',
      'provenance  NONE',
      '  this rule cites no decision, so nothing settles it and nothing can overturn it.',
      '  Either cite the ADR that produced it, or accept that it is this repo\'s own policy.',
    );
    emit(lines.join('\n'), { maxBytes: flags.maxBytes ?? 0 });
    return EXIT.OK;
  }

  lines.push('', `settled by ${cited.length} decision${cited.length === 1 ? '' : 's'}`);
  for (const adr of cited) {
    const d = index.get(adr);
    if (!d) {
      lines.push(`  ${adr}  MISSING - the rule cites it, but this installation has no record of it`);
      continue;
    }
    lines.push(`  ${d.id}  ${d.title}`);
    lines.push(`          ${d.status}`);
    if (d.supersededBy) {
      // Never print a reversed ruling as if it were current.
      lines.push(`          SUPERSEDED by ${d.supersededBy} - read that record instead`);
    }
  }

  // The reverse edge is what makes this useful for maintaining the set: which
  // rules would a change to one decision touch?
  const others = rules.filter((r) => r.id !== rule.id && citations(r.body).some((c) => cited.includes(c)));
  if (others.length > 0) {
    lines.push('', `shares a decision with ${others.map((r) => r.id).join(', ')}`);
  }

  emit(lines.join('\n'), { maxBytes: flags.maxBytes ?? 0 });
  return EXIT.OK;
}

async function adrDirection(adr, rules, decisions, flags) {
  const d = decisions.find((x) => x.id === adr);
  if (!d) {
    // Was 'list them with: ls docs/decisions/' - a path relative to simt-dev's own
    // tree, which resolves to nothing in the repo the reader is standing in. The
    // remedy must be a command they can run.
    return fail(`no decision record ${adr}`, EXIT.USAGE, `list the known decisions with: ${CLI} rules list`);
  }

  const restates = rules.filter((r) => citations(r.body).includes(d.id));

  if (isJson(flags)) {
    // The machine payload answers the same question as the text one. A caller reading
    // `adr.summary.ruled` off a superseded record would get the reversal, so the
    // effective ruling is carried alongside rather than instead: the record asked about
    // is still named, and what is in force is named separately.
    const replacement = d.supersededBy ? decisions.find((x) => x.id === d.supersededBy) : null;
    emit(
      `${JSON.stringify(
        {
          ok: true,
          command: 'rules why',
          adr: d,
          supersededBy: replacement ? { id: replacement.id, title: replacement.title } : null,
          inForce: replacement
            ? { id: replacement.id, status: replacement.status, summary: replacement.summary }
            : { id: d.id, status: d.status, summary: d.summary },
          rules: restates.map((r) => r.id),
        },
        null,
        2,
      )}\n`,
      { maxBytes: flags.maxBytes ?? 0 },
    );
    return EXIT.OK;
  }

  const lines = [
    `${d.id} - ${d.title}`,
    '',
    `status    ${d.status}`,
    `restates  ${restates.length > 0 ? restates.map((r) => r.id).join(', ') : '(no rule cites it)'}`,
  ];
  if (d.supersededBy) lines.push(`SUPERSEDED by ${d.supersededBy} - this record is retained as evidence, not as policy.`);
  if (d.supersedes.length > 0) lines.push(`supersedes  ${d.supersedes.join(', ')}`);
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
  const replacement = d.supersededBy ? decisions.find((x) => x.id === d.supersededBy) : null;
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

function unknown(id, rules) {
  const near = nearMatches(id, rules.map((r) => r.id));
  return fail(
    `no rule with id "${id}"${near.length > 0 ? ` (did you mean ${near.join(', ')}?)` : ''}`,
    EXIT.USAGE,
    `run: ${CLI} rules list`,
  );
}