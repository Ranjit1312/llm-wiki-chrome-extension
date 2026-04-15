/**
 * lib/graph-engine.js — GraphRAG graph construction and community detection
 *
 * Uses graphology for the graph structure and graphology-communities-louvain
 * for community detection. Falls back to a simple label-propagation algorithm
 * if Louvain is unavailable.
 *
 * Community → Perspective mapping:
 *  Each Louvain community becomes one "Perspective" in the UI.
 *  The top-N entities (by degree centrality) are used as perspective seeds.
 */

import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';

const TOP_ENTITIES_PER_COMMUNITY = 8;
const MIN_COMMUNITY_SIZE         = 3;

/**
 * Build a directed graph from extracted triplets.
 *
 * @param {Array<{source, rel, target, type}>} triplets
 * @returns {Graph}
 */
export function buildGraph(triplets) {
  const graph = new Graph({ type: 'directed', multi: false });

  for (const t of triplets) {
    if (!t.source || !t.target) continue;

    if (!graph.hasNode(t.source)) graph.addNode(t.source, { type: t.type ?? 'unknown', degree: 0 });
    if (!graph.hasNode(t.target)) graph.addNode(t.target, { type: t.type ?? 'unknown', degree: 0 });

    const edgeKey = `${t.source}||${t.rel}||${t.target}`;
    if (!graph.hasEdge(edgeKey)) {
      graph.addEdgeWithKey(edgeKey, t.source, t.target, { rel: t.rel, weight: 1 });
    } else {
      // Reinforce existing edges (higher weight = stronger relationship)
      graph.updateEdgeAttribute(edgeKey, 'weight', (w) => (w ?? 1) + 1);
    }
  }

  // Compute degree for each node
  graph.forEachNode((node) => {
    graph.setNodeAttribute(node, 'degree', graph.degree(node));
  });

  return graph;
}

/**
 * Run Louvain community detection and return an array of community objects.
 *
 * @param {Graph} graph
 * @param {string[]} entities          - ordered list matching embeddings
 * @param {Array<Float32Array>} embeddings
 * @returns {Array<{id, entities, topEntities, centroid}>}
 */
export function detectCommunities(graph, entities, embeddings) {
  let communityMap;

  try {
    communityMap = louvain(graph, { resolution: 1.0 });
  } catch {
    // Fallback: assign communities by connected component
    communityMap = fallbackCommunities(graph);
  }

  // Group entities by community
  const groups = {};
  graph.forEachNode((node, attrs) => {
    const cid = communityMap[node] ?? 0;
    if (!groups[cid]) groups[cid] = [];
    groups[cid].push({ node, degree: attrs.degree });
  });

  const communities = [];
  let perspectiveId = 0;

  for (const [cid, members] of Object.entries(groups)) {
    if (members.length < MIN_COMMUNITY_SIZE) continue;

    // Sort by degree descending → most connected = most representative
    members.sort((a, b) => b.degree - a.degree);
    const topEntities = members.slice(0, TOP_ENTITIES_PER_COMMUNITY).map((m) => m.node);
    const allEntities = members.map((m) => m.node);

    // Compute centroid embedding for the community (mean of top entity vectors)
    const centroid = computeCentroid(topEntities, entities, embeddings);

    communities.push({
      id:          `perspective-${perspectiveId++}`,
      communityId: Number(cid),
      entities:    allEntities,
      topEntities,
      centroid,
    });
  }

  // Sort communities by size descending
  communities.sort((a, b) => b.entities.length - a.entities.length);
  return communities;
}

/**
 * Given a query embedding, find the best-matching community (perspective).
 *
 * @param {Float32Array} queryEmbedding
 * @param {Array<{id, centroid}>} perspectives
 * @returns {string} perspectiveId
 */
export function findClosestPerspective(queryEmbedding, perspectives) {
  let best     = null;
  let bestSim  = -Infinity;

  for (const p of perspectives) {
    if (!p.centroid) continue;
    const sim = cosineSim(queryEmbedding, p.centroid);
    if (sim > bestSim) { bestSim = sim; best = p.id; }
  }

  return best;
}

/**
 * Return all triplets that involve entities from a given community.
 *
 * @param {Array<{source, rel, target, type}>} triplets
 * @param {string[]} communityEntities
 * @returns {Array}
 */
export function filterTripletsByCommunity(triplets, communityEntities) {
  const set = new Set(communityEntities);
  return triplets.filter((t) => set.has(t.source) || set.has(t.target));
}

// ─── Internal helpers ─────────────────────────────────────────────────────────
function computeCentroid(topEntities, entityList, embeddings) {
  const dims   = embeddings[0]?.length ?? 512;
  const sum    = new Float32Array(dims);
  let count    = 0;

  for (const entity of topEntities) {
    const idx = entityList.indexOf(entity);
    if (idx < 0 || !embeddings[idx]) continue;
    const vec = embeddings[idx];
    for (let i = 0; i < dims; i++) sum[i] += vec[i];
    count++;
  }

  if (!count) return null;
  for (let i = 0; i < dims; i++) sum[i] /= count;

  // Normalise
  const norm = Math.sqrt(sum.reduce((acc, v) => acc + v * v, 0));
  for (let i = 0; i < dims; i++) sum[i] /= norm;

  return sum;
}

function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}

/** Simple connected-component fallback when Louvain fails. */
function fallbackCommunities(graph) {
  const visited = {};
  let cid       = 0;
  const result  = {};

  graph.forEachNode((node) => {
    if (visited[node] !== undefined) return;
    const stack = [node];
    while (stack.length) {
      const n = stack.pop();
      if (visited[n] !== undefined) continue;
      visited[n]  = cid;
      result[n]   = cid;
      graph.neighbors(n).forEach((nb) => { if (visited[nb] === undefined) stack.push(nb); });
    }
    cid++;
  });

  return result;
}
