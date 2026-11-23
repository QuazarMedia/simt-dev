import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import { commandAvailable } from '../testing/contract.mjs';
import { normalizePath } from './artifacts.mjs';

export const OBLIGATION_KINDS = Object.freeze(['structure', 'links', 'source-support', 'generation', 'procedure', 'semantic-review', 'remote-check']);
const EXECUTIONS = ['local', 'human', 'remote'];
const ID = /^[\w][\w.-]*$/;
const safeArg = (value) => typeof value === 'string' && value.length > 0 && !/[\u0000-\u001f\u007f]/.test(value);

export function validatorProblem(check) {
  if (!check || typeof check !== 'object' || Array.isArray(check) || (typeof check.id !== 'string' || !ID.test(check.id))) return 'needs an id using letters, digits, dots, underscores or hyphens';
  if (/^legacy-validator-[0-9]+$/.test(check.id)) return 'uses an id reserved for legacy validator commands';
  const fields = new Set(['id', 'argv', 'gate', 'cwd', 'covers', 'execution', 'provider', 'mandatory', 'timeoutMs']);
  const unknown = Object.keys(check).find((key) => !fields.has(key));
  if (unknown) return `has an unknown field ${unknown}`;
  const execution = check.execution ?? 'local';
  if (!EXECUTIONS.includes(execution)) return 'execution must be local, human or remote';
  if (!Array.isArray(check.covers) || check.covers.length === 0 || check.covers.some((kind) => !OBLIGATION_KINDS.includes(kind))) return 'covers must list declared obligation kinds';
  if (execution === 'local' ? (check.argv === undefined) === (check.gate === undefined)
    : check.argv !== undefined || check.gate !== undefined) return 'a local check needs exactly one of argv or gate, and human or remote checks carry neither';
  if (check.argv !== undefined && (!Array.isArray(check.argv) || check.argv.length === 0 || !check.argv.every(safeArg))) return 'argv must be a non-empty list of non-empty arguments without control characters';
  if (check.gate !== undefined && (typeof check.gate !== 'string' || !ID.test(check.gate))) return 'gate must be a configured gate id';
  if (check.cwd !== undefined && normalizePath(check.cwd) === null) return 'cwd must be inside the repository';
  if (check.provider !== undefined && !safeArg(check.provider)) return 'provider must be a non-empty name';
  if (check.mandatory !== undefined && typeof check.mandatory !== 'boolean') return 'mandatory must be true or false';
  if (check.timeoutMs !== undefined && (!Number.isInteger(check.timeoutMs) || check.timeoutMs < 1 || check.timeoutMs > 900_000)) return 'timeoutMs must be between 1 and 900000';
  if (execution === 'local' && check.covers.some((kind) => kind === 'semantic-review' || kind === 'remote-check')) return 'local checks cannot cover human or remote review obligations';
  return null;
}

// The existing gate accepts shell syntax. Scoped validation can adopt its simple
// argv form and refuses anything requiring expansion or another command.
function plainArgv(line) {
  if (typeof line !== 'string' || /[;&|<>`$\\\r\n*?~]/.test(line)) return null;
  const tokens = line.trim().match(/"[^"]+"|'[^']+'|[^\s"']+/g) ?? [];
  if (tokens.join(' ') !== line.trim().replace(/\s+(?=(?:[^"'\n]*["'][^"'\n]*["'])*[^"'\n]*$)/g, ' ')) return null;
  return tokens.length === 0 ? null : tokens.map((token) => token.replace(/^(['"])(.*)\1$/, '$2'));
}

function repoPath(root, cwd, value) {
  if (normalizePath(value) === null) return null;
  const target = resolve(cwd, value);
  return target === root || target.startsWith(`${root}/`) ? target : null;
}

export async function resolveWorkValidator(root, check, commands = {}) {
  const execution = check.execution ?? 'local';
  const argv = check.argv ?? plainArgv(check.gate ? commands[check.gate] : check.command);
  const cwd = resolve(root, check.cwd ?? '.');
  const descriptor = {
    id: check.id, argv: execution === 'local' ? argv : null, cwd,
    coverage: [...new Set(check.covers)], authority: 'repository', execution,
    provider: check.provider ?? null, mandatory: check.mandatory === true, timeoutMs: check.timeoutMs ?? 60_000,
    available: false, reason: null,
  };
  const refuse = (reason) => ({ ...descriptor, reason });
  if (execution !== 'local') return refuse(execution === 'human' ? 'human-review-required' : 'remote-check-unavailable-locally');
  if (argv === null) return refuse('missing-or-unsupported-command');
  const [program, ...args] = argv;
  if (cwd !== root && !cwd.startsWith(`${root}/`)) return refuse('cwd-outside-repository');
  try {
    if (await realpath(cwd) !== cwd || !(await stat(cwd)).isDirectory()) return refuse('cwd-outside-repository');
    if (!commandAvailable(program, { cwd })) return refuse('missing-executable');
    if (program.includes('/')) {
      const target = repoPath(root, cwd, program);
      if (target === null || await realpath(target) !== target) return refuse('executable-outside-repository');
    }
    for (const token of args) {
      if (token.startsWith('-') || (!token.includes('/') && !/\.(?:[cm]?js|ts|py|sh|rb|pl)$/i.test(token))) continue;
      const target = repoPath(root, cwd, token);
      if (target === null || await realpath(target) !== target) return refuse('input-outside-repository');
    }
  } catch {
    return refuse('missing-command-input');
  }
  return { ...descriptor, available: true };
}
