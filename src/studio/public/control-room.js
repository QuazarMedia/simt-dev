// The control room's wiring: preview, confirm by digest, apply, then offer undo.
//
// Kept out of app.js so the shell entry stays under the per-asset line ceiling; the view
// builders and the POST client remain the single owners of the markup and transport.

import { postDoor, readDoor } from './client.js';
import { loading, refusalPanel } from './components.js';
import { control, controlApplied, controlPreview } from './control.js';

export async function controlRoom() {
  const payload = await readDoor('/api/control');
  if (!payload.ok) return control(payload);
  setTimeout(() => {
    const result = document.getElementById('control-result');
    let current = null;
    const readValues = () => {
      try {
        const args = JSON.parse(document.getElementById('control-args').value);
        const flags = JSON.parse(document.getElementById('control-flags').value);
        if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) throw new Error('args must be an array of strings');
        if (flags === null || typeof flags !== 'object' || Array.isArray(flags)) throw new Error('flags must be a JSON object');
        return { args, flags };
      } catch (error) {
        result.innerHTML = refusalPanel({ ok: false, error: String(error.message ?? error), remedy: 'fix the JSON inputs, then preview again' });
        return null;
      }
    };
    const preview = async (command, args, flags) => {
      result.innerHTML = loading('running the preview');
      try {
        const answer = await postDoor('/api/control/preview', { command, args, flags });
        current = { command, args, flags, digest: answer.digest };
        result.innerHTML = controlPreview(answer);
      } catch (error) {
        result.innerHTML = refusalPanel(error.payload ?? { ok: false, error: String(error?.message ?? error), remedy: 'fix the request, then preview again' });
      }
    };
    document.getElementById('control-preview')?.addEventListener('click', () => {
      const values = readValues();
      if (values) preview(document.getElementById('control-command').value, values.args, values.flags);
    });
    result.addEventListener('click', async (event) => {
      const action = event.target.closest('[data-action]')?.dataset.action;
      if (action === 'apply' && current) {
        result.innerHTML = loading('applying the previewed plan');
        try {
          result.innerHTML = controlApplied(await postDoor('/api/control/apply', { ...current }));
        } catch (error) {
          result.innerHTML = refusalPanel(error.payload ?? { ok: false, error: String(error?.message ?? error), remedy: 'preview again, then confirm the new digest' });
        }
      } else if (action === 'undo-preview') {
        preview('undo', [], {});
      }
    });
  }, 0);
  return control(payload);
}
