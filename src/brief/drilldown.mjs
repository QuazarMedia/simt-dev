import { CLI } from '../name.mjs';
import { shellWord } from '../sys/proc.mjs';
import { cmp } from '../util/sort.mjs';

export function parseSubtaskId(value) {
  if (value === undefined || value === null) return null;
  const text = String(value);
  const number = Number(text);
  return /^\d+$/u.test(text) && Number.isSafeInteger(number) && number > 0 ? number : NaN;
}

export function detailCommands(task, subjects, { paths = null, selected = null } = {}) {
  return subjects.map((subject) => {
    const id = subject.id;
    const base = CLI + ' brief --retrieval v2 --subtask ' + id + ' --budget 4096 --task=' + shellWord(task);
    const command = paths === null ? base : base + ' --paths=' + shellWord(paths.join(','));
    const path = subject.files[0]?.path;
    return {
      id, command,
      ...(selected === null ? {} : { selected: selected === id }),
      ...(path ? { compactCommand: CLI + ' impact -- ' + shellWord(path) } : {}),
    };
  });
}

const ENUMERATED = new Set(['FILES', 'TESTS', 'DECISIONS', 'SKILLS', 'LESSONS', 'CAUTIONS', 'KNOWLEDGE', 'FEDERATION', 'ADVICE']);

export function subtaskCoverage(subjects, rows, cut) {
  const coverage = new Map(subjects.map(({ id }) => [id, { id, available: 0, kept: 0, facets: {} }]));
  const removed = new Set(cut);
  for (const item of rows) {
    if (!ENUMERATED.has(item.section)) continue;
    for (const id of item.subtaskIds) {
      const result = coverage.get(id);
      const kept = !removed.has(item.id);
      const facet = result.facets[item.section] ?? { available: 0, kept: 0 };
      result.available += 1;
      facet.available += 1;
      if (kept) {
        result.kept += 1;
        facet.kept += 1;
      }
      result.facets[item.section] = facet;
    }
  }
  return [...coverage.values()];
}

export function drillFooter(subjects, commands, maxBytes) {
  const byId = new Map(commands.map((row) => [row.id, row]));
  const fits = (line) => Buffer.byteLength(line) <= maxBytes && !line.includes('\n') && !line.includes('\r');
  return (rows, cut) => {
    if (!cut.length) return '';
    const coverage = subtaskCoverage(subjects, rows, cut);
    const always = 'cut ' + cut.length + ' items';
    const summary = coverage.map(({ id, kept, available }) => 'T' + id + ' ' + kept + '/' + available).join(', ');
    const prefix = fits(always + ' · ' + summary) ? always + ' · ' + summary : always;
    const underserved = coverage.filter(({ kept, available }) => kept < available)
      .sort((a, b) => a.kept / a.available - b.kept / b.available || a.id - b.id);
    const first = byId.get(underserved[0]?.id ?? subjects[0]?.id);
    const withPrefix = (command, lead = prefix) => lead + '; drill down: ' + command;
    for (const candidate of [first?.command, first?.compactCommand].filter(Boolean)) {
      if (fits(withPrefix(candidate))) return withPrefix(candidate);
      if (fits(withPrefix(candidate, always))) return withPrefix(candidate, always);
    }
    return fits(prefix) ? prefix : '';
  };
}

export function explainComposite(result) {
  const items = new Map(result.items.map((item) => [item.id, item]));
  const kept = new Set(result.packed.trace.map(({ id }) => id));
  const lines = result.packed.trace.map(({ id, bytes, gain, gainPerByte }) => {
    const { section, text, subtaskIds } = items.get(id);
    const tasks = subtaskIds.map((value) => 'T' + value).join(',');
    return 'keep ' + section + (tasks ? ' [' + tasks + ']' : '') + ' · ' + bytes + ' B · gain '
      + gain.toFixed(6) + ' · ' + (gainPerByte?.toFixed(6) ?? 'free') + '/B · ' + text.split('\n')[0];
  });
  for (const { id, section, text } of result.items) if (!kept.has(id)) lines.push('cut ' + section + ' · ' + text.split('\n')[0]);
  for (const task of result.composite.subtasks) {
    for (const { term, sources } of task.feedback?.expansion ?? []) {
      lines.push('T' + task.id + ' feedback ' + term + ' from ' + sources.join(', '));
    }
    for (const { path, channels } of [...task.evidence].sort((a, b) => cmp(a.path, b.path))) {
      const witness = channels.directional?.witness;
      if (witness) lines.push('T' + task.id + ' ' + path + ' via ' + witness.seed + ' → '
        + witness.steps.map(({ kind, dst }) => kind + ' ' + dst).join(' → '));
    }
  }
  return lines;
}
