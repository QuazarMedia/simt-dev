
import { readDoor } from './client.js';
import { loading, refusalPanel } from './components.js';
import { catalogCardsHtml, library, lessonShelfHtml, skillPane } from './library.js';

export async function libraryRoom() {
  const payload = await readDoor('/api/library');
  setTimeout(() => {
    const search = document.getElementById('library-search');
    search?.addEventListener('input', () => {
      document.getElementById('library-lessons').innerHTML = lessonShelfHtml(payload, search.value);
      document.getElementById('library-catalog').innerHTML = catalogCardsHtml(payload, search.value);
    });
    document.getElementById('view').onclick = async (event) => {
      const name = event.target.closest('[data-skill]')?.dataset.skill;
      if (!name) return;
      const reading = document.getElementById('library-reading');
      reading.innerHTML = loading(`reading ${name}`);
      try {
        reading.innerHTML = skillPane(await readDoor(`/api/library/skill?name=${encodeURIComponent(name)}`));
      } catch (error) {
        reading.innerHTML = refusalPanel(error.payload ?? { ok: false, error: String(error?.message ?? error), remedy: 'reload the page, then choose the skill again' });
      }
    };
  }, 0);
  return library(payload);
}
