/**
 * embedder.worker.js — MediaPipe Text Embedder
 * Fix: Adaptive frame pacing — yields between batches when thermal throttling detected.
 */
import { FilesetResolver, TextEmbedder } from '@mediapipe/tasks-text';
import { log, initLogger } from '../lib/logger.js';

const TAG              = 'embedder.worker';
const MODEL_URL        = 'https://storage.googleapis.com/mediapipe-models/text_embedder/universal_sentence_encoder/float32/1/universal_sentence_encoder.tflite';
const BATCH_SIZE       = 32;
const THROTTLE_MS      = 500;  // spike threshold per chunk
const YIELD_MS         = 50;   // rest period injected when throttled

let embedder     = null;
let initialising = false;
let initPromise  = null;

async function initEmbedder() {
  if (embedder)     return embedder;
  if (initialising) return initPromise;
  initialising = true;
  initPromise  = (async () => {
    await initLogger();
    self.postMessage({ type: 'STATUS', status: 'initialising_embedder' });
    const wasmPath    = chrome.runtime.getURL('wasm/text');
    const textFileset = await FilesetResolver.forTextTasks(wasmPath);
    let delegate = 'GPU';
    try {
      embedder = await TextEmbedder.createFromOptions(textFileset, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate }, quantize: false, l2Normalize: true,
      });
    } catch {
      delegate = 'CPU';
      embedder = await TextEmbedder.createFromOptions(textFileset, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate }, quantize: false, l2Normalize: true,
      });
    }
    log.info(TAG, 'Embedder ready', { delegate });
    self.postMessage({ type: 'STATUS', status: 'embedder_ready', delegate });
    initialising = false;
    return embedder;
  })();
  return initPromise;
}

const yield_to_os = (ms) => new Promise((r) => setTimeout(r, ms));

async function embedTexts(texts) {
  const model  = await initEmbedder();
  const results = [];
  const times   = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    for (const text of batch) {
      const t0     = performance.now();
      const result = model.embed(text.slice(0, 512));
      times.push(performance.now() - t0);
      if (times.length > 10) times.shift();
      results.push(new Float32Array(result.embeddings[0].floatEmbedding));
    }
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    if (avg > THROTTLE_MS) {
      log.warn(TAG, 'Thermal throttle — yielding', { avgMs: Math.round(avg) });
      await yield_to_os(YIELD_MS);
      self.postMessage({ type: 'STATUS', status: 'throttle_yield' });
    }
    self.postMessage({ type: 'EMBED_PROGRESS', done: Math.min(i + BATCH_SIZE, texts.length), total: texts.length });
  }
  return results;
}

self.onmessage = async (e) => {
  const { id, type } = e.data;
  try {
    switch (type) {
      case 'INIT':
        await initEmbedder();
        self.postMessage({ id, type: 'INIT_OK' });
        break;
      case 'EMBED_BATCH': {
        const { texts } = e.data;
        if (!Array.isArray(texts) || !texts.length) { self.postMessage({ id, result: [] }); break; }
        const embeddings = await embedTexts(texts);
        self.postMessage({ id, result: embeddings }, embeddings.map((v) => v.buffer));
        break;
      }
      case 'EMBED_SINGLE': {
        const [vec] = await embedTexts([e.data.text]);
        self.postMessage({ id, result: vec }, [vec.buffer]);
        break;
      }
      default:
        self.postMessage({ id, error: `Unknown type: ${type}` });
    }
  } catch (err) {
    log.error(TAG, 'Worker error', { type, err: err.message });
    self.postMessage({ id, error: err.message });
  }
};
