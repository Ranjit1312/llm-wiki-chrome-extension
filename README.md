# ⬡ LLM Wiki — Local GraphRAG Study Assistant

A fully local, privacy-first Chrome Extension that turns your codebases, notes, and transcripts into an interactive, AI-generated knowledge wiki — powered by **Gemma 4 E2B** running natively in the browser via **MediaPipe/LiteRT on WebGPU**.

> **100% edge execution. No cloud APIs. No backend servers. No local Python server. Your data never leaves your machine.**

![Chrome](https://img.shields.io/badge/Chrome-116+-4285F4?logo=googlechrome&logoColor=white)
![WebGPU](https://img.shields.io/badge/WebGPU-Required-orange)
![License](https://img.shields.io/badge/License-Apache%202.0-green)

---

## What It Does

LLM Wiki ingests your documents (code, Markdown, transcripts, notes) and builds a **GraphRAG knowledge base** entirely on your machine. You can then:

- Ask cross-reference questions answered by the local LLM
- Visualise a semantic knowledge graph of entities and relationships
- Capture entities from any web page with a single click (vision pipeline)
- OCR arbitrary canvas regions via drag-select
- Export portable wiki pages or a compressed "Knowledge Seed" for cross-device sharing

---

## Architecture

```
Chrome Extension (MV3)
├── background.js          Service worker — orchestrates all inter-component messaging
├── content.js             Injected on demand via activeTab (no <all_urls> required)
├── sidepanel/             Side Panel UI — chat, cross-reference, vision results
├── dashboard/             Full-tab dashboard — ingest, graph, export, settings
├── offscreen/             Offscreen Document — image preprocessing (resize / crop)
└── workers/
    ├── inference.worker   MediaPipe LlmInference — text generation + multimodal vision
    ├── embedder.worker    MediaPipe TextEmbedder — semantic embeddings
    └── graph.worker       Graphology — community detection + perspective clustering
```

### GraphRAG Pipeline (4 phases)

1. **Ingest & Chunk** — reads the selected directory, splits files into overlapping text chunks
2. **Triplet Extraction** — Gemma extracts semantic triples in tag format from each chunk, with a self-healing correction pass for validation
3. **Semantic Clustering** — embeddings + Louvain community detection groups entities into *perspectives* (topic clusters)
4. **Wiki Generation** — one Markdown wiki page per perspective, written to your chosen output directory

---

## Model — Gemma 4 E2B

| Property | Value |
|---|---|
| Model | Gemma 4 E2B Instruct (int4 quantized) |
| Format | LiteRT / `.litertlm` |
| Size | ~1.3 GB |
| Runtime | MediaPipe Tasks GenAI (WebAssembly + WebGPU) |
| Vision | Multimodal — native browser support via `maxNumImages: 1` |
| HuggingFace repo | `litert-community/gemma-4-E2B-it-litert-lm` |
| Direct URL | `https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it.litertlm` |

### Why No Local Server?

The extension downloads the model **directly from HuggingFace into your browser's IndexedDB** in 4 MB streaming chunks. MediaPipe/LiteRT then loads the model buffer from IndexedDB and runs inference entirely on-device via WebGPU.

There is **no local HTTP server, no Python backend, no Ollama, no LM Studio** required. Everything runs inside Chrome's sandboxed extension environment. After the one-time download, the model loads instantly from the local cache on every browser restart.

---

## Requirements

| Requirement | Details |
|---|---|
| Chrome 116+ | WebGPU + Side Panel API required |
| GPU with WebGPU | NVIDIA / AMD / Intel / Apple Silicon |
| ~4 GB free RAM | For unified GPU memory during inference |
| ~1.5 GB free storage | For the IndexedDB model cache |
| Node.js 18+ | Build step only — not needed by end users |

---

## Installation

### Option A — Load pre-built release

1. Download `llm-wiki-extension.zip` from [Releases](../../releases) and unzip it
2. Open Chrome → `chrome://extensions` → enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** → select the unzipped `dist/` folder
4. Pin the ⬡ LLM Wiki icon to your toolbar

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
# Load the dist/ folder as an unpacked extension in chrome://extensions
```

---

## Model Setup (One-Time, No Server Required)

After loading the extension, open **Dashboard → Settings**. You have three options:

### Option 1 — Quick Install (recommended)
Click **⬡ Download & Install Model (~1.3 GB)**. The model streams directly from HuggingFace into your browser's IndexedDB. No local server, no extra software, no manual steps. After the first download, the model loads instantly from cache on every restart.

### Option 2 — Load from local file
Already have the `.litertlm` file? Click **↑ Load from .litertlm File**, pick the file, and it streams straight into IndexedDB. No internet connection needed at all.

### Option 3 — Custom URL
Paste any direct `.litertlm` download URL into the **Custom Model URL** field and click **Download & Initialise Model**.

After loading, use **Save Model to Disk** to export the cached model to any folder on your computer, so you never need to re-download it.

> **WebGPU must be enabled.**
> Chrome → Settings → System → *Use hardware acceleration when available*

---

## Usage

### Ingesting Your Files

1. Dashboard → **Ingest** tab
2. Click **Select Directory** → choose a folder of `.md`, `.txt`, `.js`, `.ts`, `.py`, `.json`, `.html`, `.css`, or `.yaml` files
3. Click **Run GraphRAG Pipeline** — the 4-phase progress appears in the pipeline log

Set a **Default Input Directory** in Settings to auto-load your chosen folder on every session.

### Side Panel (Active Tab)

Click the LLM Wiki toolbar icon on any web page to:
- Open the side panel chat and cross-reference interface
- Automatically detect named entities on the current page (vision pipeline)
- Drag over any canvas element to OCR the selected region

### Exporting

Dashboard → **Export** tab:
- **Export All Perspectives** — writes one `.md` wiki file per topic cluster plus `index.md`
- **Export Knowledge Seed** — single compressed Markdown file encoding your entire knowledge base; drop it into LLM Wiki on another device to reconstruct context instantly

---

## Settings Overview

| Setting | What it does |
|---|---|
| Quick Install | One-click download of Gemma 4 E2B from HuggingFace into browser cache |
| Save Model to Disk | Export cached model from IndexedDB to any folder (streaming, no full RAM load) |
| Load from Local File | Import `.litertlm` file directly into IndexedDB, skipping any download |
| Custom Model URL | Download from any direct `.litertlm` URL |
| Default Input Directory | Persist your ingestion folder — auto-loads in Ingest tab every session |

---

## Key Technical Features

### Vision Pipeline (Multimodal Gemma 4 E2B)
- Toolbar click → `captureVisibleTab` → resize to 800px → Gemma vision → entity chip list in side panel
- Drag over canvas → `captureVisibleTab` + HiDPI-corrected crop → Gemma OCR → "✓ Use" button feeds text into cross-reference input
- Powered by `maxNumImages: 1` in `LlmInference.createFromOptions()` — native multimodal in MediaPipe Tasks GenAI

### activeTab Injection (No `<all_urls>`)
Content scripts injected on-demand via `chrome.scripting.executeScript` on toolbar click. No broad host permissions requested.

### Tag-Based Triplet Extraction
Gemma outputs triples in a tag format immune to JSON errors:
```
<e>Source Entity</e><r>relationship</r><e>Target Entity</e><t>type</t>
```

### Local-First Model Caching
`streamModelToCache()` fetches in 4 MB chunks from any HTTPS URL into IndexedDB. `streamModelToFile()` streams chunks from IndexedDB to a `FileSystemFileHandle` — never loads the full 1.3 GB into RAM. `storeModelFromFile()` reads a local `File` object and stores it in IndexedDB. `FileSystemDirectoryHandle` objects are persisted in IndexedDB (the only browser API that supports structured-clone of handles).

---

## Project Structure

```
src/
├── manifest.json
├── background.js
├── content.js
├── lib/
│   ├── db.js                  IndexedDB (chunks, triplets, embeddings, model, handles)
│   ├── chunker.js
│   ├── graph-engine.js
│   └── vector-store.js
├── workers/
│   ├── inference.worker.js
│   ├── embedder.worker.js
│   └── graph.worker.js
├── sidepanel/
├── dashboard/
└── offscreen/
```

---

## Permissions

| Permission | Reason |
|---|---|
| `sidePanel` | Render the side panel UI |
| `activeTab` | Inject content.js + capture screenshot on toolbar click only |
| `scripting` | `executeScript` for on-demand content injection |
| `tabs` | Gate injection to http/https pages only |
| `storage` | Save model URL, pipeline metadata |
| `unlimitedStorage` | Cache the ~1.3 GB model in IndexedDB |
| `offscreen` | Offscreen document for image preprocessing |
| `alarms` | Keep service worker alive during long pipeline runs |

---

## Privacy

All LLM inference, embedding, and graph computation runs locally. No data leaves your device. The only outbound network request is the one-time model download from HuggingFace, initiated explicitly by the user. See [PRIVACY_POLICY.md](./PRIVACY_POLICY.md) for the full policy.

---

## Browser Compatibility

| Browser | Status |
|---|---|
| Chrome 116+ | ✅ Fully supported |
| Edge 116+ | ⚠ Should work (Chromium-based, untested) |
| Firefox | ❌ MV3 Side Panel API not available |
| Safari | ❌ WebGPU / MediaPipe not available |

---

## Contributing

PRs welcome. Run `npm run dev` for watch mode during development.

---

## License

Apache 2.0 — see [LICENSE](./LICENSE).

Gemma 4 E2B is subject to Google's [Gemma Terms of Use](https://ai.google.dev/gemma/terms).
