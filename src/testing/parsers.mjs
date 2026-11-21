// Parsers for the report formats a test runner writes.
//
// A runner's verdict is read from one of five shapes: TAP, the Vitest/Jest JSON result,
// JUnit XML, `go test -json`, and libtest's text. They are parsers, not graders, so the
// gate, the index and the bench read a run the same way.
//
// The full reader returns ids and the failure text together. `compact.mjs` renders that
// structure; the wrappers below expose only ids because that is what selection and
// scoring consume.
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { CLI } from '../name.mjs';

/**
 * Sort and de-duplicate a list of ids.
 *
 * @param {string[]} items
 * @returns {string[]}
 */
export function dedupeSorted(items) {
  return [...new Set(items)].sort();
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

/**
 * Parse TAP version 13 output from `node --test --test-reporter=tap`.
 *
 * Leaf test cases carry `type: 'test'` in their YAML block; suite headers carry
 * `type: 'suite'` and are used only to build `parent > child` qualified IDs.
 *
 * @param {string} text
 * @returns {{passed: string[], failed: string[], skipped: number,
 *   failures: {id: string, detail: string, location: string}[]}|null}
 */
function parseTapReport(text) {
  const passed = [];
  const failed = [];
  const failures = [];
  let skipped = 0;
  let saw = false;
  const lines = String(text ?? '').split('\n');
  const stack = [];
  let pending = null;

  const flush = (end) => {
    if (!pending) return;
    if (pending.type !== 'suite' && !pending.hadChild) {
      if (pending.directive) {
        skipped += 1;
      } else {
        const id = [...pending.ancestors, pending.name].join(' > ');
        if (pending.ok) {
          passed.push(id);
        } else {
          failed.push(id);
          const stop = pending.yaml ? end : pending.start + 1;
          const detail = lines.slice(pending.start, stop).join('\n').trimEnd();
          failures.push({ id, detail, location: locationIn(detail) });
        }
      }
    }
    pending = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const sub = /^(\s*)# Subtest:\s+(.*)$/.exec(raw);
    if (sub) {
      flush(index);
      const indent = sub[1].length;
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
      if (stack.length > 0) stack[stack.length - 1].hadChild = true;
      stack.push({ indent, name: sub[2].trim(), hadChild: false });
      continue;
    }

    const res = /^(\s*)(not ok|ok)\s+\d+(?:\s+-\s+(.*?))?(?:\s+#\s*(SKIP|TODO)\b.*)?$/i.exec(raw);
    if (res) {
      flush(index);
      const indent = res[1].length;
      while (stack.length > 0 && stack[stack.length - 1].indent > indent) stack.pop();
      let hadChild = false;
      if (stack.length > 0 && stack[stack.length - 1].indent === indent) {
        hadChild = stack.pop().hadChild;
      }
      const ancestors = stack.map((entry) => entry.name);
      const ok = res[2].toLowerCase() === 'ok';
      const name = (res[3] ?? '').trim();
      const directive = res[4] ? res[4].toUpperCase() : null;
      if (name) {
        saw = true;
        pending = {
          start: index > 0 && /^\s*# Subtest:/.test(lines[index - 1]) ? index - 1 : index,
          yaml: index + 1 < lines.length && /^\s+---\s*$/.test(lines[index + 1]),
          ok,
          name,
          ancestors,
          hadChild,
          directive,
          type: null,
        };
      }
      continue;
    }

    if (pending) {
      const typeMatch = /^\s*type:\s*['"]?(test|suite)['"]?\s*$/.exec(raw);
      if (typeMatch) pending.type = typeMatch[1];
      else if (/^\s*\.\.\.\s*$/.test(raw)) flush(index + 1);
    }
  }
  flush(lines.length);

  if (!saw) return null;
  return { passed: dedupeSorted(passed), failed: dedupeSorted(failed), skipped, failures };
}

/**
 * Parse TAP version 13 output.
 *
 * @param {string} text
 * @returns {{passed: string[], failed: string[]}}
 */
export function parseTapOutput(text) {
  const report = parseTapReport(text) ?? { passed: [], failed: [] };
  return { passed: report.passed, failed: report.failed };
}

function parseVitestReport(text) {
  const raw = String(text ?? '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  let doc;
  try {
    doc = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(doc.testResults)) return null;

  const passed = [];
  const failed = [];
  const failures = [];
  let skipped = 0;
  let saw = false;
  for (const suite of doc.testResults) {
    const file = typeof suite?.name === 'string' ? suite.name : '';
    for (const assertion of suite?.assertionResults ?? []) {
      const id = assertionName(assertion);
      if (!id) continue;
      saw = true;
      const status = String(assertion.status ?? '');
      if (status === 'passed') {
        passed.push(id);
        continue;
      }
      if (status === 'pending' || status === 'skipped' || status === 'todo') {
        skipped += 1;
        continue;
      }
      if (status !== 'failed') continue;
      const messages = Array.isArray(assertion.failureMessages) ? assertion.failureMessages.filter(Boolean) : [];
      const location = locationIn(messages.join('\n')) || fileLocation(file, assertion.location);
      const detail = [`not ok  ${id}`, ...(location ? [`  location: ${location}`] : []), ...messages].join('\n');
      failed.push(id);
      failures.push({ id, detail, location });
    }
  }
  if (!saw) return null;
  return { passed: dedupeSorted(passed), failed: dedupeSorted(failed), skipped, failures };
}

/**
 * Parse Vitest `--reporter=json` output. Jest emits the same
 * `testResults`/`assertionResults` shape, so one parser serves both.
 *
 * @param {string} text
 * @returns {{passed: string[], failed: string[]}}
 */
export function parseVitestJson(text) {
  const report = parseVitestReport(text) ?? { passed: [], failed: [] };
  return { passed: report.passed, failed: report.failed };
}

function parseJunitReport(xml) {
  const passed = [];
  const failed = [];
  const failures = [];
  let skipped = 0;
  let saw = false;
  const source = String(xml ?? '');
  const tagRe = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;

  for (const match of source.matchAll(tagRe)) {
    const attrs = match[1] ?? '';
    const inner = match[2] ?? '';
    const name = xmlAttr(attrs, 'name');
    if (!name) continue;
    saw = true;
    const classname = xmlAttr(attrs, 'classname');
    const id = classname ? `${classname} > ${name}` : name;
    if (/<skipped\b/i.test(inner)) {
      skipped += 1;
      continue;
    }
    if (!/<(?:failure|error)\b/i.test(inner)) {
      passed.push(id);
      continue;
    }
    const file = xmlAttr(attrs, 'file');
    const line = xmlAttr(attrs, 'line');
    const fromAttrs = file ? `${file}${line ? `:${line}` : ''}` : '';
    const body = failureBody(inner);
    const location = fromAttrs || locationIn(body);
    const detail = [`not ok  ${id}`, ...(location ? [`  location: ${location}`] : []), ...(body ? [body] : [])].join('\n');
    failed.push(id);
    failures.push({ id, detail, location });
  }

  if (!saw) return null;
  return { passed: dedupeSorted(passed), failed: dedupeSorted(failed), skipped, failures };
}

/**
 * Parse JUnit XML output (pytest `--junitxml`, Gradle and Maven).
 *
 * @param {string} xml
 * @returns {{passed: string[], failed: string[]}}
 */
export function parseJunitXml(xml) {
  const report = parseJunitReport(xml) ?? { passed: [], failed: [] };
  return { passed: report.passed, failed: report.failed };
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

function parseGoReport(text) {
  const output = new Map();
  const passed = [];
  const failed = [];
  const failures = [];
  let skipped = 0;
  let saw = false;
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof event.Action !== 'string') continue;
    if (typeof event.Test !== 'string' || event.Test.length === 0) continue;
    saw = true;
    const id = event.Package ? `${event.Package} > ${event.Test}` : event.Test;
    if (event.Action === 'output' && typeof event.Output === 'string') {
      output.set(id, `${output.get(id) ?? ''}${event.Output}`);
      continue;
    }
    if (event.Action === 'pass') passed.push(id);
    else if (event.Action === 'skip') skipped += 1;
    else if (event.Action === 'fail') {
      const body = (output.get(id) ?? '').trimEnd();
      const detail = body ? `not ok  ${id}\n${body}` : `not ok  ${id}`;
      failed.push(id);
      failures.push({ id, detail, location: locationIn(body) });
    }
  }
  if (!saw) return null;
  return { passed: dedupeSorted(passed), failed: dedupeSorted(failed), skipped, failures };
}

/**
 * Parse `go test -json` JSONL event stream. Only leaf events (carrying `Test`) are
 * results; package summaries without one are ignored.
 *
 * @param {string} text
 * @returns {{passed: string[], failed: string[]}}
 */
export function parseGoTestJson(text) {
  const report = parseGoReport(text) ?? { passed: [], failed: [] };
  return { passed: report.passed, failed: report.failed };
}

function parseCargoReport(text) {
  const passed = [];
  const failed = [];
  const failures = [];
  let skipped = 0;
  let saw = false;
  for (const line of String(text ?? '').split('\n')) {
    const match = /^test\s+(.+?)\s+\.\.\.\s+(ok|FAILED|ignored)\s*$/.exec(line.trimEnd());
    if (!match) continue;
    saw = true;
    if (match[2] === 'ignored') {
      skipped += 1;
      continue;
    }
    if (match[2] === 'ok') passed.push(match[1]);
    else {
      failed.push(match[1]);
      failures.push({ id: match[1], detail: `not ok  ${match[1]}`, location: '' });
    }
  }
  if (!saw) return null;
  return { passed: dedupeSorted(passed), failed: dedupeSorted(failed), skipped, failures };
}

/**
 * Parse libtest's text output, which `cargo test` prints for every test binary.
 *
 * A line is a result only when it has the `test <name> ... <status>` shape. `ignored` is
 * neither a pass nor a failure: counting it as one would make a skipped test look like
 * evidence the change works.
 *
 * @param {string} text
 * @returns {{passed: string[], failed: string[]}}
 */
export function parseCargoTestOutput(text) {
  const report = parseCargoReport(text) ?? { passed: [], failed: [] };
  return { passed: report.passed, failed: report.failed };
}

/**
 * Read one known test report without knowing which format produced it.
 *
 * The returned structure is the single source for both the gate/bench ids and the
 * compact renderer. `null` means the text is not a known report, which callers must
 * present as an explicit unavailable status rather than an empty pass.
 *
 * @param {string} text
 * @returns {{format: string, passed: string[], failed: string[], skipped: number,
 *   failures: {id: string, detail: string, location: string}[]}|null}
 */
export function parseTestReport(text) {
  const raw = String(text ?? '');
  if (!raw.trim()) return null;

  if (/^TAP version \d+/m.test(raw) || /^(?:not )?ok \d+/m.test(raw)) {
    const tap = parseTapReport(raw);
    if (tap) return { format: 'tap', ...tap };
  }
  const vitest = parseVitestReport(raw);
  if (vitest) return { format: 'vitest', ...vitest };
  const junit = parseJunitReport(raw);
  if (junit) return { format: 'junit', ...junit };
  const go = parseGoReport(raw);
  if (go) return { format: 'go', ...go };
  const cargo = parseCargoReport(raw);
  if (cargo) return { format: 'cargo', ...cargo };
  return null;
}

/** Every `*.xml` under `dir`, sorted, for a deterministic read order. */
async function listXml(dir) {
  const out = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listXml(full)));
    else if (entry.name.endsWith('.xml')) out.push(full);
  }
  return out;
}

/**
 * Read every JUnit XML a run left behind, from report files or report *directories*
 *
 *
 * @param {string[]} paths report files and/or directories
 * @returns {Promise<string>} the concatenated XML, '' when nothing is there
 */
export async function readReports(paths) {
  const chunks = [];
  for (const path of paths ?? []) {
    let isDir = false;
    try {
      isDir = (await stat(path)).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      for (const file of await listXml(path)) {
        chunks.push(await readFile(file, 'utf8').catch(() => ''));
      }
    } else {
      chunks.push(await readFile(path, 'utf8').catch(() => ''));
    }
  }
  return chunks.join('\n');
}

/**
 * Remove the report files a runner wrote outside its workspace.
 *
 * A report inside the workspace belongs to the workspace and is removed with it. A report
 * this package directed to the temporary directory has no other owner, and leaving it
 * there is how a repository ended up with `.bench-junit.xml` beside its sources.
 *
 * Only a report this package created is removed: the name carries the prefix and the
 * process id that `junitReportPath` writes. A temp directory is shared with every other
 * program on the machine, and a path handed in by a caller is not evidence of ownership.
 *
 * @param {string[]} paths
 */
export async function cleanupReports(paths = []) {
  const temp = tmpdir();
  for (const path of paths ?? []) {
    const text = String(path);
    if (dirname(text) !== temp) continue;
    if (!basename(text).startsWith(`${CLI}-junit-${process.pid}-`)) continue;
    await rm(text, { recursive: true, force: true }).catch(() => {});
  }
}
