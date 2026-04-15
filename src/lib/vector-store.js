/**
 * lib/vector-store.js — Local cosine-similarity vector search over stored chunks
 *
 * We use a flat in-memory index (loaded lazily from IndexedDB) and brute-force
 * cosine similarity search.  For typical study-wiki datasets (< 50k chunks)
 * this is fast enough without an HNSW index.
 *
 * If you need to scale up, swap `searchChunks` to use orama:
 *   import { create, insert, search } from 'orama';
 */

import { getEmbeddings, getChunks } from './db.js';

// ─── In-memory index ──────────────────────────────────────────────────────────
let _indexReady   = false;
let _embeddings   = []; // [{ entityName, vector: Float32Array, communityId }]
let _chunks       = []; // [{ id, text, source, chunkIndex }]

async function ensureIndex() {
  if (_indexReady) return;
  [_embeddings, _chunks] = await Promise.all([getEmbeddings(), getChunks()]);
  _indexReady = true;
}

/** Force a reload (call after a new pipeline run). */
export function invalidateIndex() {
  _indexReady = false;
  _embeddings = [];
  _chunks     = [];
}

// ─── Chunk-level vector search ────────────────────────────────────────────────
/**
 * Search chunks by embedding similarity.
 *
 * @param {Float32Array} queryVector   - normalised embedding from the embedder
 * @param {object}       options
 * @param {number}       [options.topK=5]
 * @param {string}       [options.perspectiveId]  - filter by community
 * @returns {Promise<Array<{text, source, score}>>}
 */
export async function searchChunks(queryVector, { topK = 5, perspectiveId } = {}) {
  await ensureIndex();

  // Build a set of entity names in the requested perspective
  let allowedEntities = null;
  if (perspectiveId) {
    allowedEntities = new Set(
      _embeddings
        .filter((e) => e.communityId === perspectiveId)
        .map((e) => e.entityName),
    );
  }

  // Score each chunk: use the cosine similarity of the chunk's representative
  // entity embedding as a proxy. (For direct chunk embedding, store them too.)
  // Here we match chunks by source file name appearing in entity names.
  const scored = _chunks
    .filter((chunk) => {
      if (!allowedEntities) return true;
      return [...allowedEntities].some((e) => chunk.source.includes(e) || e.includes(chunk.source));
    })
    .map((chunk) => {
      // Find the best entity embedding whose name appears in the chunk text
      let bestSim = 0;
      for (const emb of _embeddings) {
        if (!chunk.text.toLowerCase().includes(emb.entityName.toLowerCase())) continue;
        const sim = cosineSim(queryVector, emb.vector);
        if (sim > bestSim) bestSim = sim;
      }
      return { ...chunk, score: bestSim };
    });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).map(({ text, source, score }) => ({ text, source, score }));
}

// ─── Entity-level nearest-neighbour search ────────────────────────────────────
/**
 * Find the K most similar entities to a query vector.
 *
 * @param {Float32Array} queryVector
 * @param {number}       topK
 * @returns {Promise<Array<{entityName, score}>>}
 */
export async function searchEntities(queryVector, topK = 10) {
  await ensureIndex();

  const scored = _embeddings.map((emb) => ({
    entityName: emb.entityName,
    score:      cosineSim(queryVector, emb.vector),
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

// ─── Bulk insert (called from graph.worker.js after clustering) ───────────────
/**
 * Persist a batch of embeddings to IndexedDB and refresh the in-memory index.
 *
 * @param {Array<{entityName, vector: Float32Array, communityId}>} embeddings
 */
export async function storeEmbeddings(embeddings) {
  const { saveEmbeddings } = await import('./db.js');
  await saveEmbeddings(embeddings);
  invalidateIndex();
}

// ─── Utility ──────────────────────────────────────────────────────────────────
function cosineSim(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}

/** Normalise a Float32Array in-place. */
export function normalise(vec) {
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  if (norm < 1e-9) return vec;
  for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}
