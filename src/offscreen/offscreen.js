/**
 * offscreen.js — Pipeline orchestration inside the Offscreen Document
 *
 * Also handles vision requests ([8]):
 *  OFFSCREEN_IMAGE_DETECT — resize full screenshot + run entity detection
 *  OFFSCREEN_IMAGE_OCR    — crop screenshot to rect + run Gemma OCR
 *
 * Offscreen documents have full DOM/Canvas access, making them the right
 * place for OffscreenCanvas image preprocessing before inference.
 */

import { chunkFiles }      from '../lib/chunker.js';
import { log, initLogger } from '../lib/logger.js';

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
  const worker = new Worker(paths[name], { type: 'module' });
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
async function dataUrlToImageBitmap(dataUrl) {
  const resp = await fetch(dataUrl);
  const blob = await resp.blob();
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

// Message listener
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

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
async function runPipeline({ files, modelUrl }) {
  const inf = getWorker('inference');
  const emb = getWorker('embedder');
  const grp = getWorker('graph');

  broadcast('PHASE', { phase: 1, label: 'Chunking files...' });
  log.info(TAG, 'Phase 1: chunking', { fileCount: files.length });
  const chunks = chunkFiles(files);
  broadcast('PROGRESS', { phase: 1, total: chunks.length, done: chunks.length });

  broadcast('PHASE', { phase: 2, label: 'Extracting knowledge triplets...' });
  const allTriplets = [];
  for (let i = 0; i < chunks.length; i++) {
    try {
      const result = await workerRequest(inf, { type: 'EXTRACT_TRIPLETS', chunk: chunks[i] });
      if (Array.isArray(result)) allTriplets.push(...result);
    } catch (e) {
      log.warn(TAG, 'Triplet extraction failed', { chunk: i });
    }
    broadcast('PROGRESS', { phase: 2, total: chunks.length, done: i + 1 });
  }

  broadcast('PHASE', { phase: 3, label: 'Embedding entities...' });
  const entities   = [...new Set(allTriplets.flatMap((t) => [t.source, t.target]))];
  const embeddings = await workerRequest(emb, { type: 'EMBED_BATCH', texts: entities });

  broadcast('PHASE', { phase: 3, label: 'Detecting communities...' });
  const communities = await workerRequest(grp, {
    type: 'DETECT_COMMUNITIES', entities, embeddings, triplets: allTriplets,
  });

  broadcast('PHASE', { phase: 3, label: 'Labelling perspectives...' });
  const perspectives = [];
  for (const community of communities) {
    try {
      const label = await workerRequest(inf, { type: 'LABEL_COMMUNITY', topEntities: community.topEntities });
      perspectives.push({ ...community, label });
    } catch {
      perspectives.push({ ...community, label: community.id });
    }
  }

  broadcast('PHASE', { phase: 4, label: 'Persisting knowledge graph...' });
  await workerRequest(grp, {
    type: 'SAVE_RESULTS', chunks, triplets: allTriplets, embeddings, entities, perspectives,
  });

  await chrome.storage.local.set({
    pipelineMeta: {
      lastIndexed:  Date.now(),
      chunkCount:   chunks.length,
      tripletCount: allTriplets.length,
      perspectives: perspectives.map((p) => ({ id: p.id, label: p.label, entityCount: p.entities.length })),
    },
  });

  log.info(TAG, 'Pipeline complete', { chunks: chunks.length, triplets: allTriplets.length, perspectives: perspectives.length });
  broadcast('DONE', { perspectives });

  setTimeout(() => chrome.runtime.sendMessage({ type: 'CLOSE_OFFSCREEN' }).catch(() => {}), 1000);
}