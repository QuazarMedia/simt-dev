// Detect hand-written rules that contradict a canonical ruling, before writing
// anything. Pure: it takes text, it never touches the filesystem.
//
// The distinction that matters here is conflict vs duplicate. A conflict is a rule
// that tells an agent to do something the canonical ruling forbids. A duplicate is
// the same rule restated in prose outside a generated region - prohibited by the
// anti-duplication doctrine, but not a contradiction.
//
// The distinction is not academic. bunnyland's AGENTS.md says "Do not use `uv run
// pytest`" - which contains the forbidden string `uv run pytest` verbatim. A naive
// substring scan reports that file as violating the very rule it is correctly
// restating. So every match is checked for prohibition context first.

/** Files whose text is a hand-written rule surface. Scanned for conflicts only;
 *  generated regions are excluded at read time by the caller.
 *
 *  `.cursor/rules/*.mdc` was NOT here for the whole life of the tool, and that is
 *  worth recording: the estate's three always-on `.mdc` families were the single
 *  worst-drifted content in it, and `simt init` reported `CONFLICTS none detected`
 *  on the repo holding them. A conflict detector that only looks at the filenames
 *  it was written for will quietly miss a whole rule surface added later. */
export const RULE_FILES = ['AGENTS.md', 'CLAUDE.md', 'CONTRIBUTING.md'];

/** Rule files discovered by glob rather than by name. */
export const RULE_GLOBS = ['.cursor/rules/*.mdc', '.github/instructions/*.md'];

/** Every hand-written rule path in a repo, named or globbed.
 *
 *  The glob is split at its LAST `*`, and the two halves are used for what they
 *  actually mean: the part before it is the directory, the part after it is either
 *  a name prefix (`dir/*name.md`) or, when it starts with `.`, a file extension
 *  (`dir/*.mdc`). Matching a name prefix where an extension was meant finds
 *  nothing and reports no conflict — a detector that silently matches zero files
 *  is indistinguishable from a repo with no rules, which is exactly the failure
 *  this function exists to end. */
export async function rulePaths(root) {
  const { readdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const out = RULE_FILES.map((f) => join(root, f));
  for (const glob of RULE_GLOBS) {
    const star = glob.lastIndexOf('*');
    const dir = join(root, glob.slice(0, star));
    const tail = glob.slice(star + 1);
    const suffix = tail.startsWith('.') ? tail : null;
    const prefix = suffix === null ? tail : '';
    let names;
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      if (suffix !== null ? name.endsWith(suffix) : name.startsWith(prefix) && name.endsWith('.md')) {
        out.push(join(dir, name));
      }
    }
  }
  return out;
}

const PROHIBITION = /\b(do not|do n't|don't|never|must not|mustn't|avoid|forbidden|prohibited|refuse)\b/i;

/** Markdown emphasis and code spans are stripped before the prohibition test, so
 *  `Do **not** use` reads as `Do not use` rather than as two unrelated words.
 *  CONTRIBUTING.md writes it the bold way, which is why this is not optional. */
function deMarkdown(text) {
  return text.replace(/[*_`~]+/g, ' ').replace(/\s+/g, ' ');
}

/**
 * Probes are ordered most-specific first. Each returns a match list; the caller
 * classifies each hit by its surrounding context.
 */
const PROBES = [
  {
    id: 'autonomous-push',
    adr: 'ADR-001',
    canonical: 'commit locally, report the SHA, push only on explicit approval',
    detail:
      'asks for a push the agent performs without approval; the remote may be a production deploy',
    // The suffix is optional on both words: garmin's DoD says "Committed and
    // pushed", a different author wrote "Always commit and pushed", and an
    // anchored pattern that only matched the first form reported a real
    // autonomous-push rule as clean. `commit` also matches "commits" and
    // "committed" because `commit?` only absorbs one `t`, not `ted`.
    re: /\bcommit(?:te[ds]?|ting)?\s+and\s+push(?:e[ds]?|ing)?\b/gi,
    // `push` with no suffix must match too: the group is optional, because an
    // earlier version made it required and therefore only ever matched "pushed",
    // reporting "commit and push without asking" as clean.
  },
  {
    id: 'file-length-hard-split',
    adr: 'ADR-005',
    canonical: '400 lines is a review trigger, 1000 is the hard ceiling',
    detail: 'restates one tier of the two-tier file-length ruling in prose',
    // Two tiers must both be recognised: "split any file once it exceeds 1000
    // lines" (the ceiling) and "keep every file under 400 lines" (the trigger).
    // A repo restating either is not contradicting ADR-005 - the ruling was
    // written so both positions survive as distinct tiers. It is a duplicate, and
    // never a conflict, so this probe can only ever downgrade, never block.
    duplicateOnly: true,
    re: /\b(?:split (?:any )?file (?:once )?(?:it )?(?:exceeds|past)|file length:|files?\s+(?:under|below|over|max(?:imum)?\s+of))\s*\**(\d{3,4})\s*lines/gi,
  },
  {
    id: 'package-runner',
    adr: 'ADR-010',
    canonical: 'invoke through the repository runner (npm run, uv run -m, ./gradlew), never a package runner',
    detail: 'invokes a binary through a package runner, which resolves outside the project environment',
    // `npx --no-install <pkg>` is exempt: it cannot fetch, so it cannot drift.
    re: /\bnpx\s+(?!--no-install)(?:-[\w-]+\s+|[^\s-][\w@/.-]*)/g,
  },
  {
    id: 'bare-console-entrypoint',
    adr: 'ADR-010',
    canonical: 'use the module form (uv run -m pytest), not the bare console entrypoint',
    detail: 'the console entrypoint can miss the import path and silently run against the wrong environment',
    re: /\buv run pytest\b(?! -m)/g,
  },
  {
    id: 'lint-manually',
    adr: 'ADR-004',
    canonical: 'the hook owns format and lint for staged files',
    detail: 'instructs a manual lint run that duplicates the hook',
    re: /\brun\s+(?:ruff|eslint|lint|prettier|format)\b[^\n]{0,40}\b(?:by hand|manually)\b/gi,
  },
  {
    id: 'full-suite-mandatory',
    adr: 'ADR-003',
    canonical: 'focused tests are the default; a full suite needs a named trigger',
    detail: 'makes an unconditional full-suite run the gate, which ADR-003 reconciles into named triggers',
    re: /\b(?:always run|must run|required to run) (?:the )?full (?:suite|gate|test)/gi,
  },
];

/**
 * Scan one document's text.
 * @param {string} text
 * @param {string} file display path, used only in findings
 * @returns {Array<{severity:'conflict'|'duplicate', id, adr, file, line, quote, detail, canonical}>}
 */
export function scanDocument(text, file) {
  const findings = [];
  if (!text) return findings;

  for (const probe of PROBES) {
    probe.re.lastIndex = 0;
    let match;
    while ((match = probe.re.exec(text)) !== null) {
      const quote = excerpt(text, match.index, match[0].length);
      const context = contextBefore(text, match.index);
      const negative = PROHIBITION.test(deMarkdown(context));

      // No numeric guard: ADR-005 is two-tier and `duplicateOnly` already makes
      // this probe incapable of producing a conflict. An earlier `n < 1000`
      // guard looked harmless but silently dropped the entire 400-line tier.

      findings.push({
        severity: negative || probe.duplicateOnly === true ? 'duplicate' : 'conflict',
        id: probe.id,
        adr: probe.adr,
        file,
        line: lineOf(text, match.index),
        quote,
        detail: probe.detail,
        canonical: probe.canonical,
      });
    }
  }
  return findings.sort((a, b) => a.line - b.line || a.id.localeCompare(b.id));
}

/** Summarise findings into the counts `init` needs to decide whether to proceed. */
export function summarise(findings) {
  return {
    total: findings.length,
    conflicts: findings.filter((f) => f.severity === 'conflict').length,
    duplicates: findings.filter((f) => f.severity === 'duplicate').length,
    byAdr: [...new Set(findings.map((f) => f.adr))].sort(),
  };
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text[i] === '\n') line += 1;
  }
  return line;
}

/** The text immediately before a match, used to detect prohibition context.
 *  160 chars is wide enough to carry "Do not use ..." or "never invoke ...", and
 *  narrow enough that an unrelated prohibition nearby cannot excuse the match. */
function contextBefore(text, index) {
  return text.slice(Math.max(0, index - 160), index);
}

/** A single-line quote, so a finding can be pasted into a review comment. */
function excerpt(text, index, length, radius = 48) {
  const from = Math.max(0, index - radius);
  const to = Math.min(text.length, index + length + radius);
  const slice = text.slice(from, to).replace(/\s+/g, ' ').trim();
  return `${from > 0 ? '...' : ''}${slice}${to < text.length ? '...' : ''}`;
}

export const __internals = { PROBES, PROHIBITION };