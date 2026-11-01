// `simt lease [<paths>...]`: claim files for one session, or read the claims (R54).
// `lease release` and `lease renew` end and extend the holder's own claims: the
// denial tells a blocked session to ask the holder to release the path, so the
// holder needs a command that does it.
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

import { EXIT, emit, emitJson, fail, isJson, note, writeMode } from '../output/index.mjs';
import {
  DEFAULT_TTL_SECONDS,
  activeLeases,
  canonicalLeasePath,
  flattenLease,
  leaseCovers,
  readLeases,
  withLeaseLock,
  writeLeases,
} from '../lease.mjs';
import { coreIgnoreCase } from '../repo-root.mjs';
import { noteEvent } from '../state/events.mjs';
import { SESSION_ENV } from '../agenthooks/policy.mjs';
import { CLI } from '../name.mjs';
import { commandRoot } from '../repo-root.mjs';

const ISO = (ms) => new Date(ms).toISOString();

export async function leaseCommand(args, flags) {
  const root = commandRoot(flags);
  const [sub, ...rest] = args;
  // The denial tells a blocked session to ask the holder to release the path,
  // so releasing is a subcommand, not a missing flag.
  if (sub === 'release') return releaseLeases(root, rest, flags);
  if (sub === 'renew') return renewLeases(root, rest, flags);

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
  const harness = typeof flags.harness === 'string' && flags.harness !== '' ? flags.harness : null;

  const wanted = [];
  const seen = new Set();
  // A trailing slash asks for the directory (Q74): one claim covering every path under it.
  const kinds = new Map();
  // The claim is stored in the one spelling the hook's comparison will produce:
  // a claim taken as `src/Keep.mjs` and an edit that spells `src/keep.mjs` must
  // be the same claim on a case-insensitive volume, so the stored path is
  // canonical at write time, not at read time.
  const ignoreCase = coreIgnoreCase(root);
  for (const arg of args) {
    const rel = canonicalLeasePath(root, arg, { ignoreCase });
    if (rel === null) {
      return fail(`${arg} is not a path inside the repository`, EXIT.USAGE, `leases are repository-relative: run: ${CLI} lease <path> --session ${session}`);
    }
    if (!seen.has(rel)) {
      seen.add(rel);
      wanted.push(rel);
      kinds.set(rel, String(arg).endsWith('/') ? 'dir' : 'path');
    }
  }

  // Older claim files hold the pre-canonical spelling, so a stored path is
  // canonicalised before it is compared: a claim written before the resolver
  // existed must still conflict with a claim taken for the same file.
  // A claim and a target overlap when either covers the other: claiming `src/` while
  // `src/a.mjs` is held is the conflict the directory claim exists to catch (Q74).
  const overlaps = (l) =>
    wanted.some(
      (rel) =>
        leaseCovers(l, rel) ||
        (kinds.get(rel) === 'dir' && (l.path === rel || l.path.startsWith(`${rel}/`))),
    );
  const newClaim = (expiresAt, held) =>
    wanted.map((path) => {
      const fences = held.filter((l) => leaseCovers(l, path)).map((l) => Number(l.fence) || 0);
      return flattenLease({
        resource: { kind: kinds.get(path) ?? 'path', id: path },
        holder: { session, harness },
        fence: 1 + (fences.length === 0 ? 0 : Math.max(...fences)),
        acquiredAt: Date.now(),
        expiresAt,
      });
    });

  const mode = writeMode(flags);
  if (!mode.apply) {
    const mine = newClaim(Date.now() + ttl * 1000, []);
    const apply = `run: ${CLI} lease ${wanted.map((p) => JSON.stringify(p)).join(' ')} --session ${session} --yes`;
    if (isJson(flags)) {
      emitJson({ ok: true, command: 'lease', root, dryRun: true, session, ttl, leases: mine, remedy: apply });
      return EXIT.OK;
    }
    const lines = [
      `repo     ${root}`,
      `session  ${session}`,
      `ttl      ${ttl}s`,
      ...mine.map((l) => `would    lease ${l.path} until ${ISO(l.expiresAt)}`),
      `apply    ${apply}`,
    ];
    emit(lines.join('\n'));
    return EXIT.OK;
  }

  // The read-modify-write happens under the lock: twelve concurrent claims
  // stored seven before this, because every claimant read the same file and
  // each wrote back only what it had seen.
  const claimed = await withLeaseLock(root, async () => {
    const read = await readLeases(root);
    if (read.error !== null) return { error: read.error, path: read.path };
    const held = activeLeases(read);
    const conflicts = held.filter((l) => overlaps(l) && l.session !== session);
    if (conflicts.length > 0) return { conflicts };
    // Keep every other live claim, refresh ours, and let an expired one fall out:
    // the write is also the only sweep the file ever gets.
    const others = held.filter((l) => !overlaps(l));
    const mine = newClaim(Date.now() + ttl * 1000, held);
    const path = await writeLeases(root, [...others, ...mine]);
    return { mine, path };
  });
  if (claimed.error) {
    return fail(`${claimed.error}`, EXIT.FAIL, `fix or remove ${claimed.path}; the pre-edit hook fails closed on it too`);
  }
  if (claimed.conflicts) {
    return fail(
      `${claimed.conflicts.map((c) => `${c.path} is leased by ${c.session} until ${ISO(c.expiresAt)}`).join('; ')}`,
      EXIT.FAIL,
      `wait for the TTL or ask the holder to release it (${CLI} lease release <paths> --session ${session}); run: ${CLI} lease to see every claim`,
    );
  }
  const { mine, path } = claimed;
  // Coordination state a hook acts on belongs in the log a UI can tail, not only in a
  // file a person has to open (Q73).
  await noteEvent(root, {
    kind: 'lease.acquired',
    session,
    harness: harness ?? null,
    subject: mine.map((l) => l.path).join(','),
    data: { ttl, fence: mine[0]?.fence ?? null },
  });

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
  emit(lines.join('\n'));
  return EXIT.OK;
}

/** Resolve release/renew targets to canonical paths, or the usage failure. */
function resolveTargets(root, args, session, verb) {
  if (args.length === 0) {
    return { error: fail(`lease ${verb} needs paths`, EXIT.USAGE, `run: ${CLI} lease ${verb} <paths> --session <id>`) };
  }
  const ignoreCase = coreIgnoreCase(root);
  const wanted = [];
  const seen = new Set();
  const kinds = new Map();
  for (const arg of args) {
    const rel = canonicalLeasePath(root, arg, { ignoreCase });
    if (rel === null) {
      return { error: fail(`${arg} is not a path inside the repository`, EXIT.USAGE, `leases are repository-relative`) };
    }
    if (!seen.has(rel)) {
      seen.add(rel);
      wanted.push(rel);
      kinds.set(rel, String(arg).endsWith('/') ? 'dir' : 'path');
    }
  }
  return { wanted, seen, ignoreCase, kinds };
}

function claimSession(flags) {
  const session = String(flags.session ?? process.env[SESSION_ENV] ?? '');
  if (session === '') {
    return { error: fail(`lease needs a session to hold the claim`, EXIT.USAGE, `run: ${CLI} lease <paths> --session <id> (or set ${SESSION_ENV})`) };
  }
  return { session };
}

async function releaseLeases(root, args, flags) {
  const { session, error: sessionError } = claimSession(flags);
  if (sessionError !== undefined) return sessionError;
  const resolved = resolveTargets(root, args, session, 'release');
  if (resolved.error !== undefined) return resolved.error;
  const { wanted, seen, ignoreCase, kinds } = resolved;
  const overlaps = (l) =>
    wanted.some(
      (rel) =>
        leaseCovers(l, rel) ||
        (kinds.get(rel) === 'dir' && (l.path === rel || l.path.startsWith(`${rel}/`))),
    );
  const mode = writeMode(flags);

  const released = await withLeaseLock(root, async () => {
    const read = await readLeases(root);
    if (read.error !== null) return { error: read.error, path: read.path };
    const held = activeLeases(read);
    const foreign = held.filter((l) => overlaps(l) && l.session !== session);
    if (foreign.length > 0) {
      return {
        conflicts: foreign.map((c) => `${c.path} is leased by ${c.session} until ${ISO(c.expiresAt)}`).join('; '),
      };
    }
    const dropped = held.filter((l) => overlaps(l));
    if (!mode.apply) return { preview: dropped };
    const kept = held.filter((l) => !overlaps(l));
    const path = await writeLeases(root, kept);
    return { dropped, path };
  });
  if (released.error) {
    return fail(`${released.error}`, EXIT.FAIL, `fix or remove ${released.path}`);
  }
  if (released.conflicts) {
    return fail(`${released.conflicts}`, EXIT.FAIL, `only the holder releases a claim; wait for the TTL or ask ${session} to run: ${CLI} lease release`);
  }
  if (!mode.apply) {
    const lines = [
      `repo     ${root}`,
      `session  ${session}`,
      ...released.preview.map((l) => `would    release ${l.path} (held by ${l.session})`),
      ...(released.preview.length === 0 ? ['(no active claims on those paths)'] : []),
      `apply    run: ${CLI} lease release ${wanted.map((p) => JSON.stringify(p)).join(' ')} --session ${session} --yes`,
    ];
    if (isJson(flags)) emitJson({ ok: true, command: 'lease release', root, dryRun: true, session, leases: released.preview });
    else emit(lines.join('\n'));
    return EXIT.OK;
  }
  await noteEvent(root, {
    kind: 'lease.released',
    session,
    subject: released.dropped.map((l) => l.path).join(','),
    data: { released: released.dropped.length },
  });
  for (const l of released.dropped) note(`note     released ${l.path} (was held by ${l.session})`);
  if (isJson(flags)) emitJson({ ok: true, command: 'lease release', root, dryRun: false, session, leases: released.dropped });
  else {
    emit(
      [
        `repo     ${root}`,
        `session  ${session}`,
        ...released.dropped.map((l) => `RELEASED ${l.path}`),
        ...(released.dropped.length === 0 ? ['(no active claims on those paths)'] : []),
      ].join('\n'),
    );
  }
  return EXIT.OK;
}

async function renewLeases(root, args, flags) {
  const { session, error: sessionError } = claimSession(flags);
  if (sessionError !== undefined) return sessionError;
  const resolved = resolveTargets(root, args, session, 'renew');
  if (resolved.error !== undefined) return resolved.error;
  const { wanted, seen, ignoreCase, kinds } = resolved;
  const ttl = flags.ttl === undefined ? DEFAULT_TTL_SECONDS : Number(flags.ttl);
  if (!Number.isInteger(ttl) || ttl < 1) {
    return fail(`--ttl must be a positive number of seconds, received ${flags.ttl}`, EXIT.USAGE, `example: run: ${CLI} lease renew <paths> --ttl 900`);
  }
  const overlaps = (l) =>
    wanted.some(
      (rel) =>
        leaseCovers(l, rel) ||
        (kinds.get(rel) === 'dir' && (l.path === rel || l.path.startsWith(`${rel}/`))),
    );
  const mode = writeMode(flags);

  const renewed = await withLeaseLock(root, async () => {
    const read = await readLeases(root);
    if (read.error !== null) return { error: read.error, path: read.path };
    const held = activeLeases(read);
    const foreign = held.filter((l) => overlaps(l) && l.session !== session);
    if (foreign.length > 0) {
      return {
        conflicts: foreign.map((c) => `${c.path} is leased by ${c.session} until ${ISO(c.expiresAt)}`).join('; '),
      };
    }
    const expiresAt = Date.now() + ttl * 1000;
    const mine = held.map((l) => (overlaps(l) ? { ...l, expiresAt } : l));
    const touched = held.filter((l) => overlaps(l));
    if (!mode.apply) return { preview: touched.map((l) => ({ ...l, expiresAt })) };
    const path = await writeLeases(root, mine);
    return { touched: touched.map((l) => ({ ...l, expiresAt })), path };
  });
  if (renewed.error) {
    return fail(`${renewed.error}`, EXIT.FAIL, `fix or remove ${renewed.path}`);
  }
  if (renewed.conflicts) {
    return fail(`${renewed.conflicts}`, EXIT.FAIL, `only the holder renews a claim; run: ${CLI} lease to see every claim`);
  }
  const rows = mode.apply ? renewed.touched : renewed.preview;
  if (isJson(flags)) emitJson({ ok: true, command: 'lease renew', root, dryRun: !mode.apply, session, ttl, leases: rows });
  else {
    emit(
      [
        `repo     ${root}`,
        `session  ${session}`,
        `ttl      ${ttl}s`,
        ...rows.map((l) => `${mode.apply ? 'RENEWED  ' : 'would    renew '} ${l.path} until ${ISO(l.expiresAt)}`),
        ...(rows.length === 0 ? ['(no active claims on those paths)'] : []),
      ].join('\n'),
    );
  }
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
    ...held.map((l) => `LEASED   ${l.path}  ${l.session}${l.harness ? `/${l.harness}` : ''}  until ${ISO(l.expiresAt)}`),
  ];
  if (held.length === 0) lines.push(`(no active leases)`);
  emit(lines.join('\n'));
  return EXIT.OK;
}