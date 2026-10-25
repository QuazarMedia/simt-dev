// `simt local doctor` — probe configured local model endpoints (plan 0003 R37).
//
// Reads `local: { chat: { url, model }, embed: { url, model } }` from `simt.json`.
// When `local` is unset, opens no socket and exits 0. Refuses non-loopback URLs
// without `--allow-remote` (ADR-075).

import { resolve } from 'node:path';
import { EXIT, emit, emitJson, fail, isJson } from '../output/index.mjs';
import { CLI, MANIFEST_FILE } from '../name.mjs';
import { probeLocal } from '../local/client.mjs';

function formatRoleLine(role, report) {
  if (!report) return `${role.padEnd(8)} (unset)`;
  if (report.status === 'refused-remote') {
    return `${role.padEnd(8)} refused-remote  ${report.model} @ ${report.url}`;
  }
  if (!report.ok) {
    return `${role.padEnd(8)} ${report.status}  ${report.model} @ ${report.url} (${report.error})`;
  }
  const extra =
    role === 'embed' && Number.isInteger(report.dimensions)
      ? `  dimensions=${report.dimensions}`
      : '';
  const listed =
    report.modelListed === true
      ? '  listed=yes'
      : report.modelListed === false
        ? '  listed=no'
        : '';
  return `${role.padEnd(8)} ok  ${report.model} @ ${report.url}${extra}${listed}`;
}

// `requestJson` shapes a non-OK response as "METHOD url failed (STATUS): message",
// so the HTTP status is the reliable signal here — 401/403 mean the server is up but
// rejected the request as unauthorised, which is a different remedy than "start it".
function isAuthFailure(report) {
  if (!report || typeof report.error !== 'string') return false;
  return /failed \(40[13]\)/.test(report.error);
}

function remedyFor(result) {
  if (result.status === 'refused-remote') {
    return `set a loopback URL (http://127.0.0.1:<port>/v1) in ${MANIFEST_FILE}, or run: ${CLI} local doctor --allow-remote`;
  }
  if (result.status === 'invalid-config' || result.status === 'invalid-manifest') {
    return `fix the \`local\` configuration in ${MANIFEST_FILE}`;
  }
  if (result.status === 'unreachable') {
    if ([result.chat, result.embed].some(isAuthFailure)) {
      return `the server is up but rejected the request as unauthorised (401/403); set \`local.<role>.apiKey\` in ${MANIFEST_FILE} to the server's bearer token, then rerun: ${CLI} local doctor`;
    }
    return `start the local model server at the URL in ${MANIFEST_FILE}, then rerun: ${CLI} local doctor`;
  }
  return null;
}

export async function localDoctorCommand(args, flags) {
  const root = resolve(flags.root ?? args[0] ?? process.cwd());
  const allowRemote = flags.allowRemote === true;
  const result = await probeLocal(root, { allowRemote });

  const code = result.ok
    ? EXIT.OK
    : result.status === 'refused-remote' ||
        result.status === 'invalid-config' ||
        result.status === 'invalid-manifest'
      ? EXIT.CONFIG
      : EXIT.FAIL;

  const error = result.ok ? null : result.findings[0] ?? `local model probe failed (${result.status})`;
  const remedy = result.ok ? null : remedyFor(result);

  if (isJson(flags)) {
    emitJson(
      {
        ok: code === EXIT.OK,
        command: 'local doctor',
        root,
        configured: result.configured,
        status: result.status,
        allowRemote: result.allowRemote,
        remoteBlocked: result.remoteBlocked,
        socketsOpened: result.socketsOpened,
        chat: result.chat,
        embed: result.embed,
        findings: result.findings,
        ...(error ? { error, remedy, exitCode: code } : {}),
      },
      { maxBytes: flags.maxBytes ?? 0 },
    );
    return code;
  }

  const lines = [
    `root     ${root}`,
    `local    ${result.configured ? result.status : '(unset)  optional adapter is off; no socket opened'}`,
    formatRoleLine('chat', result.chat),
    formatRoleLine('embed', result.embed),
    `sockets  ${result.socketsOpened}`,
  ];

  emit(lines.join('\n'), { maxBytes: flags.maxBytes ?? 0 });

  if (!result.ok) {
    return fail(error, code, remedy);
  }
  return EXIT.OK;
}
