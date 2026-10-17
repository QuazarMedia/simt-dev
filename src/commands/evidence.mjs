// `simt evidence` — the proof block for this tree, and the commit-message check.
//
// The read answers "what has actually been run against what is on disk". The check
// answers the other half: a message that says the tests passed, when nothing in the
// ledger was run against this tree (ADR-087).

import { readFile } from 'node:fs/promises';

import { EXIT, emit, emitJson, fail, isJson } from '../output/index.mjs';
import { readManifest } from '../projection/manifest.mjs';
import { CLI, MANIFEST_FILE } from '../name.mjs';
import { claimsVerification, evidenceMode, readLedger, treeId } from '../ledger/index.mjs';

export async function evidenceCommand(args, flags) {
  const root = flags.root ?? process.cwd();
  if (args[0] === 'check') return checkClaim(root, args[1], flags);
  if (args[0] !== undefined) {
    return fail(`unknown evidence subcommand ${args[0]}`, EXIT.USAGE, `run: ${CLI} evidence`);
  }
  return showEvidence(root, flags);
}

async function showEvidence(root, flags) {
  let tree;
  try {
    tree = await treeId(root);
  } catch (error) {
    return fail(
      `could not name this tree (${error.message})`,
      EXIT.UNSUPPORTED,
      'run this inside a git repository',
    );
  }
  const { entries, errors } = await readLedger(root);
  const mine = entries.filter((e) => e.tree === tree);
  const payload = { ok: errors.length === 0, command: 'evidence', root, tree, entries: mine, errors };
  if (isJson(flags)) {
    emitJson(payload, { pretty: flags.pretty === true, maxBytes: flags.maxBytes ?? 0 });
    return errors.length === 0 ? EXIT.OK : EXIT.FAIL;
  }
  const lines = [`tree     ${tree}`];
  if (mine.length === 0) lines.push('none     no run is recorded for this tree');
  for (const e of mine) {
    lines.push(`${e.exit === 0 ? 'pass' : 'fail'}     ${e.cmd}  exit ${e.exit}  ${e.summary}`);
  }
  for (const error of errors) lines.push(`error    ${error}`);
  emit(lines.join('\n'), { maxBytes: flags.maxBytes ?? 0 });
  return errors.length === 0 ? EXIT.OK : EXIT.FAIL;
}

async function checkClaim(root, file, flags) {
  if (!file) return fail('evidence check needs the commit message file', EXIT.USAGE, `run: ${CLI} evidence check <file>`);
  let message;
  try {
    message = await readFile(file, 'utf8');
  } catch (error) {
    return fail(`could not read ${file} (${error.message})`, EXIT.USAGE, `pass the path git gives commit-msg`);
  }
  const { manifest, error } = await readManifest(root);
  if (error) return fail(`${MANIFEST_FILE}: ${error}`, EXIT.CONFIG, `fix ${MANIFEST_FILE} so it parses`);
  const mode = evidenceMode(manifest);
  if (mode === null) {
    return fail(
      `${MANIFEST_FILE} gates.evidence must be "warn" or "block"`,
      EXIT.CONFIG,
      `set gates.evidence to "warn" or "block", or remove it`,
    );
  }
  const claim = claimsVerification(message);
  if (!claim) {
    const payload = { ok: true, command: 'evidence check', claim: false, mode };
    if (isJson(flags)) emitJson(payload, { pretty: flags.pretty === true });
    return EXIT.OK;
  }
  let tree;
  try {
    tree = await treeId(root);
  } catch (error) {
    return fail(`could not name this tree (${error.message})`, EXIT.UNSUPPORTED, 'run this inside a git repository');
  }
  const { entries } = await readLedger(root);
  const supported = entries.some((e) => e.tree === tree && e.exit === 0);
  const payload = { ok: supported || mode === 'warn', command: 'evidence check', claim: true, supported, mode, tree };
  if (supported) {
    if (isJson(flags)) emitJson(payload, { pretty: flags.pretty === true });
    return EXIT.OK;
  }
  const detail = 'the message claims a run this tree does not have';
  const remedy = `run the command, then commit, or take the claim out of the message`;
  if (isJson(flags)) {
    emitJson({ ...payload, detail, remedy }, { pretty: flags.pretty === true });
    return mode === 'block' ? EXIT.FAIL : EXIT.OK;
  }
  emit(`${mode === 'block' ? 'BLOCKED' : 'WARNING'}  ${detail}\n         remedy: ${remedy}`, { maxBytes: flags.maxBytes ?? 0 });
  return mode === 'block' ? EXIT.FAIL : EXIT.OK;
}
