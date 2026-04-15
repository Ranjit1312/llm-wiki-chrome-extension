/**
 * background.js — MV3 Service Worker
 *
 * Responsibilities:
 *  - Open the side panel on extension icon click
 *  - Route messages between content scripts ↔ side panel ↔ dashboard
 *  - Spawn and manage the three Web Workers (inference, embedder, graph)
 *  - Orchestrate the four-phase GraphRAG pipeline
 */

// ─── Worker lifecycle ────────────────────────────────────────────────────────
// Service workers can't hold Worker instances across restarts; we recreate on
// demand and cache the port while the SW is alive.
let inferenceWorker = null;
let embedderWorker  = null;
let graphWorker     = null;

function getWorker(name, scriptPath) {
  const workerMap = { inference: inferenceWorker, embedder: embedderWorker, graph: graphWorker };
  if (workerMap[name] && workerMap[name].active) return workerMap[name];

  const worker = new Worker(chrome.runtime.getURL(scriptPath), { type: 'module' });
  worker.active = true;
  worker.onerror = (e) => {
    console.error(`[background] ${name} worker error:`, e);
    worker.active = false;
  };

  if (name === 'inference') inferenceWorker = worker;
  if (name === 'embedder')  embedderWorker  = worker;
  if (name === 'graph')     graphWorker     = worker;

  return worker;
}

// ─── Extension icon → open side panel ────────────────────────────────────────
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// Allow each tab to show the side panel
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

// ─── Message router ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type, payload } = message;

  switch (type) {
    // ── Dashboard → background: open dashboard tab ──
    case 'OPEN_DASHBOARD': {
      chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html') });
      sendResponse({ ok: true });
      break;
    }

    // ── Pipeline phase orchestration ──────────────────
    case 'PIPELINE_START': {
      runPipeline(payload, sender.tab?.id).catch(console.error);
      sendResponse({ ok: true, status: 'pipeline_started' });
      break;
    }

    // ── Cross-reference query from content/side-panel ──
    case 'CROSS_REF_QUERY': {
      handleCrossRef(payload, sender.tab?.id)
        .then((result) => sendResponse({ ok: true, result }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true; // keep message channel open for async
    }

    // ── Worker passthrough: inference ──────────────────
    case 'INFERENCE_REQUEST': {
      const worker = getWorker('inference', 'inference.worker.js');
      const id = crypto.randomUUID();
      const handler = (e) => {
        if (e.data.id === id) {
          sendResponse(e.data);
          worker.removeEventListener('message', handler);
        }
      };
      worker.addEventListener('message', handler);
      worker.postMessage({ ...payload, id });
      return true;
    }

    // ── Worker passthrough: embedder ───────────────────
    case 'EMBED_CHUNKS': {
      const worker = getWorker('embedder', 'embedder.worker.js');
      const id = crypto.randomUUID();
      const handler = (e) => {
        if (e.data.id === id) {
          sendResponse(e.data);
          worker.removeEventListener('message', handler);
        }
      };
      worker.addEventListener('message', handler);
      worker.postMessage({ ...payload, id });
      return true;
    }

    default:
      console.warn('[background] Unknown message type:', type);
  }
});

// ─── Pipeline orchestrator ────────────────────────────────────────────────────
async function runPipeline(payload, tabId) {
  const { files } = payload; // Array of { name, content, type }

  const broadcast = (event, data) => {
    chrome.runtime.sendMessage({ type: 'PIPELINE_EVENT', event, data }).catch(() => {});
  };

  try {
    // ── Phase 1: Chunking ─────────────────────────────
    broadcast('PHASE', { phase: 1, label: 'Chunking files…' });
    const { chunkFiles } = await import('./lib/chunker.js');
    const chunks = chunkFiles(files);
    broadcast('PROGRESS', { phase: 1, total: chunks.length, done: chunks.length });

    // ── Phase 2: Triple extraction ────────────────────
    broadcast('PHASE', { phase: 2, label: 'Extracting knowledge triplets…' });
    const infWorker = getWorker('inference', 'inference.worker.js');
    const triplets = await extractTriplets(infWorker, chunks, broadcast);

    // ── Phase 3: Embedding + clustering ───────────────
    broadcast('PHASE', { phase: 3, label: 'Clustering semantic entities…' });
    const embWorker = getWorker('embedder', 'embedder.worker.js');
    const grpWorker = getWorker('graph', 'graph.worker.js');
    const perspectives = await buildPerspectives(embWorker, grpWorker, infWorker, triplets, broadcast);

    // ── Phase 4: Persist & notify UI ──────────────────
    broadcast('PHASE', { phase: 4, label: 'Finalizing knowledge graph…' });
    await persistResults({ chunks, triplets, perspectives });
    broadcast('DONE', { perspectives });

  } catch (err) {
    console.error('[background] Pipeline error:', err);
    broadcast('ERROR', { message: err.message });
  }
}

// ─── Phase 2 helpers ──────────────────────────────────────────────────────────
function workerRequest(worker, payload) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const handler = (e) => {
      if (e.data.id !== id) return;
      worker.removeEventListener('message', handler);
      if (e.data.error) reject(new Error(e.data.error));
      else resolve(e.data.result);
    };
    worker.addEventListener('message', handler);
    worker.postMessage({ ...payload, id });
  });
}

async function extractTriplets(infWorker, chunks, broadcast) {
  const allTriplets = [];
  for (let i = 0; i < chunks.length; i++) {
    const result = await workerRequest(infWorker, {
      type: 'EXTRACT_TRIPLETS',
      chunk: chunks[i],
    });
    if (Array.isArray(result)) allTriplets.push(...result);
    broadcast('PROGRESS', { phase: 2, total: chunks.length, done: i + 1 });
  }
  return allTriplets;
}

async function buildPerspectives(embWorker, grpWorker, infWorker, triplets, broadcast) {
  // 3a: Embed all unique entity names
  const entities = [...new Set(triplets.flatMap((t) => [t.source, t.target]))];
  const embeddings = await workerRequest(embWorker, {
    type: 'EMBED_BATCH',
    texts: entities,
  });

  broadcast('PROGRESS', { phase: 3, label: 'Detecting communities…' });

  // 3b: Community detection
  const communities = await workerRequest(grpWorker, {
    type: 'DETECT_COMMUNITIES',
    entities,
    embeddings,
    triplets,
  });

  broadcast('PROGRESS', { phase: 3, label: 'Generating perspective labels…' });

  // 3c: Label each community via LLM
  const perspectives = [];
  for (const community of communities) {
    const label = await workerRequest(infWorker, {
      type: 'LABEL_COMMUNITY',
      topEntities: community.topEntities,
    });
    perspectives.push({ ...community, label });
  }

  return perspectives;
}

// ─── Phase 4: Persistence ─────────────────────────────────────────────────────
async function persistResults({ chunks, triplets, perspectives }) {
  // Use chrome.storage.local for small metadata; IndexedDB for bulk data
  // (IndexedDB writes happen inside the workers via shared lib/db.js)
  const meta = {
    lastIndexed: Date.now(),
    chunkCount: chunks.length,
    tripletCount: triplets.length,
    perspectives: perspectives.map((p) => ({ id: p.id, label: p.label, entityCount: p.entities.length })),
  };
  await chrome.storage.local.set({ pipelineMeta: meta });
}

// ─── Cross-reference handler ──────────────────────────────────────────────────
async function handleCrossRef({ selectedText }, tabId) {
  const embWorker = getWorker('embedder', 'embedder.worker.js');
  const infWorker = getWorker('inference', 'inference.worker.js');

  // Embed the selected text
  const [queryEmbedding] = await workerRequest(embWorker, {
    type: 'EMBED_BATCH',
    texts: [selectedText],
  });

  // Vector search in stored chunks
  const { searchChunks } = await import('./lib/vector-store.js');
  const hits = await searchChunks(queryEmbedding, { topK: 5 });

  if (!hits.length) return { found: false };

  // Generate a contextual answer
  const answer = await workerRequest(infWorker, {
    type: 'CROSS_REF_ANSWER',
    query: selectedText,
    context: hits.map((h) => h.text).join('\n\n---\n\n'),
  });

  return { found: true, answer, sources: hits.map((h) => h.source) };
}
