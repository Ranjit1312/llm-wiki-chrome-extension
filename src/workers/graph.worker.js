/**
 * graph.worker.js — Graph construction, community detection, and persistence
 *
 * Handles:
 *  - DETECT_COMMUNITIES : Build graphology graph → run Louvain → return communities
 *  - SAVE_RESULTS       : Persist chunks, triplets, embeddings, perspectives to IDB
 */

import { buildGraph, detectCommunities } from '../lib/graph-engine.js';
import { saveChunks, saveTriplets, saveEmbeddings, savePerspectives } from '../lib/db.js';
import { invalidateIndex } from '../lib/vector-store.js';

// ─── Message handler ──────────────────────────────────────────────────────────
self.onmessage = async (e) => {
  const { id, type } = e.data;

  try {
    switch (type) {

      // ── Phase 3b: Community detection ─────────────────────────────
      case 'DETECT_COMMUNITIES': {
        const { entities, embeddings: rawEmbeddings, triplets } = e.data;

        // Reconstruct Float32Arrays from transferred buffers
        const embeddings = rawEmbeddings.map((v) =>
          v instanceof Float32Array ? v : new Float32Array(v),
        );

        self.postMessage({ type: 'STATUS', status: 'building_graph', tripletCount: triplets.length });

        // Build the knowledge graph
        const graph = buildGraph(triplets);

        self.postMessage({ type: 'STATUS', status: 'running_louvain', nodeCount: graph.order });

        // Run community detection
        const communities = detectCommunities(graph, entities, embeddings);

        self.postMessage({
          type:  'STATUS',
          status: 'communities_found',
          count:  communities.length,
        });

        self.postMessage({ id, result: communities });
        break;
      }

      // ── Phase 4: Full result persistence ──────────────────────────
      case 'SAVE_RESULTS': {
        const { chunks, triplets, embeddings: rawEmbeddings, perspectives, entities } = e.data;

        self.postMessage({ type: 'STATUS', status: 'saving_chunks' });
        await saveChunks(chunks);

        self.postMessage({ type: 'STATUS', status: 'saving_triplets' });
        await saveTriplets(triplets);

        self.postMessage({ type: 'STATUS', status: 'saving_embeddings' });
        // Re-assemble embedding records with community IDs
        const embeddingRecords = entities.map((entityName, idx) => {
          const vec  = rawEmbeddings[idx];
          const vector = vec instanceof Float32Array ? vec : new Float32Array(vec);
          // Find which community this entity belongs to
          const community = perspectives.find((p) => p.entities.includes(entityName));
          return {
            entityName,
            vector,
            communityId: community?.id ?? 'unclustered',
          };
        });
        await saveEmbeddings(embeddingRecords);

        self.postMessage({ type: 'STATUS', status: 'saving_perspectives' });
        await savePerspectives(perspectives);

        // Invalidate the vector-store in-memory index
        invalidateIndex();

        self.postMessage({ id, result: { ok: true } });
        break;
      }

      default:
        self.postMessage({ id, error: `Unknown message type: ${type}` });
    }
  } catch (err) {
    self.postMessage({ id, error: err.message });
  }
};
