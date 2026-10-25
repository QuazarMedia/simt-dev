// The distiller's engines (plan 0003 R38).
//
// `simt distill` writes a budgeted summary of a skill body or doc, with every claim
// citing the source line range it rests on. Two engines produce that shape:
//
//   - `outline` (default): a deterministic, extractive summary — the heading
//     skeleton plus the first content of each section, cut to the budget. No
//     model, no network, byte-stable: the same text at the same budget produces
//     the same bytes forever (P1, P4).
//   - `local`: the configured local chat model (R37) proposes a abstractive
//     summary. It is opt-in (`--local`), loopback-only by default, and its output
//     is verified against the source before anything is written.
//
// Both engines write the same artefact: a *proposal*, never a projection. The
// proposal file carries its provenance in frontmatter (source, digest, engine,
// prompt hash for the model path); a human merges it into the pack or repo, and
// nothing in this module ever edits a source file (ADR-090/ADR-075, principle P2).

import { createHash } from 'node:crypto';

export const ENGINE_OUTLINE = 'outline';
export const ENGINE_LOCAL = 'local';

/**
 * The cache key: source digest plus the recipe that shaped the output. Two
 * proposals of the same text at different budgets are different answers, so one
 * key carries both rather than letting a second write collide with the first.
 */
export function digestOf(text, engine, budget) {
  const h = createHash('sha256');
  h.update(`${engine}\0${budget}\0${text}`);
  return `sha256-${h.digest('hex').slice(0, 16)}`;
}

/** Same function for the source itself, where the recipe does not apply. */
export function sourceDigest(text) {
  return `sha256-${createHash('sha256').update(text).digest('hex').slice(0, 16)}`;
}

/** The hash of the prompt sent to a model engine — the provenance P2 asks for. */
export function promptHash(prompt) {
  return `sha256-${createHash('sha256').update(prompt).digest('hex').slice(0, 16)}`;
}

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^#{1,6}\s/;

/**
 * Build the prompt a local model receives (ENGINE_LOCAL only).
 *
 * The source ships with line numbers printed, because the only citation format
 * the verifier can check is `[L<n>-<m>]` against those numbers. A model asked to
 * "cite the source" but given unnumbered text can only guess, and every guess is
 * a citation that looks true and cannot be checked — which is the defect this
 * command exists to prevent.
 */
export function buildLocalPrompt(fileName, text, budget) {
  const numbered = text
    .split('\n')
    .map((line, i) => `${i + 1}: ${line}`)
    .join('\n');
  return [
    'Distill the document below into what an agent must know to act on it.',
    `The summary must not exceed ${budget} bytes. Rules:`,
    '- Every claim ends with a citation to a source line range, written [L12] or [L12-L15], using the line numbers printed below.',
    '- Cite only lines that exist in the source. Never cite a line you cannot see.',
    '- Copy commands, paths, thresholds and names verbatim; do not paraphrase them.',
    '- Do not invent content, and do not add advice the source does not contain.',
    `- Reply with the summary only; nothing else.`,
    '',
    `SOURCE ${fileName}`,
    numbered,
  ].join('\n');
}

/**
 * The deterministic extractive engine (ENGINE_OUTLINE).
 *
 * Selection, readable as a score: every heading first (they are the document's
 * own structure), then the immediate non-empty content under each heading. The
 * result is the document in its own words, in document order, at a fraction of
 * the bytes — which is the comparison the acceptance criterion asks the bench to
 * run, and the honest thing an offline engine can claim.
 *
 * Bounds: the returned body never exceeds `budget` bytes (0 = unlimited), and
 * every line it renders carries a citation the verifier below can check.
 */
export function outlineSummary(text, budget) {
  const lines = text.split('\n');
  const picks = [];
  let inline = false;

  // Pass 1: headings.
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (FENCE.test(line)) inline = !inline;
    if (inline) continue;
    if (HEADING.test(line)) picks.push(i);
  }

  // Pass 2: the first content line under each heading.
  for (const i of [...picks]) {
    for (let j = i + 1; j < lines.length; j += 1) {
      if (FENCE.test(lines[j])) break;
      if (HEADING.test(lines[j])) break;
      if (lines[j].trim() === '') continue;
      picks.push(j);
      break;
    }
  }

  if (picks.length === 0 && lines.some((l) => l.trim() !== '')) {
    // No headings at all: a doc of prose. The whole thing is one section, so the
    // first content line is the citation anchor rather than an empty summary.
    const first = lines.findIndex((l) => l.trim() !== '' && !FENCE.test(l));
    if (first !== -1) picks.push(first);
  }

  picks.sort((a, b) => a - b);

  const body = [];
  let used = 0;
  for (const i of picks) {
    const text = lines[i].trimEnd();
    const bullet = `>[L${i + 1}] ${text}`;
    const cost = Buffer.byteLength(`${bullet}\n`, 'utf8');
    if (budget > 0 && used + cost > budget) break;
    used += cost;
    body.push(bullet);
  }

  return { engine: ENGINE_OUTLINE, body: body.join('\n'), citations: body.length, budgetUsed: used };
}

/**
 * Check a summary's citations against the source that supposedly backs them.
 *
 * A citation naming a line past the end of the source is fabricated; a summary
 * with any such citation is returned with `--json` detailed faults and is never
 * silently trusted. The proposal still writes (it is only a proposal), but its
 * provenance records `verified: false` so a reader cannot mistake it for checked
 * output (ADR-083).
 */
export function verifyCitations(body, sourceLineCount) {
  const faults = [];
  const ranges = [];
  const re = /\[L(\d+)(?:-L?(\d+))?\]/g;
  let match;
  while ((match = re.exec(body)) !== null) {
    const start = Number(match[1]);
    const end = match[2] === undefined ? start : Number(match[2]);
    const kind =
      start < 1 || start > sourceLineCount
        ? `start`
        : end < start
          ? `order`
          : end > sourceLineCount
            ? `end`
            : null;
    if (kind !== null) {
      faults.push(`citation [L${start}-L${end}] ${kind} outside the source (1..${sourceLineCount})`);
      continue;
    }
    ranges.push({ start, end });
  }
  return { ok: faults.length === 0, ranges, faults };
}

/** The proposal file's frontmatter. No wall-clock value here: byte-stable (P4). */
export function proposalFrontmatter({ source, digest, engine, budget, prompt, verified, verdict, advisory }) {
  return [
    '---',
    `source: ${source}`,
    `digest: ${digest}`,
    `engine: ${engine}`,
    `budget: ${budget}`,
    prompt ? `prompt: ${prompt}` : null,
    verdict ? `verdict: ${verdict}` : null,
    advisory ? 'advisory: true' : null,
    verified === false ? 'verified: false' : 'verified: true',
    'status: proposal',
    '---',
    '',
  ]
    .filter((l) => l !== null)
    .join('\n');
}
