
import { readDoor } from './client.js';
import { loading, refusalPanel } from './components.js';
import { bench, calibrationView, replayView } from './bench.js';

function bind() {
  const view = document.getElementById('view');
  document.getElementById('bench-compare')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const baseline = String(data.get('baseline') ?? '').trim();
    const candidate = String(data.get('candidate') ?? '').trim();
    if (!baseline || !candidate) return;
    view.innerHTML = loading('comparing the two arms');
    try {
      view.innerHTML = bench(await readDoor(`/api/bench?compare=${encodeURIComponent(`${baseline},${candidate}`)}`));
      bind();
    } catch (error) {
      view.innerHTML = refusalPanel(error.payload ?? { ok: false, error: String(error?.message ?? error), remedy: 'reload the room, then compare two measured arms' });
    }
  });
  document.getElementById('bench-input')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const kind = String(data.get('kind') ?? 'calibrate');
    const input = String(data.get('input') ?? '').trim();
    if (!input) return;
    const result = document.getElementById('bench-input-result');
    result.innerHTML = loading(`reading ${kind}`);
    try {
      const answer = await readDoor(`/api/bench/${kind}?input=${encodeURIComponent(input)}`);
      result.innerHTML = kind === 'replay' ? replayView(answer) : calibrationView(answer);
    } catch (error) {
      result.innerHTML = refusalPanel(error.payload ?? { ok: false, error: String(error?.message ?? error), remedy: 'keep the input inside the repository, then try again' });
    }
  });
}

export async function benchRoom() {
  const payload = await readDoor('/api/bench');
  setTimeout(bind, 0);
  return bench(payload);
}
