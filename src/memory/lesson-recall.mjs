// Failure signatures and lesson matching: the pure half of recall, extracted from the
// file store so a matcher can be tested without writing a lesson or running a hook.

import { createHash } from 'node:crypto';

export function normaliseErrorLine(line) {
  return String(line ?? '')
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Extract the first error-bearing line from command output.
 *
 * Skips TAP preamble and passing (`ok N`) lines so TAP streams resolve to the first
 * failing (`not ok`) or error line rather than the header.
 *
 * @param {string} output
 * @returns {string}
 */
export function firstErrorLine(output) {
  const clean = String(output ?? '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  const rawLines = clean
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (rawLines.length === 0) return '';

  const filtered = rawLines.filter(
    (line) =>
      !/^TAP version \d+$/i.test(line) &&
      !/^1\.\.\d+$/.test(line) &&
      !/^# Subtest:/i.test(line) &&
      !/^---\s*$/.test(line) &&
      !/^\.\.\.\s*$/.test(line) &&
      !/^ok\b/i.test(line),
  );
  const pool = filtered.length > 0 ? filtered : rawLines;

  const explicit = pool.find((line) =>
    /^(?:not ok\b|FAIL\b|ERROR\b|Error:|AssertionError\b|TypeError\b|SyntaxError\b|ReferenceError\b|RangeError\b|✗|×|✖|❌)|\b(?:AssertionError|TypeError|SyntaxError|ReferenceError|RangeError|Error):/i.test(
      line,
    ),
  );
  if (explicit) return normaliseErrorLine(explicit);

  const secondary = pool.find(
    (line) => /\b(?:failed|failure|error|blocked|denied)\b/i.test(line) && !/^\d+\s+pass\b/i.test(line),
  );
  if (secondary) return normaliseErrorLine(secondary);

  return normaliseErrorLine(pool[0]);
}

/**
 * Deterministic `sha256-<hex>` signature of the normalised first error line.
 *
 * @param {string} outputOrLine
 * @returns {string}
 */
export function errorSignature(outputOrLine) {
  const line = normaliseErrorLine(firstErrorLine(outputOrLine));
  return `sha256-${createHash('sha256').update(line, 'utf8').digest('hex')}`;
}


export function formatLessonParagraph(lesson) {
  const id = String(lesson?.id ?? 'lesson').trim();
  const title = String(lesson?.title ?? id).replace(/\s+/g, ' ').trim();
  const body = String(lesson?.paragraph ?? '').replace(/\s+/g, ' ').trim();
  if (!body || body === title) {
    return `Lesson ${id}: ${title}`;
  }
  return `Lesson ${id} (${title}): ${body}`;
}

function hashLine(line) {
  const norm = normaliseErrorLine(line);
  return `sha256-${createHash('sha256').update(norm, 'utf8').digest('hex')}`;
}

function firstDefinedNumber(values) {
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
}

export function extractFailureSignals(payloadOrOutput) {
  if (typeof payloadOrOutput === 'string') {
    const trimmed = payloadOrOutput.trim();
    if (!trimmed) return { failed: false, reason: 'empty tool output', signatures: [] };
    const sigs = new Set([errorSignature(trimmed)]);
    for (const line of trimmed.split(/\r?\n/)) {
      const norm = normaliseErrorLine(line);
      if (norm) sigs.add(hashLine(norm));
    }
    return { failed: true, signatures: [...sigs] };
  }

  if (!payloadOrOutput || typeof payloadOrOutput !== 'object') {
    return { failed: false, reason: 'empty tool output', signatures: [] };
  }

  const p = payloadOrOutput;
  const resp =
    p.tool_response ?? p.tool_output ?? p.tool_result ?? p.toolResponse ?? null;
  const respObj = resp && typeof resp === 'object' && !Array.isArray(resp) ? resp : {};

  const exitCode = firstDefinedNumber([
    p.exit_code,
    p.exitCode,
    p.exit,
    p.status,
    respObj.exit_code,
    respObj.exitCode,
    respObj.exit,
    respObj.status,
    respObj.code,
  ]);
  const isError =
    p.is_error ?? p.isError ?? respObj.is_error ?? respObj.isError ?? undefined;

  if (exitCode === 0 && isError !== true) {
    return { failed: false, reason: 'the tool call exited 0', signatures: [] };
  }
  if (isError === false && exitCode === undefined) {
    return { failed: false, reason: 'the tool call reported no error', signatures: [] };
  }

  const sigs = new Set();
  for (const rawSig of [p.signature, respObj.signature]) {
    if (typeof rawSig === 'string' && rawSig.startsWith('sha256-')) {
      sigs.add(rawSig.trim());
    }
  }

  for (const errLine of [p.errorLine, respObj.errorLine]) {
    if (typeof errLine === 'string' && errLine.trim()) {
      sigs.add(hashLine(errLine));
      sigs.add(errorSignature(errLine));
    }
  }

  const textParts = [];
  if (typeof resp === 'string') textParts.push(resp);
  for (const field of [
    respObj.stderr,
    respObj.stdout,
    respObj.output,
    respObj.error,
    respObj.text,
    typeof respObj.content === 'string'
      ? respObj.content
      : Array.isArray(respObj.content)
        ? respObj.content.map((c) => (typeof c === 'string' ? c : (c?.text ?? ''))).join('\n')
        : '',
    p.stderr,
    p.stdout,
    p.output,
    p.error,
    p.summary,
  ]) {
    if (typeof field === 'string' && field.trim()) textParts.push(field);
  }

  if (typeof p.summary === 'string') {
    const inner =
      /^\d+\s+fail\s+\((.+)\)$/.exec(p.summary.trim())?.[1] ??
      /^exit\s+-?\d+\s+\((.+)\)$/.exec(p.summary.trim())?.[1];
    if (inner) {
      sigs.add(hashLine(inner));
      sigs.add(errorSignature(inner));
    }
  }

  const combined = textParts.join('\n').trim();
  if (combined) {
    sigs.add(errorSignature(combined));
    for (const line of combined.split(/\r?\n/)) {
      const norm = normaliseErrorLine(line);
      if (norm) sigs.add(hashLine(norm));
    }
  }

  if (sigs.size === 0) {
    return { failed: false, reason: 'the payload carries no failing tool output', signatures: [] };
  }

  return { failed: true, signatures: [...sigs] };
}

/**
 * Match a failing tool output or replayed failure payload against promoted lessons by error signature.
 *
 * @param {Array<object>} lessons
 * @param {string|object} payloadOrOutput
 * @returns {{lesson: object, paragraph: string, signature: string}|null}
 */
export function matchLessonByOutput(lessons, payloadOrOutput) {
  if (!Array.isArray(lessons) || lessons.length === 0) return null;
  const signals = extractFailureSignals(payloadOrOutput);
  if (!signals.failed || signals.signatures.length === 0) return null;

  const sigSet = new Set(signals.signatures);
  for (const lesson of lessons) {
    if (lesson?.signature && sigSet.has(lesson.signature)) {
      return {
        lesson,
        paragraph: formatLessonParagraph(lesson),
        signature: lesson.signature,
      };
    }
  }
  return null;
}
