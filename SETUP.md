# LLM Wiki — Setup Guide

## Prerequisites

| Requirement | Details |
|---|---|
| Chrome 116+ | WebGPU + Side Panel API |
| Node.js 18+ | For building the extension |
| GPU with WebGPU support | NVIDIA / AMD / Apple Silicon |
| ~4 GB free RAM | Unified GPU memory for the model |

---

## Step 1 — Install dependencies & build

```bash
cd "LLM Wiki Local Chrome Extension"
npm install
npm run build        # production build → dist/
# or
npm run dev          # watch mode for development
```

The `dist/` folder is what you load into Chrome.

---

## Step 2 — Get the Gemma 4 E2B model

The model is **not included** (it's ~1.6 GB). Download the int4 quantized LiteRT version:

1. Go to [Kaggle Models](https://www.kaggle.com/models/google/gemma/tfLite/)
2. Select: `gemma` → `tfLite` → `gemma4-2b-it-gpu-int4`
3. Download the `.bin` file
4. Host it somewhere locally accessible (e.g. `python3 -m http.server 8080` in the download folder)
   - Or use any static file server / localhost URL

> **Note:** The model URL is stored in `chrome.storage.local` and never leaves your machine.

---

## Step 3 — Load into Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `dist/` folder

---

## Step 4 — Configure the model

1. Click the **LLM Wiki** extension icon → the Dashboard opens
2. Go to **Settings**
3. Paste your local model URL (e.g. `http://localhost:8080/gemma4-2b-it-gpu-int4.bin`)
4. Click **Save**, then **Download & Initialise Model**
5. Wait for the one-time download + WebGPU initialisation (~30–60 seconds after download)

The model is cached in IndexedDB — subsequent sessions load from cache in seconds.

---

## Step 5 — Ingest your first directory

1. Open the Dashboard → **Ingest** tab
2. Click **Select Directory** and grant access to your codebase / notes folder
3. Click **Run GraphRAG Pipeline**
4. Watch the 4-phase pipeline run:
   - Phase 1: Chunks files into ~400-token segments
   - Phase 2: Extracts JSON triplets (entity → relationship → entity) per chunk
   - Phase 3: Embeds entities, runs Louvain community detection, labels clusters
   - Phase 4: Perspectives appear in the Side Panel

---

## Step 6 — Use the Side Panel

1. Click the extension icon on any webpage → Side Panel opens
2. Select text on the page → click **⬡ Cross-Reference Selection**
3. The extension searches your indexed notes and returns a contextual answer
4. Click any **Perspective** button to generate a Markdown wiki for that topic cluster

---

## Architecture quick reference

```
src/
├── manifest.json          MV3 manifest
├── background.js          Service worker + pipeline orchestrator
├── content.js             Text selection + tooltip injection
├── lib/
│   ├── db.js              IndexedDB wrapper (chunks, triplets, embeddings, perspectives)
│   ├── chunker.js         File ingestion + ~400-token chunking
│   ├── graph-engine.js    graphology graph + Louvain community detection
│   └── vector-store.js    Cosine-similarity vector search
├── workers/
│   ├── inference.worker.js   Gemma 4 E2B via @mediapipe/tasks-genai (WebGPU)
│   ├── embedder.worker.js    USE text embedder via @mediapipe/tasks-text
│   └── graph.worker.js       Graph construction + IDB persistence
├── sidepanel/
│   ├── sidepanel.html/css/js  "Check My Notes" + perspective navigation
└── dashboard/
    ├── dashboard.html/css/js  Directory ingestion, graph stats, export
```

---

## Troubleshooting

**"WebGPU not available"**
→ Chrome → Settings → System → enable "Use hardware acceleration"
→ Restart Chrome

**Model download fails**
→ Ensure the URL is CORS-accessible from the extension (localhost servers work fine)
→ Check the console in `chrome://extensions` → Inspect service worker

**JSON triplet parsing errors**
→ Normal for very short/noisy chunks — the pipeline skips malformed output gracefully

**File System Access API permission reset**
→ Expected on browser restart — re-select your directory in the Dashboard
