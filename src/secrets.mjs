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
 * A value is a placeholder when the WHOLE value is placeholder-shaped, not when
 * it contains a placeholder word: a real secret may contain "example" and still
 * be a secret, and the substring test blocked exactly that commit (review 0003 Q24).
 */
const PLACEHOLDER_WORD = /^(?:example|sample|placeholder|changeme|change[-_]?me|dummy|fake|redacted|notasecret|undefined|null|none|true|false|x+)$/i;
const PLACEHOLDER_SLOT = /^(?:<[^<>]*>|\{\{?[a-z0-9_.-]+\}\}?|your[-_][a-z0-9_-]*|my[-_][a-z0-9_-]*)$/i;

/**
 * @param {string} value the candidate secret
 * @returns {boolean} true when the whole value is documentation, not a leak
 */
function isPlaceholder(value) {
  const v = String(value).trim();
  if (v === '') return true;
  if (PLACEHOLDER_SLOT.test(v)) return true;
  const words = v.split(/[^a-zA-Z]+/).filter(Boolean);
  if (words.length === 0) return true; // punctuation only: `…`, `-`
  return words.every((w) => PLACEHOLDER_WORD.test(w));
}

/**
 * The pattern library. Each row names itself so the finding tells the reader
 * WHICH shape matched — "a secret was found" sends them hunting for it;
 * "aws-access-key-id on line 12" says what to revoke.
 *
 * `groups`, when set, lists the captures that may hold the VALUE — what the
 * placeholder check and the redaction run on; the first defined capture wins.
 * Without it the whole match is the value.
 */
const PATTERNS = [
  { id: 'aws-access-key-id', re: /\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g },
  // The type word is not the discriminator, "PRIVATE KEY" is: RSA, EC, DSA,
  // OPENSSH, PGP and ENCRYPTED all carry the same header shape (review 0003 Q24).
  { id: 'private-key-block', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g },
  { id: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  { id: 'gitlab-token', re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { id: 'npm-token', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { id: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { id: 'stripe-live-key', re: /\b(?:sk|rk)_live_[0-9a-zA-Z]{24,}\b/g },
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'openai-style-key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  // The key name is prefix-aware — DB_PASSWORD, aws_secret_access_key — and the
  // value may be quoted or bare, because .env and YAML do not quote (review 0003 Q24).
  {
    id: 'assigned-secret',
    re: /\b[A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)\b\s*[:=]\s*(?:"([^"]{8,})"|'([^']{8,})'|([A-Za-z0-9+/=_-]{8,}))/gi,
    groups: [1, 2, 3],
  },
  // The password half of https://user:pw@host: the only place a URL carries one.
  {
    id: 'url-userinfo',
    re: /\b[a-z][a-z0-9+.-]*:\/\/[^:/\s@]+:([A-Za-z0-9._~+-]{8,})@/g,
    groups: [1],
  },
];

/** Longest base64ish run worth measuring for entropy. */
const ENTROPY_CANDIDATE = /[A-Za-z0-9+/=_-]{32,}/g;

/**
 * Subresource-integrity hashes: `sha256-<base64>` and kin. A deterministic
 * digest of file content, present in every lockfile and build manifest —
 * high-entropy bytes that are never a secret (review 0003 Q24).
 */
const SRI_HASH = /^sha(1|256|384|512)-[A-Za-z0-9+/]+={0,2}$/;

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
      const groups = pattern.groups ?? [0];
      let value = null;
      for (const g of groups) {
        if (match[g] !== undefined) {
          value = match[g];
          break;
        }
      }
      if (value === null) continue;
      if (isPlaceholder(value)) continue;
      const at = match.index + match[0].indexOf(value);
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
    if (SRI_HASH.test(value)) continue;
    if (isPlaceholder(value)) continue;
    if (claimed.some(([a, b]) => match.index < b && a < match.index + value.length)) continue;
    const bits = entropy(value);
    if (bits < ENTROPY_MIN_BITS) continue;
    found.push({ kind: 'high-entropy', preview: redact(value), entropy: Number(bits.toFixed(1)) });
  }

  return found;
}

/**
 * Lockfiles are skipped by default (review 0003 Q24): their high-entropy bytes
 * are integrity hashes and version pins, and a dependency bump is a commit the
 * gate must not block. The SRI allow-list above covers the same shapes wherever
 * they appear outside a lockfile.
 */
const LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lockb',
  'pnpm-lock.yaml',
  'Cargo.lock',
  'go.sum',
  'composer.lock',
  'Gemfile.lock',
  'Pipfile.lock',
  'poetry.lock',
  'uv.lock',
  'pubspec.lock',
  'mix.lock',
]);

/** A line carrying this marker is the author's explicit exemption for that line. */
const PRAGMA = 'simt:allow-secret';

/**
 * One glob to one anchored regex: `**` crosses separators, `*` and `?` do not.
 * The same small matcher the ignore lists render with, because a repository
 * that writes `vendor/**` in `.simtignore` expects the same reading here.
 */
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i += 1;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
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
 * @param {{ignore?: string[]}} [options] `ignore` is the manifest's
 *   `gates.secretScan.ignore`: globs of repository paths to skip (review 0003 Q24)
 * @returns {Promise<{findings: {file: string, line: number, kind: string,
 *   preview: string, entropy?: number}[], lines: number, error: string|null}>}
 *   `error` is set only when git itself could not answer; callers fail closed on
 *   it rather than reading silence as a clean diff.
 */
export async function scanStaged(root, options = {}) {
  const ignore = (Array.isArray(options.ignore) ? options.ignore : [])
    .filter((g) => typeof g === 'string' && g !== '')
    .map(globToRegExp);

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
  let fileSkipped = false;

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
        const name = file === null ? '' : file.slice(file.lastIndexOf('/') + 1);
        fileSkipped = file !== null && (LOCKFILES.has(name) || ignore.some((re) => re.test(file)));
      }
      continue;
    }
    if (!raw.startsWith('+')) continue; // -U0 has no context; this is `\ No newline…`
    lines += 1;
    if (file !== null && !fileSkipped && !raw.includes(PRAGMA)) {
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