// Compaction for output this tool itself produced (R18, ADR-095).
//
// Failures stay whole: the name, the assertion and the location are in the
// block that is printed. Passing tests become a count. A stream that is not
// one of the known formats is left alone, because a summary of an unknown
// log is how a failure disappears.

/**
 * Compact a known test report. Returns null when the text is not one.
 *
 * @param {string} text
 * @returns {string|null}
 */
export function compactOutput(text) {
  const report = parseReport(text);
  if (!report) return null;
  const lines = [`failed  ${report.failures.length}`];
  for (const failure of report.failures) lines.push(failure);
  lines.push(`passed  ${report.passed}`);
  if (report.skipped > 0) lines.push(`skipped  ${report.skipped}`);
  return lines.join('\n');
}

function parseReport(text) {
  const raw = String(text ?? '');
  if (!raw.trim()) return null;
  if (/^TAP version \d+/m.test(raw) || /^(?:not )?ok \d+/m.test(raw)) {
    const tap = parseTap(raw);
    if (tap) return tap;
  }
  const vitest = parseVitest(raw);
  if (vitest) return vitest;
  const go = parseGo(raw);
  if (go) return go;
  if (/<testcase\b/.test(raw)) return parseJunit(raw);
  return null;
}

function parseTap(text) {
  const lines = text.split('\n');
  const failures = [];
  let passed = 0;
  let skipped = 0;
  let saw = false;
  for (let i = 0; i < lines.length; i++) {
    const res = /^(\s*)(not ok|ok)\s+\d+(?:\s+-\s+(.*?))?(?:\s+#\s*(SKIP|TODO)\b.*)?\s*$/i.exec(lines[i]);
    if (!res) continue;
    saw = true;
    const start = i > 0 && /^\s*# Subtest:/.test(lines[i - 1]) ? i - 1 : i;
    let end = i;
    if (i + 1 < lines.length && /^\s+---\s*$/.test(lines[i + 1])) {
      end = i + 1;
      while (end + 1 < lines.length && !/^\s+\.\.\.\s*$/.test(lines[end + 1])) end++;
      if (end + 1 < lines.length) end++;
      i = end;
    }
    const block = lines.slice(start, end + 1).join('\n');
    if (/^\s*type:\s*['"]?suite['"]?\s*$/m.test(block)) continue;
    if (res[4]) {
      skipped++;
      continue;
    }
    if (res[2].toLowerCase() === 'not ok') failures.push(block);
    else passed++;
  }
  if (!saw) return null;
  return { failures, passed, skipped };
}

function parseVitest(text) {
  const raw = String(text).trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let doc;
  try {
    doc = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(doc.testResults)) return null;
  const failures = [];
  let passed = 0;
  let skipped = 0;
  let saw = false;
  for (const suite of doc.testResults) {
    const file = typeof suite?.name === 'string' ? suite.name : '';
    for (const assertion of suite?.assertionResults ?? []) {
      const name = assertionName(assertion);
      if (!name) continue;
      saw = true;
      const status = String(assertion.status ?? '');
      if (status === 'passed') {
        passed++;
        continue;
      }
      if (status === 'pending' || status === 'skipped' || status === 'todo') {
        skipped++;
        continue;
      }
      if (status !== 'failed') continue;
      const messages = Array.isArray(assertion.failureMessages) ? assertion.failureMessages.filter(Boolean) : [];
      const location = locationIn(messages.join('\n')) || fileLocation(file, assertion.location);
      const lines = [`not ok  ${name}`];
      if (location) lines.push(`  location: ${location}`);
      if (messages.length > 0) lines.push(messages.join('\n'));
      failures.push(lines.join('\n'));
    }
  }
  if (!saw) return null;
  return { failures, passed, skipped };
}

function assertionName(assertion) {
  const parts = [...(assertion.ancestorTitles ?? []), assertion.title].filter(Boolean);
  if (parts.length > 0) return parts.join(' > ');
  return String(assertion.fullName ?? '').trim();
}

function fileLocation(file, location) {
  if (!file) return '';
  const line = location && Number.isFinite(location.line) ? `:${location.line}` : '';
  const column = location && Number.isFinite(location.column) ? `:${location.column}` : '';
  return `${file}${line}${column}`;
}

function parseGo(text) {
  const output = new Map();
  const failures = [];
  let passed = 0;
  let skipped = 0;
  let saw = false;
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let ev;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof ev.Action !== 'string') continue;
    if (typeof ev.Test !== 'string' || ev.Test.length === 0) continue;
    saw = true;
    const id = ev.Package ? `${ev.Package} > ${ev.Test}` : ev.Test;
    if (ev.Action === 'output' && typeof ev.Output === 'string') {
      output.set(id, `${output.get(id) ?? ''}${ev.Output}`);
      continue;
    }
    if (ev.Action === 'pass') passed++;
    else if (ev.Action === 'skip') skipped++;
    else if (ev.Action === 'fail') {
      const body = (output.get(id) ?? '').trimEnd();
      failures.push(body ? `not ok  ${id}\n${body}` : `not ok  ${id}`);
    }
  }
  if (!saw) return null;
  return { failures, passed, skipped };
}

function parseJunit(text) {
  const failures = [];
  let passed = 0;
  let skipped = 0;
  let saw = false;
  const tagRe = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const match of String(text).matchAll(tagRe)) {
    const attrs = match[1] ?? '';
    const inner = match[2] ?? '';
    const name = xmlAttr(attrs, 'name');
    if (!name) continue;
    saw = true;
    const classname = xmlAttr(attrs, 'classname');
    const id = classname ? `${classname} > ${name}` : name;
    if (/<skipped\b/i.test(inner)) {
      skipped++;
      continue;
    }
    if (!/<(?:failure|error)\b/i.test(inner)) {
      passed++;
      continue;
    }
    const file = xmlAttr(attrs, 'file');
    const line = xmlAttr(attrs, 'line');
    const fromAttrs = file ? `${file}${line ? `:${line}` : ''}` : '';
    const body = failureBody(inner);
    const location = fromAttrs || locationIn(body);
    const lines = [`not ok  ${id}`];
    if (location) lines.push(`  location: ${location}`);
    if (body) lines.push(body);
    failures.push(lines.join('\n'));
  }
  if (!saw) return null;
  return { failures, passed, skipped };
}

function failureBody(inner) {
  const chunks = [];
  const re = /<(?:failure|error)\b([^>]*)(?:\/>|>([\s\S]*?)<\/(?:failure|error)>)/gi;
  for (const match of String(inner).matchAll(re)) {
    const message = xmlAttr(match[1] ?? '', 'message');
    const body = decode(match[2] ?? '').trim();
    if (message) chunks.push(message);
    if (body && body !== message) chunks.push(body);
  }
  if (chunks.length > 0) return chunks.join('\n');
  return decode(inner).trim();
}

function locationIn(text) {
  const match = /[\w./-]+\.(?:java|kt|py|go|mjs|js|ts|tsx):\d+(?::\d+)?/.exec(text);
  return match ? match[0] : '';
}

function xmlAttr(attrs, key) {
  const match = new RegExp(`\\b${key}=["']([^"']*)["']`).exec(attrs);
  if (!match) return '';
  return decode(match[1]).trim();
}

function decode(text) {
  return String(text)
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}
