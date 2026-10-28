// A zero-dependency scan of the staged diff for secrets (plan 0003 R52).
//
// Two finding sources, deliberately both. A pattern library catches the shapes
// vendors publish — an AWS key id, a private key header, a token prefix — and
// Shannon entropy catches the high-entropy blobs that carry no prefix at all:
// a 32-character random base64 string is a secret whether or not a vendor named
// it. Neither needs a network call or an install step, which is the point. A
// gate that needs an install step is a gate a fresh clone does not have
// (ADR-012, zero runtime dependencies).
//
// Three boundaries, each load-bearing:
//
//   - Added lines only. The scan reads `git diff --cached`, so a secret already
//     sitting in history is not this gate's finding: the commit about to be made
//     is. Flagging context lines would block commits for work the author did not
//     stage, which is the failure `format`'s staged-only rule exists to prevent.
//   - Findings never print the matched bytes. The hook output lands in a
//     terminal, a CI log and often a transcript an agent reads back: echoing the
//     secret into a report about the secret is the leak with extra steps. A
//     finding carries a four-character prefix (the part a vendor publishes as a
//     type — `AKIA`, `sk-`, `ghp_`) and nothing else.
//   - Placeholders are not secrets. `password = "changeme-example"` in a README
//     is documentation, and a gate that blocks it teaches the exact `--no-verify`
//     habit the dispatcher's fail-closed rule exists to prevent.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** The length at which a token is worth measuring, and the entropy it must reach. */
const ENTROPY_MIN_LENGTH = 32;
export const ENTROPY_MIN_BITS = 4.5;

/**
 * Value markers that mean "this string is here to be replaced". A pattern match
 * or entropy hit whose value carries one of these is documentation, not a leak.
 */
const PLACEHOLDER =
  /(example|placeholder|changeme|dummy|redacted|notasecret|your[_-]|xxxx+|<[a-z-]*>|\{\{?[a-z_.-]+\}\}?)/i;

/**
 * The pattern library. Each row names itself so the finding tells the reader
 * WHICH shape matched — "a secret was found" sends them hunting for it;
 * "aws-access-key-id on line 12" says what to revoke.
 *
 * `group`, when set, is the capture holding the VALUE — what the placeholder
 * check and the redaction run on. Without it the whole match is the value.
 */
const PATTERNS = [
  { id: 'aws-access-key-id', re: /\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g },
  { id: 'private-key-block', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/g },
  { id: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  { id: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { id: 'stripe-live-key', re: /\b(?:sk|rk)_live_[0-9a-zA-Z]{24,}\b/g },
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'openai-style-key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  {
    id: 'assigned-secret',
    re: /\b(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)\b\s*[:=]\s*["']([^"']{8,})["']/gi,
    group: 1,
  },
];

/** Longest base64ish run worth measuring for entropy. */
const ENTROPY_CANDIDATE = /[A-Za-z0-9+/=_-]{32,}/g;

/**
 * Shannon entropy of a string, in bits per character.
 *
 * The detector's whole discriminator in one function: a uniformly random token
 * approaches log2(alphabet size) — near 6 bits for base64 — while English,
 * hex digests and repeated identifiers fall below 4.5. A sha256 hex digest tops
 * out at 4.0 over sixteen symbols, which is exactly why the threshold sits above
 * it: a commit hash is not a secret, and a gate that calls it one gets disabled.
 */
export function entropy(text) {
  const freq = new Map();
  for (const ch of text) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of freq.values()) {
    const p = n / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** The four characters a finding may show: the prefix a vendor publishes as a type. */
function redact(value) {
  return `${value.slice(0, 4)}…`;
}

/**
 * Scan one line's worth of added text.
 *
 * @param {string} text the added line, without the leading `+`
 * @returns {{kind: string, preview: string, entropy?: number}[]} findings in
 *   pattern order, then entropy over whatever no pattern claimed
 */
export function scanText(text) {
  const found = [];
  const claimed = [];

  for (const pattern of PATTERNS) {
    pattern.re.lastIndex = 0;
    for (const match of text.matchAll(pattern.re)) {
      const value = pattern.group !== undefined ? match[pattern.group] : match[0];
      if (PLACEHOLDER.test(value)) continue;
      const at = match.index + (pattern.group !== undefined ? match[0].indexOf(value) : 0);
      // Overlap, not equality: a token a pattern named is one finding, and the
      // entropy reading of the same bytes would double the count a gate reports.
      if (claimed.some(([a, b]) => at < b && a < at + value.length)) continue;
      claimed.push([at, at + value.length]);
      found.push({ kind: pattern.id, preview: redact(value) });
    }
  }

  ENTROPY_CANDIDATE.lastIndex = 0;
  for (const match of text.matchAll(ENTROPY_CANDIDATE)) {
    const value = match[0];
    if (value.length < ENTROPY_MIN_LENGTH) continue;
    if (PLACEHOLDER.test(value)) continue;
    if (claimed.some(([a, b]) => match.index < b && a < match.index + value.length)) continue;
    const bits = entropy(value);
    if (bits < ENTROPY_MIN_BITS) continue;
    found.push({ kind: 'high-entropy', preview: redact(value), entropy: Number(bits.toFixed(1)) });
  }

  return found;
}

/**
 * Scan the staged diff: the added lines of what the next commit would record.
 *
 * File attribution is a hunk state machine rather than a prefix test, because
 * the two are indistinguishable by prefix alone: an added line whose content
 * starts with `++ ` renders as `+++ something`, which looks exactly like a
 * `+++ b/…` file header. Headers appear only outside hunks and content only
 * inside them, so the `diff --git` boundary and the `@@` header decide which
 * one a line is.
 *
 * @param {string} root repository root
 * @returns {Promise<{findings: {file: string, line: number, kind: string,
 *   preview: string, entropy?: number}[], lines: number, error: string|null}>}
 *   `error` is set only when git itself could not answer; callers fail closed on
 *   it rather than reading silence as a clean diff.
 */
export async function scanStaged(root) {
  let stdout;
  try {
    // Every flag here defeats a way a repository can keep the scan from seeing its
    // own staged bytes (review 0003 Q02): `diff.external` routes the diff to a
    // program that prints nothing, `-diff` in `.gitattributes` and genuinely binary
    // files make git print no text at all, a textconv rewrites the bytes on the way
    // out, `diff.mnemonicPrefix` renames the header prefixes the attribution below
    // reads, and C-quoting mangles a non-ASCII name. The scan asks git for the staged
    // bytes with its own flags and ignores what the repository asked for.
    ({ stdout } = await exec(
      'git',
      [
        '-c', 'core.quotePath=false',
        'diff',
        '--cached',
        '--no-ext-diff',
        '--no-textconv',
        '--text',
        '--unified=0',
        '--no-color',
        '--src-prefix=a/',
        '--dst-prefix=b/',
      ],
      { cwd: root, maxBuffer: 32 * 1024 * 1024 },
    ));
  } catch (error) {
    const stderr = String(error.stderr ?? '').trim();
    const reason = (stderr || String(error.message ?? error)).split('\n')[0];
    return { findings: [], lines: 0, error: reason };
  }

  const findings = [];
  let lines = 0;
  let file = null;
  let lineNo = 0;
  let inHunk = false;

  for (const raw of stdout.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      inHunk = false;
      continue;
    }
    if (raw.startsWith('@@ ')) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (hunk) {
        lineNo = Number(hunk[1]);
        inHunk = true;
      }
      continue;
    }
    if (!inHunk) {
      // Outside a hunk: headers only. `+++ /dev/null` is the removal side of a
      // deletion; nothing is added under it.
      if (raw.startsWith('+++ ')) {
        const path = raw.slice(4).trim();
        file = path === '/dev/null' ? null : path.replace(/^b\//, '');
      }
      continue;
    }
    if (!raw.startsWith('+')) continue; // -U0 has no context; this is `\ No newline…`
    lines += 1;
    if (file !== null) {
      for (const hit of scanText(raw.slice(1))) {
        findings.push({ file, line: lineNo, ...hit });
      }
    }
    lineNo += 1;
  }

  return { findings, lines, error: null };
}

/** The report a failing gate prints: one finding per line, redacted. */
export function renderFindings(findings) {
  return findings
    .map(
      (f) =>
        `  ${f.file}:${f.line}  ${f.kind}  ${f.preview}` +
        (f.entropy !== undefined ? `  (entropy ${f.entropy} bits)` : ''),
    )
    .join('\n');
}