// The fetch client: same-origin reads with the session cookie the browser already
// holds. A refused request becomes a DoorRefusal carrying the door's own payload, so
// the view renders the error and remedy instead of a spinner that never resolves.

export class DoorRefusal extends Error {
  constructor(payload, status) {
    const message = typeof payload?.error === 'string' ? payload.error : (payload?.error?.message ?? 'the studio refused the read');
    super(message);
    this.payload = payload;
    this.status = status;
  }
}

export async function readDoor(path) {
  let res;
  try {
    res = await fetch(path, { headers: { accept: 'application/json' } });
  } catch {
    throw new DoorRefusal(
      { ok: false, error: 'the studio socket did not answer', remedy: 'check the terminal that started the studio; restart it if it stopped' },
      0,
    );
  }
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  if (!res.ok) {
    throw new DoorRefusal(payload ?? { ok: false, error: `the studio answered ${res.status}`, remedy: 'reload the page; if it persists, restart the studio' }, res.status);
  }
  if (payload === null) {
    throw new DoorRefusal({ ok: false, error: 'the studio answered with a body that is not JSON', remedy: 'restart the studio; the shell and its server ship together' }, res.status);
  }
  return payload;
}