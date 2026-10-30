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

// The comment syntax a managed file speaks, and where in it the region goes.
//
// A marker has to be invisible to the tool that reads the file the region lives in,
// so the syntax is a property of the FILE, not of this module. Markdown and every
// `.mdc` are HTML comments; `.editorconfig` is INI, where `#` is the comment
// character and an HTML comment would be parsed as a malformed key and make every
// editor fall back to its own defaults - the file would be worse than absent.
//
// `where: 'top'` exists for the same reason. In a file whose semantics are
// last-definition-wins, a shared block appended below the repo's own settings
// silently overrules them. No byte is removed, so nothing looks clobbered, and the
// repo's setting simply stops taking effect. Putting the shared block first means
// the repo always wins, and `check` reports a region that has been moved down.
import { CLI, MARKER_PREFIX, MARKER_PREFIX_LEGACY } from '../name.mjs';

// The region namespace moved with the command (ADR-056), like the manifest. The read
// regexes accept both spellings, so a repository still stamped with the legacy prefix
// is seen rather than reported as unadopted, and the first sync migrates it in place:
// the composed region carries only the new prefix, so the body comparison in `inject`
// finds drift and rewrites it. Writing never emits the legacy spelling, so the window
// closes on every write. A file holding BOTH regions is a state only a hand edit can
// make; the marker validation below reports it as malformed instead of guessing which
// region wins, and a human deletes the old one.
//
// Both prefixes are pinned to literals in test/naming.test.mjs, so they carry nothing
// that needs escaping inside the regexes built here.
const PREFIX = `(?:${MARKER_PREFIX}|${MARKER_PREFIX_LEGACY})`;

export const STYLES = {
  html: {
    begin: `<!-- ${MARKER_PREFIX}:begin -->`,
    end: `<!-- ${MARKER_PREFIX}:end -->`,
    line: (s) => `<!-- ${s} -->`,
    note: (first, second) => `<!-- ${first}\n     ${second} -->`,
    sha: new RegExp(`<!--\\s*${PREFIX}:sha=([0-9a-f]{7,40})\\s*-->`),
    beginRe: new RegExp(`^<!--\\s*${PREFIX}:begin\\s*-->$`, 'i'),
    endRe: new RegExp(`^<!--\\s*${PREFIX}:end\\s*-->$`, 'i'),
    where: 'bottom',
  },
  hash: {
    begin: `# ${MARKER_PREFIX}:begin`,
    end: `# ${MARKER_PREFIX}:end`,
    line: (s) => `# ${s}`,
    note: (first, second) => `# ${first}\n# ${second}`,
    sha: new RegExp(`^#\\s*${PREFIX}:sha=([0-9a-f]{7,40})\\s*$`, 'm'),
    beginRe: new RegExp(`^#\\s*${PREFIX}:begin\\s*$`, 'i'),
    endRe: new RegExp(`^#\\s*${PREFIX}:end\\s*$`, 'i'),
    where: 'top',
  },
};

export const BEGIN = STYLES.html.begin;
export const END = STYLES.html.end;

/**
 * The separator between hand-written text and the region, in the shape a Markdown
 * formatter insists on.
 *
 * Markdown treats an HTML comment that follows a paragraph, a list, a fenced block
 * or a heading as a new block, and every formatter inserts the blank line separating
 * the two before writing it back. Measured with Prettier 3.8.1: a region appended
 * after one newline comes back rewritten, and `--check` exits 1 — on a file the
 * projection got right and the repository's own gate is simply enforcing. The
 * projection emits the formatter's shape from the start, for the same reason it
 * emits the trailing newline `compose` already owns.
 *
 * Note the list case is worse than a blank line: without one, Prettier reads the
 * region as a continuation of the last list item and indents all of it.
 */
function seam(before) {
  if (before === '') return '';
  return before.endsWith('\n\n') ? before : `${before.replace(/\n+$/, '')}\n\n`;
}

function styleOf(style) {
  return typeof style === 'string' ? (STYLES[style] ?? STYLES.html) : (style ?? STYLES.html);
}

const FENCE = /^\s*(`{3,}|~{3,})/;

/**
 * Split a document into the parts around the generated region.
 *
 * @param {string} text
 * @param {string|object} [style] a key of `STYLES`, or a style row
 * @returns {{status: 'absent'|'ok'|'malformed', before: string, body: string,
 *            after: string, reason?: string, sha?: string}}
 */
export function parse(text, style) {
  const s = styleOf(style);
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
    if (s.beginRe.test(line)) markers.push({ kind: 'begin', i });
    else if (s.endRe.test(line)) markers.push({ kind: 'end', i });
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
  const sha = readSha(body, s);
  return {
    status: 'ok',
    before: lines.slice(0, first.i).join('\n'),
    body,
    after: lines.slice(last.i + 1).join('\n'),
    sha,
    // The last byte of the end marker. A reader that stops at a fixed offset never
    // sees a region whose end is past that offset, however correct the body is.
    endByte: Buffer.byteLength(lines.slice(0, last.i + 1).join('\n')),
  };
}

/**
 * The line spans of every generated region in `text`, across both marker styles.
 *
 * `parse` is the single reader: a malformed region is still a region (an edit
 * anywhere in the file stays denied), so malformed counts as a span covering the
 * whole file rather than as absent. Line numbers are 1-based and inclusive.
 *
 * @returns {{malformed: boolean, spans: Array<{start: number, end: number}>}}
 */
export function regionSpans(text) {
  const spans = [];
  let malformed = false;
  for (const style of ['html', 'hash']) {
    const state = parse(text, style);
    if (state.status === 'malformed') {
      malformed = true;
      continue;
    }
    if (state.status !== 'ok') continue;
    const start = state.before === '' ? 1 : state.before.split('\n').length + 1;
    const bodyLines = state.body === '' ? 0 : state.body.split('\n').length;
    spans.push({ start, end: start + bodyLines + 1 });
  }
  if (malformed) {
    const total = text.split('\n').length;
    return { malformed: true, spans: [{ start: 1, end: total }] };
  }
  return { malformed: false, spans };
}

/** Line range of `text.slice(index, index + length)`, 1-based and inclusive. */
export function lineRangeOf(text, index, length) {
  const start = text.slice(0, index).split('\n').length;
  const end = text.slice(0, index + length).split('\n').length;
  return { start, end };
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
function readSha(body, style) {
  const m = style.sha.exec(body);
  return m ? m[1] : undefined;
}

/**
 * Render the full region text, markers and provenance header included.
 * The header lives *inside* the region so it regenerates with the body and can
 * never drift independently of it.
 */
export function compose(body, { sha, sources = [] } = {}, style) {
  return render(body, { sha, sources }, style, (s, sha, sources) =>
    [
      s.line(`${MARKER_PREFIX}:generated`),
      s.line(`${MARKER_PREFIX}:sha=${sha}`),
      ...(sources.length > 0 ? [s.line(`${MARKER_PREFIX}:sources=${sources.join(',')}`)] : []),
      // Addressed to whoever reads this repo, not to whoever owns the rules upstream.
      // "Edit the source in simt-dev" was the wrong instruction twice over: a consumer
      // of the published package has no such tree, and an agent reading this repo has
      // no business editing the region it was told not to edit. The only two actions
      // available to a reader are: don't edit it, or regenerate it.
      s.note(
        'Generated content. Do not edit by hand - your changes are overwritten.',
        `Run \`${CLI} sync --yes\` to regenerate, or \`${CLI} check\` to see what is stale.`,
      ),
    ],
  );
}

/**
 * The user-level shared region (ADR-084).
 *
 * A different note from `compose`, and the difference is the whole point of having two
 * functions. `compose`'s remedy is `simt sync --yes`, and that remedy is wrong for a file
 * in the reader's home directory: `sync` acts on a repository, so a reader who follows
 * the instruction inside `~/.config/opencode/AGENTS.md` runs a command that will not
 * repair it and concludes the projection is broken. The stamp and the marker grammar are
 * shared, so `parse`, `inject` and `diff` read this region exactly as they read a
 * repository's own — only the two sentences a reader acts on differ.
 */
export function composeShared(body, { sha, sources = [] } = {}, style) {
  return render(body, { sha, sources }, style, (s, sha, sources) =>
    [
      s.line(`${MARKER_PREFIX}:generated`),
      s.line(`${MARKER_PREFIX}:sha=${sha}`),
      ...(sources.length > 0 ? [s.line(`${MARKER_PREFIX}:sources=${sources.join(',')}`)] : []),
      s.note(
        'Generated content shared by every repository in this workspace. Do not edit it by hand - your changes are overwritten.',
        `Run \`${CLI} shared install --yes\` to regenerate it, or \`${CLI} doctor\` to see whether this copy is stale.`,
      ),
    ],
  );
}

/**
 * A region, markers and provenance header included, with a header this module chose.
 *
 * Split out because two headers now exist and the trailing-newline and empty-body cases
 * below are load-bearing twice over — the formatter fight the header shape prevents does
 * not care which of the two files it is happening in.
 */
function render(body, { sha, sources = [] }, style, headerLines) {
  const s = styleOf(style);
  // A stamp this tool cannot read back is worse than no stamp: `parse` matches
  // `[0-9a-f]{7,40}`, so the old `unknown` fallback produced a region that reported
  // no provenance at all, while `upgrade` still compared it against real pins as a
  // version (ADR-032). Identity is now a content digest and is always present, so the
  // fallback is gone rather than fixed - but the asymmetry it created is worth naming.
  if (typeof sha !== 'string' || !/^[0-9a-f]{7,40}$/.test(sha)) {
    throw new Error(`compose: sha must match [0-9a-f]{7,40}, got ${JSON.stringify(sha)}`);
  }
  // Write-new, like the markers: the legacy spelling is read but never emitted, so a
  // migrated region is stable and a legacy one drifts exactly once.
  const header = headerLines(s, sha, sources);
  const trimmed = body.replace(/\n+$/, '');
  // Two lines here exist only because a real repo proved they are needed. A
  // formatter that runs on commit - several repositories have one, and three of the
  // other repos do too - rewrote the region on the very first commit: it inserted a
  // blank line after the header comment and added the trailing newline. Both edits
  // are things prettier considers correct, and either one alone makes `check`
  // permanently red on a repo whose own tooling is working correctly. A generated
  // file that a formatter rewrites is a fight the projection loses, so the
  // projection emits the formatter's shape in the first place. The blank line before
  // END is the same class: prettier treats an HTML comment after a paragraph as a
  // new block and inserts the separating blank line itself, which made
  // a `format:check` fail on a file whose generated region was correct.
  const out =
    trimmed === ''
      ? [s.begin, ...header, s.end]
      : [s.begin, ...header, '', ...trimmed.split('\n'), '', s.end];
  return `${out.join('\n')}\n`;
}

/**
 * Put the region back into the parts either side of it.
 *
 * `where` decides which side is authoritative. It is a style property rather than
 * a caller argument because the correct answer is a fact about the file's syntax,
 * and a caller who has to remember it is a caller who will get it wrong once.
 */
function splice(state, region, where) {
  if (where === 'top') {
    // Top placement is a repair, not a relocation: a region below the file's own
    // settings is moved back above them, which is the one thing the bytes either
    // side of the markers are allowed to move for. So the result here is not
    // byte-comparable with the input even when nothing has changed.
    const rest = `${state.before}${state.before === '' ? '' : '\n'}${state.after}`
      .replace(/^\n+/, '')
      .replace(/\n+$/, '');
    if (rest === '') return region;
    return `${region}\n${rest}\n`;
  }
  const before = seam(state.before);
  const after = state.after.startsWith('\n') ? state.after : state.after === '' ? '' : `\n${state.after}`;
  return `${before}${region}${after}`;
}

/**
 * Insert or replace the region in `text`, preserving everything outside it.
 *
 * `region` and `previousBody` are the state the document was in, not the action taken on
 * it. A caller asking "did this repository's *rules* change?" cannot read that off
 * `action`: a wrong seam with a correct body is `updated` (ADR-037), and so is a changed
 * body. Reporting "the rules changed" for the first is a false cause, and `upgrade` prints
 * it to whoever ran the command. Two of them also answer "has this repo ever been
 * adopted?" — `region: 'absent'` is that answer, and reading it off `previousBytes` gets a
 * repository with hand-written prose and no region wrong.
 *
 * @param {object} [opts] `style` overrides the syntax; `where` overrides placement;
 *   `compose` overrides which header the region carries (`composeShared` for the
 *   user-level file, whose remedy is not `sync`).
 * @returns {{text: string, action: 'added'|'updated'|'unchanged'|'malformed', reason?: string,
 *   region: 'absent'|'ok'|'malformed', previousBody: string}}
 */
export function inject(text, body, meta, opts = {}) {
  const s = styleOf(opts.style);
  const where = opts.where ?? s.where;
  const state = parse(text, s);
  const seen = { region: state.status, previousBody: state.body ?? '' };
  if (state.status === 'malformed') {
    return { ...seen, text, action: 'malformed', reason: state.reason, line: state.line };
  }
  const region = (opts.compose ?? compose)(body, meta, s);

  if (state.status === 'absent') {
    if (where === 'top') {
      const rest = text.replace(/^\n+/, '').replace(/\n+$/, '');
      return { ...seen, text: rest === '' ? region : `${region}\n${rest}\n`, action: 'added' };
    }
    const base = seam(text);
    // No trailing newline here, and that is load-bearing. `compose` already
    // terminates the region with one; adding a second left every adopted file
    // ending in a blank line. Nothing in this tool noticed, because `check`
    // compares region bodies and the byte after END is not part of the region —
    // but a repository's own `git diff --check` gate did, and it is a gate
    // that repo runs before every commit. The `updated` branch below has always
    // been correct for exactly this reason.
    //
    // `seam` replaced a hand-rolled equivalent here. The two agreed, which is why the
    // seam defect survived a read of this branch: it looks like the place the blank
    // line is added, and it is — for a document with no region yet. It is not where
    // the defect was, which is in `splice`.
    return {
      ...seen,
      text: `${base}${region}`,
      action: 'added',
    };
  }

  // Compare ignoring only the trailing newline the region may pick up from the
  // document; any other byte difference is real drift worth rewriting.
  const current = state.body.replace(/^\n+/, '').replace(/\n+$/, '');
  const next = region.slice(s.begin.length + 1, region.length - s.end.length - 1);
  const unchanged = current === next.replace(/^\n+/, '').replace(/\n+$/, '');
  const spliced = splice(state, region, where);

  // Comparing the region BODY is not enough to decide, because the byte between the
  // hand-written text and the region is part of the file a Markdown formatter reads
  // too. A body that matches with a seam that does not is red on `format:check`, and
  // reporting `unchanged` there means `check` finds no drift and `sync` never repairs
  // it - the repository stays red with no remedy the tool offers. Top placement is
  // excluded from the seam test because there the splice is a repair that
  // legitimately moves bytes outside the markers, so the two files differ for a
  // reason unrelated to the seam. Position is the test there instead: a region below
  // the file's own settings has been moved, and the move is what `where: 'top'`
  // exists to repair (review 0003 Q26).
  const settled = unchanged && (where === 'top' ? state.before.trim() === '' : spliced === text);
  if (settled) return { ...seen, text, action: 'unchanged' };

  return { ...seen, text: spliced, action: 'updated' };
}

/**
 * Compare a document against a desired region body without writing.
 * `meta` must be the same provenance the writer would use, so a region produced
 * by an older simt-dev SHA reads as drift rather than as unchanged.
 *
 * @returns {{action: 'added'|'updated'|'unchanged'|'malformed', reason?: string, line?: number,
 *   region: 'absent'|'ok'|'malformed', previousBody: string}}
 */
export function diff(text, body, meta, opts = {}) {
  const state = parse(text, styleOf(opts.style));
  if (state.status === 'malformed') {
    return { region: 'malformed', previousBody: '', action: 'malformed', reason: state.reason, line: state.line };
  }
  if (state.status === 'absent') {
    return { region: 'absent', previousBody: '', action: 'added' };
  }
  const probe = inject(text, body, meta, opts);
  return { region: probe.region, previousBody: probe.previousBody, action: probe.action };
}