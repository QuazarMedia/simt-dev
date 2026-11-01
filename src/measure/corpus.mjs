// Sealed export / import of the mined benchmark corpus.
//
// The vault is keyed on the repository's root commit, outside every checkout, so
// a clone of the repository cannot read the hidden test patches the miner wrote:
// the committed corpus was unrunnable from any machine that was not the one that
// mined it. A sealed document carries the task descriptors and both patches for
// every task in a single file, so `bench export` on one machine and `bench import`
// on another reproduce the corpus exactly.
//
// The document is deterministic: no timestamp, tasks sorted by id, canonical
// (key-sorted) JSON, and a sha256 seal over everything but the seal itself. Two
// exports of the same corpus are byte-identical, and a reader can verify the
// seal before trusting a single byte of it.

import { createHash } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { STATE_DIR } from '../name.mjs';
import { packageVersion } from '../package-version.mjs';
import { resolveVaultDir } from '../testing/vault.mjs';

/** The document kind stamp, so a reader can refuse a file that is not a corpus. */
export const CORPUS_KIND = 'simt-bench-corpus';

/** The document schema version. Bump when the shape changes, not when content does. */
export const CORPUS_SCHEMA_VERSION = 1;

/**
 * Canonical serialisation: object keys sorted, no whitespace. Arrays keep their
 * order (the caller sorts them). This is what the seal hashes, so both the
 * exporter and the importer must reduce the payload to exactly this form.
 *
 * @param {*} value a JSON value
 * @returns {string}
 */
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

/**
 * @param {{tasks: object[]}} payload the document minus its seal
 * @returns {string} hex sha256 of the canonical payload
 */
function sealOf(payload) {
  return createHash('sha256').update(canonical(payload)).digest('hex');
}

function payloadOf(doc) {
  const { seal, ...payload } = doc;
  void seal;
  return payload;
}

/**
 * Read every mined task and its hidden patches from `root` and assemble the
 * sealed corpus document (no file written; the command decides where it goes).
 *
 * @param {string} root
 * @param {{env?: NodeJS.ProcessEnv}} [options]
 * @returns {Promise<object>} the sealed document
 */
export async function buildCorpusDocument(root, { env = process.env } = {}) {
  const absRoot = resolve(root);
  const tasksDir = join(absRoot, STATE_DIR, 'bench', 'tasks');
  const vaultRoot = resolveVaultDir(absRoot, { env });

  const names = (await readdir(tasksDir).catch(() => [])).filter((f) => f.endsWith('.json')).sort();
  const tasks = [];
  for (const name of names) {
    const task = JSON.parse(await readFile(join(tasksDir, name), 'utf8'));
    const testPatch = await readFile(join(vaultRoot, task.id, 'test.patch'))
      .then((b) => b.toString('base64'))
      .catch(() => '');
    const goldPatch = await readFile(join(vaultRoot, task.id, 'gold.patch'))
      .then((b) => b.toString('base64'))
      .catch(() => '');
    tasks.push({ id: task.id, task, testPatch, goldPatch });
  }
  tasks.sort((a, b) => a.id.localeCompare(b.id));

  const corpus = await readFile(join(dirname(tasksDir), 'corpus.json'), 'utf8')
    .then((t) => JSON.parse(t))
    .catch(() => null);

  const payload = {
    schemaVersion: CORPUS_SCHEMA_VERSION,
    kind: CORPUS_KIND,
    minedFrom: corpus?.minedFrom ?? null,
    simtVersion: corpus?.simtVersion ?? packageVersion(),
    taskCount: tasks.length,
    tasks,
  };
  return { ...payload, seal: sealOf(payload) };
}

/**
 * Verify a corpus document's seal. Returns a reason string when the document is
 * not a trusted corpus; `null` when it is.
 *
 * @param {object} doc
 * @returns {string|null}
 */
export function verifyCorpusDocument(doc) {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return 'not a corpus document';
  if (doc.kind !== CORPUS_KIND) return `unexpected kind \`${doc.kind}\` (want \`${CORPUS_KIND}\`)`;
  if (doc.schemaVersion !== CORPUS_SCHEMA_VERSION) {
    return `unsupported schemaVersion \`${doc.schemaVersion}\` (want ${CORPUS_SCHEMA_VERSION})`;
  }
  const payload = payloadOf(doc);
  if (sealOf(payload) !== doc.seal) return 'seal mismatch: the document was modified after it was sealed';
  if (!Array.isArray(payload.tasks)) return 'missing task list';
  return null;
}

/**
 * Write a verified corpus document into `root`: task descriptors to
 * `.simt/bench/tasks/` and the hidden patches to the vault. Idempotent — a task
 * already present is overwritten with the document's copy, which is the point of
 * importing a known corpus.
 *
 * @param {string} root
 * @param {object} doc a document that passed `verifyCorpusDocument`
 * @param {{env?: NodeJS.ProcessEnv, apply?: boolean}} [options]
 * @returns {Promise<{applied: boolean, tasks: number, tasksDir: string, vaultRoot: string}>}
 */
export async function writeCorpusDocument(root, doc, { env = process.env, apply = true } = {}) {
  const absRoot = resolve(root);
  const tasksDir = join(absRoot, STATE_DIR, 'bench', 'tasks');
  const vaultRoot = resolveVaultDir(absRoot, { env });

  if (apply) await mkdir(tasksDir, { recursive: true });
  for (const entry of doc.tasks) {
    if (apply) {
      await writeFile(join(tasksDir, `${entry.id}.json`), `${JSON.stringify(entry.task, null, 2)}\n`, 'utf8');
      const taskVault = join(vaultRoot, entry.id);
      // An imported corpus restores an answer key, so it gets the same 0700 the miner
      // gives one: the import must not be the cheaper way in.
      await mkdir(taskVault, { recursive: true, mode: 0o700 });
      await chmod(taskVault, 0o700).catch(() => {});
      await writeFile(join(taskVault, 'test.patch'), Buffer.from(entry.testPatch, 'base64'));
      await writeFile(join(taskVault, 'gold.patch'), Buffer.from(entry.goldPatch, 'base64'));
    }
  }

  return { applied: apply, tasks: doc.tasks.length, tasksDir, vaultRoot };
}
