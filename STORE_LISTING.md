# Chrome Web Store Listing — LLM Wiki

Use this file as a reference when submitting to the Chrome Web Store Developer Dashboard.

---

## Extension Name

```
LLM Wiki — Local GraphRAG Study Assistant
```

---

## Short Description (132 characters max)

```
100% local AI wiki from your files. Gemma 4 E2B on WebGPU. No cloud, no server, no data sent anywhere.
```
*(102 characters)*

---

## Full Description

```
Turn your codebase, notes, and study transcripts into an interconnected AI-generated wiki — running 100% on your device.

LLM Wiki uses Gemma 4 E2B (Google's latest edge model) via MediaPipe/LiteRT on WebGPU to run a complete GraphRAG pipeline inside your browser. No Python server. No Ollama. No cloud API key. No data ever leaves your machine.

HOW IT WORKS

1. SELECT A FOLDER — Point LLM Wiki at any directory of .md, .txt, .js, .ts, .py, .json, .html, or .yaml files.

2. RUN THE PIPELINE — Four automated phases run locally:
   - Ingest & Chunk: splits your files into overlapping text segments
   - Triplet Extraction: Gemma reads each chunk and extracts semantic entity relationships
   - Semantic Clustering: embeddings + Louvain community detection discovers topic clusters ("Perspectives")
   - Wiki Generation: writes one Markdown wiki page per Perspective to your chosen output folder

3. CROSS-REFERENCE — Open the Side Panel on any web page, highlight text, and ask the local model to cross-reference it against your indexed notes.

4. VISION PIPELINE — Click the toolbar icon on any page: Gemma analyzes the visible screenshot and extracts a chip list of named entities. Drag over any canvas element to OCR the region.

5. EXPORT — Export all wiki pages to disk as interconnected Markdown files, or generate a single "Knowledge Seed" Markdown file that encodes your entire knowledge base.

MODEL SETUP (ONE-TIME, NO SERVER REQUIRED)

After installing the extension, open Dashboard → Settings and click "Download & Install Model (~1.3 GB)". The Gemma 4 E2B model streams directly from HuggingFace into your browser's IndexedDB — no local server, no filesystem access, no extra software required.

Alternatively, if you already have the .litertlm file, use "Load from Local File" to import it directly — no internet needed at all. After loading, use "Save Model to Disk" to keep a permanent copy in any folder you choose.

Model: Gemma 4 E2B (int4 quantized · ~1.3 GB · multimodal vision)
Source: HuggingFace — litert-community/gemma-4-E2B-it-litert-lm

PRIVACY

- All AI inference runs locally via WebGPU — your documents and queries never leave your device
- No analytics, telemetry, crash reporting, or advertising SDKs
- No third-party connections except the one-time model download from HuggingFace (user-initiated)
- Full privacy policy: https://github.com/Ranjit1312/llm-wiki-chrome-extension/blob/main/PRIVACY_POLICY.md

REQUIREMENTS

- Chrome 116 or newer
- WebGPU enabled (Chrome → Settings → System → "Use hardware acceleration when available")
- GPU with WebGPU support (NVIDIA, AMD, Intel, Apple Silicon)
- ~1.5 GB free storage for the model cache
- ~4 GB available RAM during inference
```

---

## Category

**Productivity** *(Secondary: Education)*

---

## Permissions Justification

| Permission | Justification |
|---|---|
| `sidePanel` | The core UI is a Chrome Side Panel that opens alongside any web page |
| `activeTab` | Inject content script and capture screenshot only when user clicks toolbar icon |
| `scripting` | Required to call `chrome.scripting.executeScript` to inject `content.js` |
| `tabs` | Read active tab URL to prevent injection on `chrome://` internal pages |
| `storage` | Saves model URL preference and last directory name |
| `unlimitedStorage` | Cache the ~1.3 GB model and knowledge graph in IndexedDB |
| `offscreen` | Use `OffscreenCanvas` to resize/crop screenshots before LLM inference |
| `alarms` | Keep MV3 service worker alive during multi-minute GraphRAG pipeline runs |

---

## Privacy Practices Declaration

In the Privacy tab of the Developer Dashboard, select:

- **Does your extension collect or use any user data?** → No
- **Do you use any third-party libraries that collect data?** → No
- **Does your extension use remote code?** → No

---

## Single-Purpose Description

```
LLM Wiki's single purpose is to help users build and query a local AI knowledge base from their own files, running entirely on-device using the Gemma 4 E2B language model via MediaPipe/LiteRT on WebGPU.
```

---

## Pre-Submission Checklist

- [ ] `manifest.json` version field bumped
- [ ] `npm run build` completes with zero errors
- [ ] Extension loads without console errors on a fresh Chrome profile
- [ ] Quick Install downloads the model and logs "Model ready"
- [ ] Pipeline runs end-to-end on a test directory
- [ ] Side panel opens and entity chips appear on a Wikipedia page
- [ ] Canvas OCR tooltip appears when hovering a `<canvas>` element
- [ ] Save Model to Disk writes a valid `.litertlm` file
- [ ] Load from Local File stores model and triggers successful INIT
- [ ] Default Input Directory persists across browser restarts
- [ ] Export writes `.md` files to the chosen directory
- [ ] Knowledge Seed export downloads a `.md` file
- [ ] Privacy policy URL is live and accessible
- [ ] Source code repository is public

---

## Hosted Privacy Policy URL

```
https://github.com/Ranjit1312/llm-wiki-chrome-extension/blob/main/PRIVACY_POLICY.md
```

---

*This file is for developer reference only and is not included in the extension build.*
