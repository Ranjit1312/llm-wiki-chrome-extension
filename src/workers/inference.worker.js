/**
 * inference.worker.js — Gemma 4 E2B via MediaPipe LLM Inference (LiteRT/WebGPU)
 *
 * Handles:
 *  - Model download + IndexedDB caching
 *  - EXTRACT_TRIPLETS  : JSON triplet extraction from text chunks
 *  - LABEL_COMMUNITY   : Human-readable cluster label generation
 *  - GENERATE_WIKI     : Markdown wiki page generation for a perspective
 *  - CROSS_REF_ANSWER  : Contextual answer for the "Check My Notes" feature
 *
 * Model: Gemma 4 E2B (2B params, int4 quantized)
 *  Download from: https://www.kaggle.com/models/google/gemma/tfLite/
 *  Expected file: gemma4-2b-it-gpu-int4.bin  (~1.6 GB)
 *  Place the model URL in MODEL_DOWNLOAD_URL below, or let the user supply it
 *  via the UI (stored in chrome.storage.local as 'modelUrl').
 */

import { FilesetResolver, LlmInference } from '@mediapipe/tasks-genai';
import { isModelCached, getModelBuffer, streamModelToCache } from '../lib/db.js';

// ─── Config ───────────────────────────────────────────────────────────────────
const MODEL_ID           = 'gemma4-2b-it-gpu-int4';
const MODEL_DOWNLOAD_URL = ''; // Set by user in dashboard settings
const MAX_TOKENS         = 1024;
const TEMPERATURE        = 0.1;  // Low temp for reliable JSON

// ─── State ────────────────────────────────────────────────────────────────────
let llm          = null;
let initialising = false;
let initPromise  = null;

// ─── Prompts ──────────────────────────────────────────────────────────────────
const TRIPLET_SYSTEM = `You are a knowledge graph extractor. Extract semantic relationships from text as JSON.
Output ONLY a valid JSON array. No explanation, no markdown fences, no commentary.
Schema: [{"source":"EntityName","rel":"relationship_verb","target":"EntityName","type":"category"}]
Rules:
- "source" and "target" are concise noun phrases (2-5 words max)
- "rel" is a short verb phrase describing the relationship
- "type" is one of: backend, frontend, data, algorithm, workflow, config, test, unknown
- Extract 5-15 triplets maximum
- If no clear relationships exist, return []`;

const LABEL_SYSTEM = `You are a technical topic classifier. Given a list of related software/knowledge entities, output a short 2-4 word label describing the overall topic cluster.
Output ONLY the label. No punctuation, no explanation.
Examples: "User Auth Flow", "Database Schema", "API Endpoints", "Core Algorithms", "UI Components"`;

const WIKI_SYSTEM = `You are a technical documentation writer creating a study wiki page in Markdown.
Write clearly for a developer learning this codebase/topic.
Use ## headings for major sections, ### for subsections.
Include a "## Key Entities" section listing the most important components.
Include a "## Relationships" section explaining how components interact.
If relevant, include code snippets using fenced code blocks.
End with a "## Study Questions" section with 3 questions to test understanding.
Output ONLY valid Markdown.`;

const CROSS_REF_SYSTEM = `You are a helpful study assistant. The user has highlighted text on a web page and wants to know how it relates to their personal notes.
Answer concisely (3-5 sentences). Reference specific entities from the notes context.
If the context is not relevant, say so honestly.`;

// ─── Initialisation ───────────────────────────────────────────────────────────
async function initLLM(modelUrl) {
  if (llm)          return llm;
  if (initialising) return initPromise;

  initialising = true;
  initPromise  = (async () => {
    // Check WebGPU availability
    if (!navigator.gpu) throw new Error('WebGPU not available. Enable hardware acceleration in Chrome settings.');

    // Resolve WASM fileset (local copy bundled in /wasm/genai/)
    const wasmPath = chrome.runtime.getURL('wasm/genai');
    const genaiFileset = await FilesetResolver.forGenAiTasks(wasmPath);

    // Load model: from IDB cache or download
    let modelData;
    const isCached = await isModelCached(MODEL_ID);

    if (isCached) {
      self.postMessage({ type: 'STATUS', status: 'loading_model_cache' });
      modelData = await getModelBuffer(MODEL_ID);
    } else {
      const url = modelUrl || MODEL_DOWNLOAD_URL;
      if (!url) throw new Error('No model URL provided. Set it in the Dashboard → Settings.');

      self.postMessage({ type: 'STATUS', status: 'downloading_model', url });
      await streamModelToCache(MODEL_ID, MODEL_ID, 0, url, (received, total) => {
        self.postMessage({ type: 'MODEL_DOWNLOAD_PROGRESS', received, total });
      });
      modelData = await getModelBuffer(MODEL_ID);
    }

    self.postMessage({ type: 'STATUS', status: 'initialising_llm' });

    llm = await LlmInference.createFromOptions(genaiFileset, {
      baseOptions: {
        modelAssetBuffer: new Uint8Array(modelData),
        delegate: 'GPU',
      },
      maxTokens:   MAX_TOKENS,
      temperature: TEMPERATURE,
      topK:        1,
    });

    self.postMessage({ type: 'STATUS', status: 'ready' });
    initialising = false;
    return llm;
  })();

  return initPromise;
}

// ─── Inference helpers ────────────────────────────────────────────────────────
async function generate(systemPrompt, userContent, maxNewTokens = MAX_TOKENS) {
  const model  = await initLLM();
  const prompt = `<start_of_turn>system\n${systemPrompt}<end_of_turn>\n<start_of_turn>user\n${userContent}<end_of_turn>\n<start_of_turn>model\n`;

  // Use streaming to avoid timeout on longer generations
  return new Promise((resolve, reject) => {
    let output = '';
    model.generateResponse(prompt, (partial, done) => {
      output += partial;
      if (done) resolve(output.trim());
    });
  });
}

function safeParseTriplets(raw) {
  // Strip any markdown fences the model may have added despite instructions
  const cleaned = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/,      '')
    .replace(/\s*```$/,      '')
    .trim();

  try {
    const arr = JSON.parse(cleaned);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (t) => typeof t.source === 'string' && typeof t.rel === 'string' && typeof t.target === 'string',
    );
  } catch {
    // Attempt to extract a JSON array substring (model sometimes prepends text)
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (match) {
      try { return JSON.parse(match[0]); } catch {}
    }
    return [];
  }
}

// ─── Message handler ──────────────────────────────────────────────────────────
self.onmessage = async (e) => {
  const { id, type, modelUrl } = e.data;

  try {
    switch (type) {
      // ── Explicit init (called from dashboard on model URL set) ──
      case 'INIT': {
        await initLLM(modelUrl);
        self.postMessage({ id, type: 'INIT_OK' });
        break;
      }

      // ── Phase 2: Triplet extraction ──────────────────────────────
      case 'EXTRACT_TRIPLETS': {
        const { chunk } = e.data;
        const userMsg   = `Extract relationships from the following text:\n\n${chunk.text}\n\n(Source file: ${chunk.source})`;
        const raw       = await generate(TRIPLET_SYSTEM, userMsg, 512);
        const result    = safeParseTriplets(raw);
        self.postMessage({ id, result });
        break;
      }

      // ── Phase 3c: Perspective label ──────────────────────────────
      case 'LABEL_COMMUNITY': {
        const { topEntities } = e.data;
        const userMsg         = `Entities: ${topEntities.join(', ')}`;
        const result          = await generate(LABEL_SYSTEM, userMsg, 20);
        self.postMessage({ id, result: result.slice(0, 50) }); // cap label length
        break;
      }

      // ── Phase 4: Wiki generation ──────────────────────────────────
      case 'GENERATE_WIKI': {
        const { perspective, entities, chunks } = e.data;
        const context = chunks.map((c) => c.text).join('\n\n---\n\n');
        const userMsg = [
          `## Perspective: ${perspective.label}`,
          `### Key Entities\n${entities.slice(0, 20).join(', ')}`,
          `### Source Content\n${context.slice(0, 3000)}`, // fit context window
        ].join('\n\n');

        const result = await generate(WIKI_SYSTEM, userMsg, MAX_TOKENS);
        self.postMessage({ id, result });
        break;
      }

      // ── Cross-reference answer ────────────────────────────────────
      case 'CROSS_REF_ANSWER': {
        const { query, context } = e.data;
        const userMsg = `Highlighted text: "${query}"\n\nRelevant notes context:\n${context}`;
        const result  = await generate(CROSS_REF_SYSTEM, userMsg, 300);
        self.postMessage({ id, result });
        break;
      }

      default:
        self.postMessage({ id, error: `Unknown message type: ${type}` });
    }
  } catch (err) {
    self.postMessage({ id, error: err.message });
  }
};
