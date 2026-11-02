// The vector path: embeddings, one cosine score, one way to ask for a query vector.
//
// This module exists for one reason: it is the only part of the map that can open a
// socket. Everything here is called only when a caller passes
// `embed: true` - a `map`, `brief` or `slice` without the flag opens no socket, reads no
// stored vector and sends no embedding request, and the graph read never carries a
// vector. The acceptance bar lives beside the measurement in `map.mjs`
// (`EMBED_RECALL_GAIN_BAR`), because that is where recall@10 is computed; this module
// only supplies the vectors that measurement scores.

import { readLocalConfig } from '../local/config.mjs';
import { localEmbed } from '../local/client.mjs';
import { decodeVectorBlob } from './persist.mjs';
import { cmp } from '../util/sort.mjs';

/**
 * Brute-force cosine similarity between two numeric / Float32Array vectors.
 */
export function cosineSimilarity(a, b) {
  if (!a || !b) return 0;
  const len = Math.min(a.length ?? 0, b.length ?? 0);
  if (len === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i += 1) {
    const va = Number(a[i]) || 0;
    const vb = Number(b[i]) || 0;
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

/**
 * Rank stored vector embeddings against a query vector by brute-force cosine similarity.
 *
 * @param {{path: string, vec: Float32Array|number[]|Buffer}[]} embeddings
 * @param {Float32Array|number[]|Buffer} queryVector
 * @returns {{path: string, score: number}[]}
 */
export function rankByCosine(embeddings, queryVector) {
  const qVec = queryVector instanceof Float32Array ? queryVector : decodeVectorBlob(queryVector);
  if (!Array.isArray(embeddings) || embeddings.length === 0 || qVec.length === 0) return [];
  const scored = [];
  for (const row of embeddings) {
    if (!row?.path) continue;
    const vec = row.vec instanceof Float32Array ? row.vec : decodeVectorBlob(row.vec);
    if (vec.length === 0) continue;
    const sim = cosineSimilarity(vec, qVec);
    if (sim > 0) scored.push({ path: row.path, score: sim });
  }
  return scored.sort((a, b) => (a.score !== b.score ? (a.score < b.score ? 1 : -1) : cmp(a.path, b.path)));
}

/**
 * Embed a task query using the repository's configured `local.embed` endpoint.
 *
 * Returns `null` without opening a socket when `embed` is false, `local.embed`
 * is unset, or a non-loopback URL is refused.
 */
export async function embedTaskQuery(root, task, { embed = false, allowRemote = false, fetchImpl = undefined } = {}) {
  if (!embed || String(task ?? '').trim().length === 0) return null;
  const localCfg = await readLocalConfig(root, { allowRemote });
  if (!localCfg.embed || localCfg.embed.blocked) return null;
  const res = await localEmbed(localCfg.embed, {
    input: String(task).slice(0, 4096),
    allowRemote,
    fetchImpl,
  });
  if (!res.ok || !Array.isArray(res.embeddings?.[0]) || res.embeddings[0].length === 0) {
    return null;
  }
  return Float32Array.from(res.embeddings[0], (v) => Number(v) || 0);
}
