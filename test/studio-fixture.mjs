// The studio test harness: spawn the binary, speak HTTP to it, stop it cleanly.
//
// The server is a long-running child, so these tests cannot use the fixture's
// wait-for-exit runner. Host-header refusal is asserted with raw node:http requests,
// because fetch derives Host from the URL and cannot present the foreign name the
// defense exists for. Two test files drive the same socket; the helpers live here so
// they cannot disagree about what a session is.

import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { BIN, git, tempDir } from './fixture.mjs';

const URL_LINE = /open (http:\/\/127\.0\.0\.1:(\d+)\/\?token=(\S+))/;

/**
 * A request that gives up: a server that accepts and never answers must fail the test,
 * not hang it. A suite whose one wedged socket waits forever has no run time at all.
 */
export function httpReq(port, { path = '/', method = 'GET', headers = {}, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`no response within ${timeoutMs} ms`)));
    req.end();
  });
}

export async function startStudio(cwd, extra = []) {
  const args = ['studio', '--no-open', ...(extra.includes('--port') ? [] : ['--port', '0']), ...extra];
  const child = spawn(process.execPath, [BIN, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const started = await new Promise((resolve, reject) => {
    // The poll must die with the promise: a child that exits before printing its URL
    // rejects, and an interval left behind then keeps the test process alive after every
    // test has run - a suite that fails one spawn and then hangs for the rest of the day.
    const poll = setInterval(() => {
      const m = out.match(URL_LINE);
      if (m) {
        clearTimeout(timer);
        clearInterval(poll);
        resolve({ url: m[1], port: Number(m[2]), token: m[3] });
      }
    }, 25);
    // The child that misses the window is still running, and a running child holds its
    // pipes open: kill it before rejecting, or the test process lives past the last test.
    const timer = setTimeout(() => {
      clearInterval(poll);
      child.kill('SIGKILL');
      reject(new Error(`studio did not start: ${out} ${err}`));
    }, 10000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      clearInterval(poll);
      reject(new Error(`studio exited ${code} before printing a URL: ${out} ${err}`));
    });
  });
  const stop = async () => {
    if (child.exitCode !== null) return child.exitCode;
    child.kill('SIGINT');
    return new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(-1); }, 5000);
      child.on('exit', (code) => { clearTimeout(timer); resolve(code); });
    });
  };
  return { child, stop, ...started, base: `http://127.0.0.1:${started.port}` };
}

/** Exchange the one-time token for the session cookie, the way the first page load does. */
export async function session(studio) {
  const res = await httpReq(studio.port, { path: `/?token=${studio.token}` });
  if (res.status !== 303) throw new Error(`token exchange refused: ${res.status} ${res.body}`);
  return res.headers['set-cookie'][0].split(';')[0];
}

/** A committed repository with a README and any files the test stages into it. */
export async function fixtureRepo(files = {}) {
  const root = await tempDir('simt-studio-');
  for (const [rel, body] of Object.entries({ 'README.md': '# studio fixture\n', ...files })) {
    const path = join(root, rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }
  await git(['init', '-q'], { cwd: root });
  await git(['add', '-A'], { cwd: root });
  await git(['commit', '-qm', 'fixture'], { cwd: root });
  return root;
}

/** Every file's content digest, so a test can prove a read left the tree untouched. */
export async function treeDigest(root) {
  const out = [];
  const walk = async (dir, rel) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const name = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path, name);
      else out.push(`${name} ${createHash('sha256').update(await readFile(path)).digest('hex')}`);
    }
  };
  await walk(root, '');
  return out.sort().join('\n');
}