# ⬡ LLM Wiki — Edge-Native GraphRAG Study Assistant

A fully local, privacy-first Chrome Extension that turns your codebases, notes, and transcripts into an interactive, AI-generated knowledge wiki — powered by **Gemma 4 E2B** running natively in the browser via **MediaPipe/LiteRT on WebGPU**.

> **100% edge execution.** No cloud APIs. No backend servers. Your data never leaves your machine.

![Chrome](https://img.shields.io/badge/Chrome-116+-4285F4?logo=googlechrome&logoColor=white)
![WebGPU](https://img.shields.io/badge/WebGPU-Required-orange)
![License](https://img.shields.io/badge/License-MIT-green)

---

## Features

- **GraphRAG Pipeline** — Extracts semantic entity triplets from your files, builds a knowledge graph, and runs Louvain community detection to discover topic clusters automatically
- **Perspective Wikis** — Generates Markdown wiki pages per topic cluster (e.g. "Auth Flow", "Database Schema", "Core Algorithms")
- **Check My Notes** — Highlight any text on a webpage and cross-reference it against your indexed notes via the Side Panel
- **Local Vector Search** — Cosine-similarity search over embedded entities, entirely in-browser
- **Export** — Write all wiki pages to disk as interconnected Markdown files

## Architecture

```
Browser Sandbox
├── Side Panel (MV3)         ← Cross-reference + perspective nav
├── Dashboard (Full Tab)     ← Ingest, graph stats, export, settings
├── Content Script           ← Text selection + "Check My Notes" tooltip
└── Web Workers
    ├── inference.worker     ← Gemma 4 E2B via @mediapipe/tasks-genai (WebGPU)
    ├── embedder.worker      ← Universal Sentence Encoder via @mediapipe/tasks-text
    └── graph.worker         ← graphology + Louvain community detection
        └── IndexedDB        ← Chunks, triplets, embeddings, perspectives, model cache
```

## Requirements

| Requirement | Details |
|---|---|
| Chrome 116+ | WebGPU + Side Panel API required |
| GPU with WebGPU | NVIDIA / AMD / Apple Silicon |
| ~4 GB free RAM | For unified GPU memory during inference |
| Node.js 18+ | Build step only — not needed by end users |

## Quick Start

### Option A — Download pre-built release (no Node required)
1. Go to [Releases](../../releases) and download `llm-wiki-extension.zip`
2. Unzip it anywhere
3. Open Chrome → `chrome://extensions` → enable **Developer mode**
4. Click **Load unpacked** → select the unzipped folder

### Option B — Build from source

**macOS / Linux:**
```bash
bash install.sh
```

**Windows (PowerShell):**
```powershell
.\install.ps1
```

**Manual:**
```bash
npm install
npm run build
# Load the dist/ folder as an unpacked extension
```

## Model Setup

The Gemma 4 E2B model is not included (≈1.6 GB). After loading the extension:

1. Open the Dashboard → **Settings**
2. Paste a direct URL to a quantized Gemma 4 E2B `.bin` file
   - Download from [Kaggle Models](https://www.kaggle.com/models/google/gemma/tfLite/) → `gemma4-2b-it-gpu-int4`
   - Serve locally: `python3 -m http.server 8080` in the download folder
3. Click **Download & Initialise Model** (one-time, cached to IndexedDB)

## Usage

1. Click the **⬡ LLM Wiki** icon → Side Panel opens
2. Go to the **Dashboard** → **Ingest** tab
3. Click **Select Directory** → grant access to your codebase or notes
4. Click **Run GraphRAG Pipeline** and watch the 4-phase process
5. Discovered **Perspectives** appear in the Side Panel
6. Highlight text on any webpage → click **⬡ Check My Notes** to cross-reference

## Project Structure

```
src/
├── manifest.json
├── background.js              Service worker + pipeline orchestrator
├── content.js                 Text selection + tooltip
├── lib/
│   ├── db.js                  IndexedDB wrapper
│   ├── chunker.js             File ingestion + ~400-token chunking
│   ├── graph-engine.js        Graph construction + Louvain clustering
│   └── vector-store.js        Cosine-similarity vector search
├── workers/
│   ├── inference.worker.js    LLM inference (triplets, labels, wikis)
│   ├── embedder.worker.js     Text embeddings
│   └── graph.worker.js        Graph build + persistence
├── sidepanel/                 Side panel UI
└── dashboard/                 Dashboard UI
```

## Contributing

PRs welcome. Run `npm run dev` for watch mode during development.

## License

MIT
