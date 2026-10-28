// `simt lease [<paths>...]`: claim files for one session, or read the claims (R54).
//
// The claim is the half of ADR-101 a session does by hand: `lease src/a.mjs --session
// alpha` records that alpha is working on the path until a TTL expires, the pre-edit
// hook reads the same file to refuse anyone else, and a bare `lease` lists what is
// currently held — because the first question a blocked session asks is "who has
// this", and opening a JSON file by hand is not an answer the tool should outsource.
//
// Two refusals are deliberate and both come from ADR-101: a path another session
// still holds is not taken (stealing is what the TTL is for, and the error names the
// holder and the expiry), and a claim file that will not parse is not overwritten
// (the hook fails closed on that same file, so writing over it would erase the very
// claims the hook is about to enforce while telling the author it fixed something).

import { EXIT, emit, emitJson, fail, isJson, writeMode } from '../output/index.mjs';
import { DEFAULT_TTL_SECONDS, activeLeases, leasePathFor, readLeases, writeLeases } from '../lease.mjs';
import { SESSION_ENV } from '../agenthooks/policy.mjs';
import { CLI } from '../name.mjs';

const ISO = (ms) => new Date(ms).toISOString();

export async function leaseCommand(args, flags) {
  const root = flags.root ?? process.cwd();

  // A session or a TTL with no paths is a claim about nothing; the parser would
  // otherwise hand back a list the caller never asked to see.
  if (args.length === 0) {
    if (flags.session !== undefined || flags.ttl !== undefined) {
      return fail(`lease without paths is a list, so it takes neither --session nor --ttl`, EXIT.USAGE, `run: ${CLI} lease <paths> --session <id>`);
    }
    return listLeases(root, flags);
  }

  const session = String(flags.session ?? process.env[SESSION_ENV] ?? '');
  if (session === '') {
    return fail(`lease needs a session to hold the claim`, EXIT.USAGE, `run: ${CLI} lease <paths> --session <id> (or set ${SESSION_ENV})`);
  }
  const ttl = flags.ttl === undefined ? DEFAULT_TTL_SECONDS : Number(flags.ttl);
  if (!Number.isInteger(ttl) || ttl < 1) {
    return fail(`--ttl must be a positive number of seconds, received ${flags.ttl}`, EXIT.USAGE, `example: run: ${CLI} lease <paths> --ttl 900`);
  }

  const wanted = [];
  const seen = new Set();
  for (const arg of args) {
    const rel = leasePathFor(root, arg);
    if (rel === null) {
      return fail(`${arg} is not a path inside the repository`, EXIT.USAGE, `leases are repository-relative: run: ${CLI} lease <path> --session ${session}`);
    }
    if (!seen.has(rel)) {
      seen.add(rel);
      wanted.push(rel);
    }
  }

  const read = await readLeases(root);
  if (read.error !== null) {
    return fail(`${read.error}`, EXIT.FAIL, `fix or remove ${read.path}; the pre-edit hook fails closed on it too`);
  }
  const held = activeLeases(read);
  const conflicts = held.filter((l) => seen.has(l.path) && l.session !== session);
  if (conflicts.length > 0) {
    return fail(
      `${conflicts.map((c) => `${c.path} is leased by ${c.session} until ${ISO(c.expiresAt)}`).join('; ')}`,
      EXIT.FAIL,
      `wait for the TTL or ask the holder to release it; run: ${CLI} lease to see every claim`,
    );
  }

  const expiresAt = Date.now() + ttl * 1000;
  const apply = `run: ${CLI} lease ${wanted.map((p) => JSON.stringify(p)).join(' ')} --session ${session} --yes`;
  const mode = writeMode(flags);
  const mine = wanted.map((path) => ({ path, session, expiresAt }));

  if (!mode.apply) {
    if (isJson(flags)) {
      emitJson({
        ok: true,
        command: 'lease',
        root,
        dryRun: true,
        session,
        ttl,
        leases: mine,
        remedy: apply,
      });
      return EXIT.OK;
    }
    const lines = [
      `repo     ${root}`,
      `session  ${session}`,
      `ttl      ${ttl}s`,
      ...mine.map((l) => `would    lease ${l.path} until ${ISO(l.expiresAt)}`),
      `apply    ${apply}`,
    ];
    emit(lines.join('\n'), { maxBytes: flags.maxBytes ?? 0 });
    return EXIT.OK;
  }

  // Keep every other live claim, refresh ours, and let an expired one fall out: the
  // write is also the only sweep the file ever gets.
  const others = held.filter((l) => !seen.has(l.path));
  const path = await writeLeases(root, [...others, ...mine]);

  if (isJson(flags)) {
    emitJson({ ok: true, command: 'lease', root, session, ttl, dryRun: false, leases: mine, file: path });
    return EXIT.OK;
  }
  const lines = [
    `repo     ${root}`,
    `session  ${session}`,
    `ttl      ${ttl}s`,
    ...mine.map((l) => `LEASED   ${l.path}  until ${ISO(l.expiresAt)}`),
  ];
  emit(lines.join('\n'), { maxBytes: flags.maxBytes ?? 0 });
  return EXIT.OK;
}

async function listLeases(root, flags) {
  const read = await readLeases(root);
  if (read.error !== null) {
    return fail(`${read.error}`, EXIT.FAIL, `fix or remove ${read.path}`);
  }
  const held = activeLeases(read);
  if (isJson(flags)) {
    emitJson({ ok: true, command: 'lease', root, leases: held });
    return EXIT.OK;
  }
  const lines = [
    `repo     ${root}`,
    ...held.map((l) => `LEASED   ${l.path}  ${l.session}  until ${ISO(l.expiresAt)}`),
  ];
  if (held.length === 0) lines.push(`(no active leases)`);
  emit(lines.join('\n'), { maxBytes: flags.maxBytes ?? 0 });
  return EXIT.OK;
}