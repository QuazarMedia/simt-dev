// Parsers for the report formats a test runner writes.
//
// A runner's verdict is read from one of four shapes: TAP, the Vitest/Jest JSON result,
// JUnit XML, `go test -json`, and libtest's text. They are parsers, not graders, so the
// gate, the index and the bench read a run the same way.
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Sort and de-duplicate a list of ids.
 *
 * @param {string[]} items
 * @returns {string[]}
 */
export function dedupeSorted(items) {
  return [...new Set(items)].sort();
}

/**
 * Parse TAP version 13 output from `node --test --test-reporter=tap`.
 *
 * Leaf test cases carry `type: 'test'` in their YAML block; suite headers carry
 * `type: 'suite'` and are used only to build `parent > child` qualified IDs.
 *
 * @param {string} text
 * @returns {{passed: string[], failed: string[]}}
 */
export function parseTapOutput(text) {
  const passed = [];
  const failed = [];
  const lines = String(text ?? '').split('\n');
  const stack = [];
  let pending = null;

  const flush = () => {
    if (!pending) return;
    if (pending.type !== 'suite' && !pending.hadChild && !pending.directive) {
      const id = [...pending.ancestors, pending.name].join(' > ');
      if (pending.ok) passed.push(id);
      else failed.push(id);
    }
    pending = null;
  };

  for (const raw of lines) {
    const sub = /^(\s*)# Subtest:\s+(.*)$/.exec(raw);
    if (sub) {
      flush();
      const indent = sub[1].length;
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
      if (stack.length > 0) stack[stack.length - 1].hadChild = true;
      stack.push({ indent, name: sub[2].trim(), hadChild: false });
      continue;
    }

    const res = /^(\s*)(not ok|ok)\s+\d+(?:\s+-\s+(.*?))?(?:\s+#\s*(SKIP|TODO)\b.*)?$/i.exec(raw);
    if (res) {
      flush();
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
      if (name) pending = { indent, ok, name, ancestors, hadChild, directive, type: null };
      continue;
    }

    if (pending) {
      const typeMatch = /^\s*type:\s*['"]?(test|suite)['"]?\s*$/.exec(raw);
      if (typeMatch) pending.type = typeMatch[1];
      else if (/^\s*\.\.\.\s*$/.test(raw)) flush();
    }
  }
  flush();

  return { passed: dedupeSorted(passed), failed: dedupeSorted(failed) };
}

/**
 * Parse Vitest `--reporter=json` output. Jest emits the same
 * `testResults`/`assertionResults` shape, so one parser serves both.
 *
 * @param {string} text
 * @returns {{passed: string[], failed: string[]}}
 */
export function parseVitestJson(text) {
  const passed = [];
  const failed = [];
  const raw = String(text ?? '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return { passed, failed };

  let doc;
  try {
    doc = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return { passed, failed };
  }

  for (const suite of doc.testResults ?? []) {
    for (const assertion of suite.assertionResults ?? []) {
      const parts = [...(assertion.ancestorTitles ?? []), assertion.title].filter(Boolean);
      const id = parts.length > 0 ? parts.join(' > ') : (assertion.fullName ?? '').trim();
      if (!id) continue;
      if (assertion.status === 'passed') passed.push(id);
      else if (assertion.status === 'failed') failed.push(id);
    }
  }

  return { passed: dedupeSorted(passed), failed: dedupeSorted(failed) };
}

function xmlAttr(attrs, key) {
  const match = new RegExp(`\\b${key}=["']([^"']*)["']`).exec(attrs);
  if (!match) return '';
  return match[1]
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
    .trim();
}

/**
 * Parse JUnit XML output (pytest `--junitxml`, Gradle and Maven).
 *
 * @param {string} xml
 * @returns {{passed: string[], failed: string[]}}
 */
export function parseJunitXml(xml) {
  const passed = [];
  const failed = [];
  const source = String(xml ?? '');
  const tagRe = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;

  for (const match of source.matchAll(tagRe)) {
    const attrs = match[1] ?? '';
    const inner = match[2] ?? '';
    const name = xmlAttr(attrs, 'name');
    const classname = xmlAttr(attrs, 'classname');
    if (!name) continue;
    if (/<skipped\b/i.test(inner)) continue;

    const id = classname ? `${classname} > ${name}` : name;
    if (/<(?:failure|error)\b/i.test(inner)) failed.push(id);
    else passed.push(id);
  }

  return { passed: dedupeSorted(passed), failed: dedupeSorted(failed) };
}

/**
 * Parse `go test -json` JSONL event stream. Only leaf events (carrying `Test`) are
 * results; package summaries without one are ignored.
 *
 * @param {string} text
 * @returns {{passed: string[], failed: string[]}}
 */
export function parseGoTestJson(text) {
  const passed = [];
  const failed = [];
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof event.Test !== 'string' || event.Test.length === 0) continue;
    const id = event.Package ? `${event.Package} > ${event.Test}` : event.Test;
    if (event.Action === 'pass') passed.push(id);
    else if (event.Action === 'fail') failed.push(id);
  }

  return { passed: dedupeSorted(passed), failed: dedupeSorted(failed) };
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
  const passed = [];
  const failed = [];
  for (const line of String(text ?? '').split('\n')) {
    const match = /^test\s+(.+?)\s+\.\.\.\s+(ok|FAILED|ignored)\s*$/.exec(line.trimEnd());
    if (!match || match[2] === 'ignored') continue;
    (match[2] === 'ok' ? passed : failed).push(match[1]);
  }
  return { passed: dedupeSorted(passed), failed: dedupeSorted(failed) };
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
 * @param {string[]} paths
 */
export async function cleanupReports(paths = []) {
  const temp = tmpdir();
  for (const path of paths ?? []) {
    if (!String(path).startsWith(temp)) continue;
    await rm(path, { recursive: true, force: true }).catch(() => {});
  }
}
