// simt explain <CODE> [--json]
//
// The last mile of the contract work is a reader: every status `simt check`
// can emit gets a plain-language entry — what it means, why the gate reports
// it, how to fix it, and a concrete trigger — either as text or as the same
// JSON envelope every command answers in. The lookup is case-insensitive and
// folds the `-`/`_` split, so DRIFT, Drift and drift are one question; an
// unknown code is a usage error that lists the known codes rather than a guess.

import { EXIT, emit, emitJson, fail, isJson } from '../output/index.mjs';
import { EXPLAIN_CODES } from '../explain.mjs';

export const EXPLAIN_ALIASES = { drifted: 'drift' };

function fold(raw) {
  const folded = String(raw ?? '').toLowerCase().replace(/_/g, '-');
  return EXPLAIN_ALIASES[folded] ?? folded;
}

export function listExplainCodes() {
  return Object.keys(EXPLAIN_CODES).sort();
}

export async function explainCommand(positional, flags) {
  const raw = positional[0];
  if (!raw) {
    return fail(
      'explain needs a code',
      EXIT.USAGE,
      `one of: ${listExplainCodes().join(', ')}`,
    );
  }
  const code = fold(raw);
  const row = EXPLAIN_CODES[code];
  if (!row) {
    return fail(
      `unknown finding code \`${raw}\``,
      EXIT.USAGE,
      `one of: ${listExplainCodes().join(', ')}`,
    );
  }

  if (isJson(flags)) {
    emitJson({ ok: true, command: 'explain', code, ...row });
    return EXIT.OK;
  }
  emit(
    [`code     ${code}`, '', row.what, '', `Why: ${row.why}`, '', `Fix: ${row.fix}`, '', `Example: ${row.example}`].join('\n'),
    { maxBytes: flags.maxBytes ?? 0 },
  );
  return EXIT.OK;
}
