/**
 * lib/graph-engine.js — GraphRAG graph construction + Louvain community detection
 * Fix: Namespace-weighted edges prevent graph drift across unrelated domains.
 */
import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';

const TOP_N              = 8;
const MIN_SIZE           = 3;
const NAMESPACE_BONUS    = 2.5;

export function buildGraph(triplets) {
  const graph = new Graph({ type: 'directed', multi: false });
  for (const t of triplets) {
    if (!t.source || !t.target) continue;
    const s = t.source.trim(), tg = t.target.trim();
    if (!s || !tg || s === tg) continue;
    if (!graph.hasNode(s))  graph.addNode(s,  { type: t.type ?? 'unknown', degree: 0 });
    if (!graph.hasNode(tg)) graph.addNode(tg, { type: t.type ?? 'unknown', degree: 0 });
    const bonus  = t.sourceFile ? NAMESPACE_BONUS : 0;
    const edgeKey = `${s}||${t.rel}||${tg}`;
    if (!graph.hasEdge(edgeKey)) {
      graph.addEdgeWithKey(edgeKey, s, tg, { rel: t.rel, weight: 1 + bonus, source: t.sourceFile ?? '' });
    } else {
      graph.updateEdgeAttribute(edgeKey, 'weight', (w) => (w ?? 1) + 1 + bonus);
    }
  }
  graph.forEachNode((node) => graph.setNodeAttribute(node, 'degree', graph.degree(node)));
  return graph;
}

export function detectCommunities(graph, entities, embeddings) {
  let communityMap;
  try { communityMap = louvain(graph, { resolution: 1.0, getEdgeWeight: 'weight' }); }
  catch { communityMap = fallbackCommunities(graph); }

  const groups = {};
  graph.forEachNode((node, attrs) => {
    const cid = communityMap[node] ?? 0;
    if (!groups[cid]) groups[cid] = [];
    groups[cid].push({ node, degree: attrs.degree });
  });

  const communities = [];
  let pid = 0;
  for (const [, members] of Object.entries(groups)) {
    if (members.length < MIN_SIZE) continue;
    members.sort((a, b) => b.degree - a.degree);
    const topEntities = members.slice(0, TOP_N).map((m) => m.node);
    const allEntities = members.map((m) => m.node);
    const centroid    = computeCentroid(topEntities, entities, embeddings);
    communities.push({ id: `perspective-${pid++}`, entities: allEntities, topEntities, centroid });
  }
  communities.sort((a, b) => b.entities.length - a.entities.length);
  return communities;
}

export function findClosestPerspective(queryEmbedding, perspectives) {
  let best = null, bestSim = -Infinity;
  for (const p of perspectives) {
    if (!p.centroid) continue;
    const sim = cosineSim(queryEmbedding, p.centroid);
    if (sim > bestSim) { bestSim = sim; best = p.id; }
  }
  return best;
}

export function filterTripletsByCommunity(triplets, communityEntities) {
  const set = new Set(communityEntities);
  return triplets.filter((t) => set.has(t.source) || set.has(t.target));
}

function computeCentroid(topEntities, entityList, embeddings) {
  const dims = embeddings[0]?.length ?? 512;
  const sum  = new Float32Array(dims);
  let count  = 0;
  for (const entity of topEntities) {
    const idx = entityList.indexOf(entity);
    if (idx < 0 || !embeddings[idx]) continue;
    const vec = embeddings[idx];
    for (let i = 0; i < dims; i++) sum[i] += vec[i];
    count++;
  }
  if (!count) return null;
  const norm = Math.sqrt(sum.reduce((a, v) => a + v * v, 0));
  for (let i = 0; i < dims; i++) sum[i] /= (norm + 1e-9);
  return sum;
}

function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}

function fallbackCommunities(graph) {
  const visited = {}, result = {};
  let cid = 0;
  graph.forEachNode((node) => {
    if (visited[node] !== undefined) return;
    const stack = [node];
    while (stack.length) {
      const n = stack.pop();
      if (visited[n] !== undefined) continue;
      visited[n] = result[n] = cid;
      graph.neighbors(n).forEach((nb) => { if (visited[nb] === undefined) stack.push(nb); });
    }
    cid++;
  });
  return result;
}
