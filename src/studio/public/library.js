// The Library: two lesson shelves and a skill card catalog, all from the doors' payloads.
//
// Search is a client-side filter over the fetched rows. Nothing is re-ranked: the order
// is the order `lessons list` and `skills index` returned, and a byte label is the
// registry's own number.

import { badge, card, emptyState, escapeHtml, refusalPanel } from './components.js';

export function formatBytes(bytes) {
  return `${Number(bytes ?? 0)} B`;
}

function candidateRow(candidate) {
  const story = candidate.errorLine
    ? `<p class="slot-error"><strong>failed</strong> ${escapeHtml(candidate.errorLine)}</p>${candidate.fixDiff ? `<pre class="computed">${escapeHtml(candidate.fixDiff)}</pre>` : ''}`
    : `<p class="computed">${escapeHtml(candidate.summary ?? 'no fail-then-fix story recorded')}</p>`;
  return `<article class="card library-candidate" data-lesson="${escapeHtml(candidate.id)}">
    <header><strong>${escapeHtml(candidate.id)}</strong> ${badge(candidate.kind ?? 'candidate', 'warn')}</header>
    ${story}
    <p class="computed"><code>simt lessons review ${escapeHtml(candidate.id)} --yes</code></p>
    <p class="computed">review stays a CLI act; the studio only names it.</p>
  </article>`;
}

function promotedRow(lesson) {
  return `<article class="card library-lesson" data-lesson="${escapeHtml(lesson.id)}">
    <header><strong>${escapeHtml(lesson.title ?? lesson.id)}</strong> ${badge(lesson.expired ? 'expired' : 'promoted', lesson.expired ? 'bad' : 'ok')}</header>
    <p class="computed"><code>${escapeHtml(lesson.id)}</code>${lesson.expires ? ` · expires ${escapeHtml(lesson.expires)}` : ''}</p>
    <p>${escapeHtml(lesson.summary ?? '')}</p>
  </article>`;
}

function skillCard(skill) {
  return `<button type="button" class="skill-card" data-skill="${escapeHtml(skill.name)}">
    <span class="skill-name">${escapeHtml(skill.name)}</span>
    <span class="computed">${escapeHtml(formatBytes(skill.bytes))}${skill.deferred ? ' · deferred' : ''}</span>
    <span class="computed">${escapeHtml(skill.summary ?? '')}</span>
  </button>`;
}

function textOf(lesson) {
  return [lesson.id, lesson.title, lesson.summary, lesson.errorLine, lesson.kind].filter(Boolean).join(' ').toLowerCase();
}

export function filterLibrary(payload, query) {
  const q = String(query ?? '').trim().toLowerCase();
  const lessons = payload?.lessons ?? {};
  const candidates = (lessons.candidates ?? []).filter((c) => c.status !== 'promoted');
  const promoted = lessons.promoted ?? [];
  const skills = payload?.skills?.skills ?? [];
  if (!q) return { candidates, promoted, skills };
  return {
    candidates: candidates.filter((c) => textOf(c).includes(q)),
    promoted: promoted.filter((l) => textOf(l).includes(q)),
    skills: skills.filter((s) => [s.name, s.summary, ...(s.capabilities ?? []), ...(s.stack ?? [])].join(' ').toLowerCase().includes(q)),
  };
}

const shelf = (title, rows, render, empty) =>
  card({
    title,
    body: rows.length > 0 ? `<div class="rows library-shelf">${rows.map(render).join('')}</div>` : emptyState({ title: empty, hint: 'Nothing on this shelf yet.' }),
  });

/** The two lesson shelves after the client-side filter. */
export function lessonShelfHtml(payload, query = '') {
  const lessons = payload?.lessons;
  if (lessons?.ok === false) return refusalPanel(lessons);
  const view = filterLibrary(payload, query);
  return shelf('Candidates', view.candidates, candidateRow, 'No candidates') + shelf('Promoted lessons', view.promoted, promotedRow, 'No promoted lessons');
}

/** The skill cards after the same filter; clicking one opens the reading pane. */
export function catalogCardsHtml(payload, query = '') {
  if (payload?.skills?.ok === false) return refusalPanel(payload.skills);
  return filterLibrary(payload, query).skills.map(skillCard).join('');
}

export function catalogHtml(payload, query = '') {
  return `<div id="library-catalog" class="library-catalog">${catalogCardsHtml(payload, query)}</div>`;
}

/** The library page: search, candidate shelf, promoted shelf, and the catalog. */
export function library(payload) {
  if (!payload || typeof payload !== 'object') return refusalPanel({ ok: false, error: 'the library returned no payload', remedy: 'reload the page' });
  const count = payload.skills?.skills?.length;
  return `<section class="library" aria-label="Library">
    <label class="library-search" for="library-search">filter lessons and skills <input id="library-search" type="search" autocomplete="off" placeholder="name, capability or failure"></label>
    <div id="library-lessons">${lessonShelfHtml(payload)}</div>
    ${card({ title: count === undefined ? 'Skill catalog' : `Skill catalog · ${count} skills`, body: catalogHtml(payload) })}
    <div id="library-reading" class="library-reading" aria-live="polite">${emptyState({ title: 'Reading pane', hint: 'Choose a skill to read its body.' })}</div>
  </section>`;
}

/** One skill body, in the pane, exactly as `skills show --json` returned it. */
export function skillPane(payload) {
  if (!payload?.ok) return refusalPanel(payload ?? { ok: false });
  const skill = payload.skill ?? {};
  return `<article class="card skill-reading">
    <header><h2>${escapeHtml(skill.name ?? 'skill')}</h2>${payload.bodyFrom ? badge(payload.bodyFrom, 'neutral') : ''}</header>
    <p class="computed">${escapeHtml(formatBytes(skill.bytes))}${skill.deferred ? ' · deferred' : ''}</p>
    <p>${escapeHtml(skill.summary ?? '')}</p>
    <pre class="skill-body">${escapeHtml(payload.bodyText ?? '(no body)')}</pre>
  </article>`;
}
