/**
 * embedder.worker.js — MediaPipe Text Embedder (Universal Sentence Encoder)
 *
 * Handles:
 *  - Lazy initialisation of the TextEmbedder via MediaPipe Tasks Text
 *  - EMBED_BATCH : Embed an array of strings, return Float32Array[]
 *
 * Model: Universal Sentence Encoder (float32, 512-dim)
 *  Bundled via MediaPipe Tasks Text WASM; the .tflite model is fetched
 *  from the MediaPipe model repository on first use (≈24 MB, cached by browser).
 *
 * NOTE: GPU delegate for text embedder may not be available on all hardware.
 *       We fall back to CPU automatically.
 */

import { FilesetResolver, TextEmbedder } from '@mediapipe/tasks-text';

// ─── Config ───────────────────────────────────────────────────────────────────
// MediaPipe-hosted USE model (cached by browser after first fetch)
const EMBEDDER_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/text_embedder/universal_sentence_encoder/float32/1/universal_sentence_encoder.tflite';

const BATCH_SIZE = 32; // Process in batches to avoid OOM

// ─── State ────────────────────────────────────────────────────────────────────
let embedder     = null;
let initialising = false;
let initPromise  = null;

// ─── Initialisation ───────────────────────────────────────────────────────────
async function initEmbedder() {
  if (embedder)    return embedder;
  if (initialising) return initPromise;

  initialising = true;
  initPromise  = (async () => {
    self.postMessage({ type: 'STATUS', status: 'initialising_embedder' });

    const wasmPath    = chrome.runtime.getURL('wasm/text');
    const textFileset = await FilesetResolver.forTextTasks(wasmPath);

    // Try GPU first, fall back to CPU
    let delegate = 'GPU';
    try {
      embedder = await TextEmbedder.createFromOptions(textFileset, {
        baseOptions: { modelAssetPath: EMBEDDER_MODEL_URL, delegate },
        quantize: false,
        l2Normalize: true,
      });
    } catch {
      delegate = 'CPU';
      embedder = await TextEmbedder.createFromOptions(textFileset, {
        baseOptions: { modelAssetPath: EMBEDDER_MODEL_URL, delegate },
        quantize: false,
        l2Normalize: true,
      });
    }

    self.postMessage({ type: 'STATUS', status: 'embedder_ready', delegate });
    initialising = false;
    return embedder;
  })();

  return initPromise;
}

// ─── Embedding helpers ────────────────────────────────────────────────────────
async function embedTexts(texts) {
  const model      = await initEmbedder();
  const results    = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    for (const text of batch) {
      const trimmed = text.slice(0, 512); // USE has a ~512-char effective window
      const result  = model.embed(trimmed);
      // result.embeddings[0].floatEmbedding is a Float32Array
      const vec = new Float32Array(result.embeddings[0].floatEmbedding);
      results.push(vec);
    }

    // Progress update
    self.postMessage({
      type:  'EMBED_PROGRESS',
      done:  Math.min(i + BATCH_SIZE, texts.length),
      total: texts.length,
    });
  }

  return results;
}

// ─── Message handler ──────────────────────────────────────────────────────────
self.onmessage = async (e) => {
  const { id, type } = e.data;

  try {
    switch (type) {
      case 'INIT': {
        await initEmbedder();
        self.postMessage({ id, type: 'INIT_OK' });
        break;
      }

      case 'EMBED_BATCH': {
        const { texts } = e.data;
        if (!Array.isArray(texts) || texts.length === 0) {
          self.postMessage({ id, result: [] });
          break;
        }

        const embeddings = await embedTexts(texts);

        // Transferable: send Float32Array buffers without copying
        const buffers = embeddings.map((v) => v.buffer);
        self.postMessage({ id, result: embeddings }, buffers);
        break;
      }

      case 'EMBED_SINGLE': {
        const { text } = e.data;
        const [vec]    = await embedTexts([text]);
        self.postMessage({ id, result: vec }, [vec.buffer]);
        break;
      }

      default:
        self.postMessage({ id, error: `Unknown message type: ${type}` });
    }
  } catch (err) {
    self.postMessage({ id, error: err.message });
  }
};
