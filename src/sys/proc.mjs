// One bounded child process and the environment a child inherits, for everything
// that runs one.
//
// `child.kill('SIGKILL')` kills the process the caller started and leaves its
// grandchildren running: an adapter that ran `(sleep 15 &); sleep 60` kept the pipe open
// and the caller waited 62.6 s against a 2 s timeout, then graded the result. A detached
// child is its own process group, so the deadline kills the group, destroys the streams
// and settles. A run cannot outlive its own deadline, whatever it spawned.
//
// Output is bounded so a runaway child cannot decide the caller's memory: past the cap
// the oldest chunk is dropped and `truncated` says so, rather than the spawn failing.
//
// This module used to live in `src/bench/` because the bench was its only caller. The
// bench is not the only thing that runs a child it does not trust, and a second copy of
// the deadline logic is a second way for a run to outlive its deadline.

import { spawn } from 'node:child_process';

/** The most output one run may accumulate before the oldest bytes are dropped. */
const DEFAULT_MAX_OUTPUT_BYTES = 8 << 20;

/** How long to wait for streams to close after the process group is killed. */
const HARD_STOP_GRACE_MS = 500;

function boundedPush(chunks, state, chunk) {
  state.bytes += chunk.length;
  chunks.push(chunk);
  while (state.bytes > state.max && chunks.length > 1) {
    state.bytes -= chunks.shift().length;
    state.truncated = true;
  }
}

/**
 * Run `cmd` with `args`, bounded by a deadline and an output cap.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv, input?: Buffer|string|null, timeoutMs?: number, maxOutputBytes?: number}} [options]
 * @returns {Promise<{code: number, timedOut: boolean, wallMs: number, stdout: Buffer, stderr: Buffer, truncated: boolean, spawnError: string|null}>}
 *   `code` is 124 when the deadline fired, and `wallMs` is what the run actually took.
 */
export function spawnBounded(
  cmd,
  args,
  { cwd, env, input = null, timeoutMs = 0, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES } = {},
) {
  return new Promise((settle) => {
    const startedAt = Date.now();
    let child;
    try {
      child = spawn(cmd, args, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (error) {
      settle({
        code: 1,
        timedOut: false,
        wallMs: 0,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from(String(error?.message ?? error)),
        truncated: false,
        spawnError: String(error?.message ?? error),
      });
      return;
    }

    const out = [];
    const err = [];
    const outState = { bytes: 0, max: maxOutputBytes, truncated: false };
    const errState = { bytes: 0, max: maxOutputBytes, truncated: false };
    let timer = null;
    let hardStop = null;
    let timedOut = false;
    let done = false;

    const killGroup = () => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          // Already gone; the close handler settles the promise.
        }
      }
    };

    const finish = (code, spawnError = null) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (hardStop) clearTimeout(hardStop);
      child.stdout?.destroy();
      child.stderr?.destroy();
      settle({
        code,
        timedOut,
        wallMs: Date.now() - startedAt,
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err),
        truncated: outState.truncated || errState.truncated,
        spawnError,
      });
    };

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killGroup();
        // A process that escaped the group can hold the pipes open after the kill, and a
        // deadline that waits on a stranger's cleanup is not a deadline.
        hardStop = setTimeout(() => finish(124), HARD_STOP_GRACE_MS);
        hardStop.unref?.();
      }, timeoutMs);
      timer.unref?.();
    }

    child.stdout?.on('data', (chunk) => boundedPush(out, outState, chunk));
    child.stderr?.on('data', (chunk) => boundedPush(err, errState, chunk));
    child.on('error', (error) => {
      const message = String(error?.message ?? error);
      boundedPush(err, errState, Buffer.from(message));
      finish(1, message);
    });
    child.on('close', (code) => finish(timedOut ? 124 : (code ?? 1)));

    child.stdin?.end(input ?? undefined);
  });
}

/**
 * What a spawned child is allowed to inherit from the operator's shell.
 *
 * Three bench modules grew this identically, and the differences between what a child
 * needs and what the shell carries are the whole point: `SIMT_DEV_WORKSPACE` is forced
 * off so a child cannot resolve THIS repository's workspace, and the `NODE_TEST*`
 * variables are dropped because they steer `node --test` at a test directory the child
 * does not have. Nothing here names a credential or a state directory: those come from
 * the caller's own `extra`.
 */
export function sanitizedEnv(extra = {}) {
  const env = { ...process.env, SIMT_DEV_WORKSPACE: 'off', ...extra };
  for (const key of Object.keys(env)) {
    if (key.startsWith('NODE_TEST')) delete env[key];
  }
  return env;
}
