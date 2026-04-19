/**
 * offscreen.js — Pipeline orchestration inside the Offscreen Document
 *
 * Also handles vision requests ([8]):
 * OFFSCREEN_IMAGE_DETECT — resize full screenshot + run entity detection
 * OFFSCREEN_IMAGE_OCR    — crop screenshot to rect + run Gemma OCR
 *
 * Offscreen documents have full DOM/Canvas access, making them the right
 * place for OffscreenCanvas image preprocessing before inference.
 */

import { chunkFiles }      from '../lib/chunker.js';
import { log, initLogger } from '../lib/logger.js';
import { saveChunks, saveTriplets, saveEmbeddings, savePerspectives } from '../lib/db.js';

const TAG = 'offscreen';

// Worker pool
let inferenceWorker = null;
let embedderWorker  = null;
let graphWorker     = null;

function getWorker(name) {
  const workers = { inference: inferenceWorker, embedder: embedderWorker, graph: graphWorker };
  if (workers[name]) return workers[name];
  const paths = {
    inference: chrome.runtime.getURL('inference.worker.js'),
    embedder:  chrome.runtime.getURL('embedder.worker.js'),
    graph:     chrome.runtime.getURL('graph.worker.js'),
  };
  const worker = new Worker(paths[name]);
  worker.onerror = (e) => log.error(TAG, `${name} worker error`, { msg: e.message });
  if (name === 'inference') {
    inferenceWorker = worker;
    // Relay STATUS messages (download progress, compile phase) to dashboard via broadcast
    worker.addEventListener('message', (e) => {
      if (e.data?.type === 'STATUS') broadcast('INFERENCE_STATUS', e.data);
    });
  }
  if (name === 'embedder')  embedderWorker  = worker;
  if (name === 'graph')     graphWorker     = worker;
  return worker;
}

function workerRequest(worker, payload) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const handler = (e) => {
      if (e.data.id !== id) return;
      worker.removeEventListener('message', handler);
      if (e.data.error) {
        log.error(TAG, 'Worker error', { error: e.data.error.slice?.(0, 80) });
        reject(new Error(e.data.error));
      } else {
        resolve(e.data.result);
      }
    };
    worker.addEventListener('message', handler);
    worker.postMessage({ ...payload, id });
  });
}

function broadcast(event, data) {
  chrome.runtime.sendMessage({ type: 'PIPELINE_EVENT', event, data }).catch(() => {});
}

// [8] Image helpers — OffscreenCanvas is available in offscreen documents
// [8] Image helpers — Updated to bypass CSP block on fetch()
async function dataUrlToImageBitmap(dataUrl) {
  // 1. Split the data URL into metadata and base64 payload
  const parts = dataUrl.split(',');
  const mimeType = parts[0].match(/:(.*?);/)[1];
  const base64Data = parts[1];

  // 2. Decode the base64 string into raw binary data
  const binaryStr = atob(base64Data);
  const len = binaryStr.length;
  const uint8Array = new Uint8Array(len);
  
  for (let i = 0; i < len; i++) {
    uint8Array[i] = binaryStr.charCodeAt(i);
  }

  // 3. Create the Blob natively (no fetch required!)
  const blob = new Blob([uint8Array], { type: mimeType });
  return createImageBitmap(blob);
}

async function resizeImageDataUrl(dataUrl, maxWidth) {
  const bmp    = await dataUrlToImageBitmap(dataUrl);
  const scale  = Math.min(1, maxWidth / bmp.width);
  const w      = Math.round(bmp.width  * scale);
  const h      = Math.round(bmp.height * scale);
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.70 });
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
}

async function cropImageDataUrl(dataUrl, rect) {
  const bmp    = await dataUrlToImageBitmap(dataUrl);
  const dpr    = rect.devicePixelRatio ?? 1;
  const x      = Math.round(rect.x      * dpr);
  const y      = Math.round(rect.y      * dpr);
  const w      = Math.max(1, Math.round(rect.width  * dpr));
  const h      = Math.max(1, Math.round(rect.height * dpr));
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext('2d').drawImage(bmp, x, y, w, h, 0, 0, w, h);
  bmp.close();
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
}

let cancelRequested = false;

// Message listener
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

  // Intercept the stop signal
  if (msg.type === 'OFFSCREEN_PIPELINE_STOP') {
    cancelRequested = true;
    log.warn(TAG, 'Pipeline cancellation requested by user.');
    sendResponse({ ok: true });
    return true;
  }

  // Pipeline start
  if (msg.type === 'OFFSCREEN_PIPELINE_START') {
    initLogger().then(() => {
      log.info(TAG, 'Pipeline started', { fileCount: msg.payload.files.length });
      runPipeline(msg.payload).catch((err) => {
        log.error(TAG, 'Pipeline failed', { err: err.message });
        broadcast('ERROR', { message: err.message });
      });
    });
    sendResponse({ ok: true });
    return true;
  }

  // Text inference passthrough
  if (msg.type === 'OFFSCREEN_INFERENCE') {
    const worker = getWorker('inference');
    workerRequest(worker, msg.payload)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err)  => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  // [8] Vision: full-page entity detection
  if (msg.type === 'OFFSCREEN_IMAGE_DETECT') {
    (async () => {
      try {
        const resized  = await resizeImageDataUrl(msg.screenshotDataUrl, 800);
        const worker   = getWorker('inference');
        const entities = await workerRequest(worker, {
          type: 'DETECT_ENTITIES_FROM_IMAGE',
          imageDataUrl: resized,
        });
        broadcast('PAGE_ENTITIES', { entities: entities ?? [] });
        log.info(TAG, 'Vision entity detect done', { count: (entities ?? []).length });
        sendResponse({ ok: true, result: entities });
      } catch (err) {
        log.error(TAG, 'Vision detect failed', { err: err.message });
        broadcast('PAGE_ENTITIES', { entities: [], error: err.message });
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  // [8] Vision: canvas/region OCR
  if (msg.type === 'OFFSCREEN_IMAGE_OCR') {
    (async () => {
      try {
        const cropped = await cropImageDataUrl(msg.screenshotDataUrl, msg.rect);
        const worker  = getWorker('inference');
        const text    = await workerRequest(worker, {
          type: 'EXTRACT_TEXT_FROM_IMAGE',
          imageDataUrl: cropped,
        });
        broadcast('OCR_RESULT', { text: text ?? '' });
        log.info(TAG, 'Vision OCR done', { chars: (text ?? '').length });
        sendResponse({ ok: true, result: text });
      } catch (err) {
        log.error(TAG, 'Vision OCR failed', { err: err.message });
        broadcast('OCR_RESULT', { text: '', error: err.message });
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }
});

// Pipeline
async function runPipeline({ files, modelUrl, devConfig }) {
  cancelRequested = false; // Reset the flag on every new run

  const inf = getWorker('inference');
  const emb = getWorker('embedder');
  const grp = getWorker('graph');

  broadcast('PHASE', { phase: 1, label: 'Chunking files...' });
  log.info(TAG, 'Phase 1: chunking', { fileCount: files.length });
  
  let chunks = chunkFiles(files);

  // --- SHORT CIRCUIT: Slice chunks if Debug Mode is enabled ---
  if (devConfig?.debugMode) {
    const limit = devConfig.debugChunkCount || 3;
    chunks = chunks.slice(0, limit);
    broadcast('DEBUG_LOG', { chunk: 'SYSTEM', rawText: `DEBUG MODE: Sliced to top ${limit} chunks.` });
  }

  broadcast('PROGRESS', { phase: 1, total: chunks.length, done: chunks.length });

  broadcast('PHASE', { phase: 2, label: 'Extracting knowledge triplets...' });
  const allTriplets = [];

  try {
    const wasmPath = chrome.runtime.getURL('wasm/genai');
    // Pass llmParams to init
    await workerRequest(inf, { 
      type: 'INIT_FROM_CACHE', 
      modelUrl, 
      wasmPath,
      llmParams: devConfig?.llmParams // <-- Pass params
    });
  } catch (err) {
    throw new Error(`Failed to initialize LLM: ${err.message}`);
  }

  for (let i = 0; i < chunks.length; i++) {
    // EMERGENCY BRAKE: Check for cancellation inside the loop
    if (cancelRequested) throw new Error('Pipeline stopped by user.');

    try {
      const isDebugChunk = devConfig?.debugMode && i < (devConfig?.debugChunkCount || 3);
      
      const response = await workerRequest(inf, { 
        type: 'EXTRACT_TRIPLETS', 
        chunk: chunks[i],
        promptOverride: devConfig?.prompts?.triplet, // <-- Pass prompt
        mapping: devConfig?.mapping,                 // <-- Pass mapping
        returnRaw: isDebugChunk                      // <-- Request raw string
      });

      // Broadcast raw string back to Dashboard UI
      if (isDebugChunk) {
        // Grab a clean preview of the source code it is analyzing
        const sourceSnippet = chunks[i].text.slice(0, 100).replace(/\n/g, ' ');
        
        broadcast('DEBUG_LOG', { 
          chunk: i + 1, 
          rawText: `SOURCE TEXT:\n${sourceSnippet}...\n\nAI OUTPUT:\n${response.rawText}` 
        });
      }
      if (Array.isArray(response.data) && response.data.length > 0) {
        allTriplets.push(...response.data);
      } else {
        broadcast('ERROR', { message: `Chunk ${i + 1}: LLM returned empty/unparseable output.` });
      }

    } catch (e) {
      broadcast('ERROR', { message: `Chunk ${i + 1} extraction failed: ${e.message}` });
    }
    
    broadcast('PROGRESS', { phase: 2, total: chunks.length, done: i + 1 });
  }

  // EMERGENCY BRAKE: Check for cancellation before subsequent phases
  if (cancelRequested) throw new Error('Pipeline stopped by user.');
  
  broadcast('PHASE', { phase: 3, label: 'Embedding entities...' });
  const entities = [...new Set(allTriplets.flatMap((t) => [t.source, t.target]))];
  const wasmPath_text = chrome.runtime.getURL('wasm/text');
  const embeddings = await workerRequest(emb, { type: 'EMBED_BATCH', wasmPath_text, texts: entities });

  if (cancelRequested) throw new Error('Pipeline stopped by user.');
  
  broadcast('PHASE', { phase: 3, label: 'Detecting communities...' });
  const communities = await workerRequest(grp, {
    type: 'DETECT_COMMUNITIES', entities, embeddings, triplets: allTriplets,
  });

  if (cancelRequested) throw new Error('Pipeline stopped by user.');

  broadcast('PHASE', { phase: 3, label: 'Labelling perspectives...' });
  const perspectives = [];
  for (const community of communities) {
    if (cancelRequested) throw new Error('Pipeline stopped by user.');
    try {
      const label = await workerRequest(inf, { type: 'LABEL_COMMUNITY', topEntities: community.topEntities });
      perspectives.push({ ...community, label });
    } catch {
      perspectives.push({ ...community, label: community.id });
    }
  }

  broadcast('PHASE', { phase: 4, label: 'Persisting knowledge graph...' });
  
  let metadata;
  try {
    // Save to IndexedDB directly
    await saveChunks(chunks);
    await saveTriplets(allTriplets);
    await saveEmbeddings(embeddings);
    await savePerspectives(perspectives);

    metadata = {
      lastIndexed:  Date.now(),
      chunkCount:   chunks.length,
      tripletCount: allTriplets.length,
      perspectives: perspectives.map((p) => ({ id: p.id, label: p.label, entityCount: p.entities?.length || 0 })),
    };
  } catch (err) {
    throw new Error(`Persistence failed: ${err.message || String(err)}`);
  }

  log.info(TAG, 'Pipeline complete', { chunks: chunks.length, triplets: allTriplets.length, perspectives: perspectives.length });
  broadcast('DONE', { perspectives, metadata });

  setTimeout(() => chrome.runtime.sendMessage({ type: 'CLOSE_OFFSCREEN' }).catch(() => {}), 1000);
}