# Privacy Policy — LLM Wiki Chrome Extension

**Effective date:** April 16, 2026
**Last updated:** April 16, 2026

---

## Summary

LLM Wiki is a **100% local, offline-first** Chrome Extension. It does not collect, transmit, sell, or share any personal data. All document processing, AI inference, and knowledge graph operations run entirely on your device.

---

## 1. Data We Collect

**We collect no data.** LLM Wiki does not have servers, analytics pipelines, or telemetry systems. The extension has no ability to send data to any third party operated by the developer.

---

## 2. Data Stored Locally on Your Device

LLM Wiki stores the following data **only on your device**, using Chrome's built-in storage APIs:

| Data | Storage Location | Purpose |
|---|---|---|
| Ingested document text (chunks) | IndexedDB (`unlimitedStorage`) | GraphRAG pipeline input |
| Extracted semantic triplets | IndexedDB | Knowledge graph construction |
| Text embeddings (float vectors) | IndexedDB | Semantic similarity search |
| Perspective metadata | IndexedDB | Topic cluster labels and stats |
| Gemma 4 E2B model weights | IndexedDB (`unlimitedStorage`) | Local LLM inference |
| FileSystem directory handles | IndexedDB | Default input folder persistence |
| Model URL preference | `chrome.storage.local` | User setting |
| Last ingested directory name | `chrome.storage.local` | UI convenience |
| Diagnostic log entries | `chrome.storage.local` | Local debugging only |

All of this data remains on your machine. None of it is transmitted externally.

You can clear all locally stored data at any time via **Dashboard → Settings → Clear All Indexed Data**.

---

## 3. Network Requests

LLM Wiki makes **one category** of outbound network request:

### Model Download (User-Initiated, One-Time)

When you click **Download & Install Model** in the Settings panel, the extension fetches the Gemma 4 E2B model file (~1.3 GB) from:

```
https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it.litertlm
```

This request:
- Is initiated **only by explicit user action** — never automatically
- Downloads **only the model file** — no user data is included in the request
- Happens **once** — subsequent launches load from the local IndexedDB cache
- Is subject to [HuggingFace's Privacy Policy](https://huggingface.co/privacy)

After the model is cached locally, the extension operates **fully offline**. No further network requests are made.

You can also bypass the download entirely by loading a local `.litertlm` file from your computer using **Settings → Load from Local File**.

---

## 4. Permissions Used and Why

| Chrome Permission | Why It Is Required |
|---|---|
| `sidePanel` | Render the Side Panel UI |
| `activeTab` | Inject the content script and capture a screenshot of the current tab — only when the toolbar icon is clicked |
| `scripting` | Execute `content.js` in the active tab via `executeScript` |
| `tabs` | Read the active tab URL to prevent injection on browser-internal pages |
| `storage` | Save user preferences (model URL, last directory name) |
| `unlimitedStorage` | Store the ~1.3 GB model file and the knowledge graph in IndexedDB |
| `offscreen` | Create an Offscreen Document for image preprocessing using `OffscreenCanvas` |
| `alarms` | Prevent the service worker from sleeping during long pipeline runs |

The extension does **not** request `<all_urls>`, `history`, `bookmarks`, `cookies`, `webRequest`, `identity`, or any other sensitive permissions.

---

## 5. Screenshots and Vision Features

When you click the LLM Wiki toolbar icon, the extension captures a screenshot of the currently visible tab, resizes it locally in an Offscreen Document, and passes it to the local Gemma 4 E2B model running in a Web Worker. The screenshot **never leaves your device**. It is processed in memory and discarded after inference.

When you drag-select a canvas region, the same process applies with a cropped portion of the screenshot.

---

## 6. FileSystem Access

When you use **Settings → Save Model to Disk** or **Settings → Default Input Directory**, the extension uses Chrome's File System Access API to read from or write to a folder you explicitly choose. The extension only accesses the specific folder you grant access to, and only for the stated purpose. No file paths or file contents are transmitted externally.

---

## 7. Children's Privacy

LLM Wiki is not directed at children under the age of 13 (or 16 in the EU). We do not knowingly collect any information from children.

---

## 8. Third-Party Services

The extension has no third-party analytics, advertising SDKs, crash-reporting services, or social media trackers. The only external connection is the one-time model download from HuggingFace (see Section 3).

---

## 9. Your Rights

Since we hold no personal data, there is nothing for us to delete, correct, or export on your behalf. To remove all data associated with LLM Wiki:
- Clear indexed data via **Dashboard → Settings → Clear All Indexed Data**
- Remove the extension from Chrome (this removes all stored data automatically)

---

## 10. Changes to This Policy

If this policy is updated, the **Effective date** at the top of this document will change. Material changes will be noted in the extension's release notes.

---

## 11. Contact

This is an open-source project. For questions about data handling, please open an issue in the GitHub repository.

---

*LLM Wiki is designed from the ground up to be a trust-free, server-free, privacy-preserving tool. If you ever observe any unexpected network traffic from this extension, please report it immediately via GitHub Issues.*
