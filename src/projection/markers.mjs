// The generated-region primitive.
//
// This is the whole reason the estate can share rules without a git submodule and
// without a runtime symlink (docs/plans/0001 section 2.2). A repo keeps its own
// hand-written AGENTS.md; simt-dev owns only the bytes between two markers.
//
// The four properties that make it safe to hand to 16 repos:
//
//   idempotent   injecting the same body twice yields identical bytes, so `sync`
//                never produces a spurious diff and CI never flakes
//   contained    bytes outside the markers are never touched, so hand-written
//                content cannot be clobbered by a projection
//   diagnosable  the region records which simt-dev SHA produced it, so drift is
//                detectable rather than invisible (ADR: 0001 section 7)
//   honest       a malformed region is reported as malformed instead of being
//                silently appended to, which is how a projection engine quietly
//                duplicates a rule

export const BEGIN = '<!-- simt-dev:begin -->';
export const END = '<!-- simt-dev:end -->';

/** Marker styles accepted on input, normalised on output. */
const BEGIN_PATTERNS = [/^<!--\s*simt-dev:begin\s*-->$/i];
const END_PATTERNS = [/^<!--\s*simt-dev:end\s*-->$/i];

const FENCE = /^\s*(`{3,}|~{3,})/;

/**
 * Split a document into the parts around the generated region.
 *
 * @param {string} text
 * @returns {{status: 'absent'|'ok'|'malformed', before: string, body: string,
 *            after: string, reason?: string, sha?: string}}
 */
export function parse(text) {
  const lines = text.split('\n');
  const absent = { status: 'absent', before: text, body: '', after: '' };

  const markers = [];
  let fence = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // Markers inside a fenced block are documentation, not control. An AGENTS.md
    // that explains this mechanism with an example must not confuse the engine.
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      const char = fenceMatch[1][0];
      if (fence === null) fence = char;
      else if (fence === char) fence = null;
      continue;
    }
    if (fence !== null) continue;
    if (BEGIN_PATTERNS.some((p) => p.test(line))) markers.push({ kind: 'begin', i });
    else if (END_PATTERNS.some((p) => p.test(line))) markers.push({ kind: 'end', i });
  }

  if (markers.length === 0) return absent;

  const first = markers[0];
  if (first.kind !== 'begin') {
    return malformed(lines, 0, first.i, 'end marker before any begin marker');
  }
  const last = markers[markers.length - 1];
  if (last.kind !== 'end') {
    return malformed(lines, first.i, first.i, 'begin marker with no matching end marker');
  }

  const between = markers.slice(1, -1);
  const strayBegin = between.find((m) => m.kind === 'begin');
  if (strayBegin) {
    return malformed(lines, first.i, strayBegin.i, 'nested begin marker');
  }
  const strayEnd = between.find((m) => m.kind === 'end');
  if (strayEnd) {
    return malformed(lines, first.i, strayEnd.i, 'nested end marker');
  }
  if (markers.length > 2 && markers.slice(1).some((m) => m.kind === 'end' && m.i < last.i)) {
    return malformed(lines, first.i, last.i, 'more than one region');
  }

  const body = lines.slice(first.i + 1, last.i).join('\n');
  const sha = readSha(body);
  return {
    status: 'ok',
    before: lines.slice(0, first.i).join('\n'),
    body,
    after: lines.slice(last.i + 1).join('\n'),
    sha,
  };
}

function malformed(lines, from, at, reason) {
  return {
    status: 'malformed',
    before: lines.join('\n'),
    body: '',
    after: '',
    reason,
    line: at + 1,
    fromLine: from + 1,
  };
}

/** Pull the recorded source SHA out of the region's provenance header. */
function readSha(body) {
  const m = /<!--\s*simt-dev:sha=([0-9a-f]{7,40})\s*-->/.exec(body);
  return m ? m[1] : undefined;
}

/**
 * Render the full region text, markers and provenance header included.
 * The header lives *inside* the region so it regenerates with the body and can
 * never drift independently of it.
 */
export function compose(body, { sha, sources = [] } = {}) {
  const header = [
    '<!-- simt-dev:generated -->',
    sha ? `<!-- simt-dev:sha=${sha} -->` : '<!-- simt-dev:sha=unknown -->',
  ];
  if (sources.length > 0) {
    header.push(`<!-- simt-dev:sources=${sources.join(',')} -->`);
  }
  header.push(
    '<!-- Edit the source in simt-dev and run: simt sync. Edits here are overwritten. -->',
  );
  const trimmed = body.replace(/\n+$/, '');
  return [BEGIN, ...header, ...(trimmed === '' ? [] : trimmed.split('\n')), END].join('\n');
}

/**
 * Insert or replace the region in `text`, preserving everything outside it.
 *
 * @returns {{text: string, action: 'added'|'updated'|'unchanged'|'malformed', reason?: string}}
 */
export function inject(text, body, meta) {
  const state = parse(text);
  if (state.status === 'malformed') {
    return { text, action: 'malformed', reason: state.reason, line: state.line };
  }
  const region = compose(body, meta);

  if (state.status === 'absent') {
    const base = text.endsWith('\n') || text === '' ? text : `${text}\n`;
    const needsLeadingBlank = base !== '' && !base.endsWith('\n\n');
    return {
      text: `${base}${needsLeadingBlank ? '\n' : ''}${region}\n`,
      action: 'added',
    };
  }

  // Compare ignoring only the trailing newline the region may pick up from the
  // document; any other byte difference is real drift worth rewriting.
  const current = state.body.replace(/^\n+/, '').replace(/\n+$/, '');
  const next = region.slice(BEGIN.length + 1, region.length - END.length - 1);
  const unchanged = current === next.replace(/^\n+/, '').replace(/\n+$/, '');

  if (unchanged) return { text, action: 'unchanged' };

  const before = state.before.endsWith('\n') || state.before === '' ? state.before : `${state.before}\n`;
  const after = state.after.startsWith('\n') ? state.after : state.after === '' ? '' : `\n${state.after}`;
  return { text: `${before}${region}${after}`, action: 'updated' };
}

/**
 * Compare a document against a desired region body without writing.
 * `meta` must be the same provenance the writer would use, so a region produced
 * by an older simt-dev SHA reads as drift rather than as unchanged.
 *
 * @returns {{action: 'added'|'updated'|'unchanged'|'malformed', reason?: string, line?: number}}
 */
export function diff(text, body, meta) {
  const state = parse(text);
  if (state.status === 'malformed') {
    return { action: 'malformed', reason: state.reason, line: state.line };
  }
  if (state.status === 'absent') return { action: 'added' };
  const probe = inject(text, body, meta);
  return { action: probe.action };
}