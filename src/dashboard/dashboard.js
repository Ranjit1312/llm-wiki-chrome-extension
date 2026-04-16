/**
 * dashboard.js -- Full-tab dashboard controller
 */

import './dashboard.css';
import DOMPurify from 'dompurify';
import { readDirectoryHandle, chunkFiles } from '../lib/chunker.js';
import { getPerspectives, getTriplets, getChunks } from '../lib/db.js';
import {
  saveHandle, loadHandle, clearHandle,
  isModelCached, storeModelFromFile, streamModelToFile, streamModelToCache,
} from '../lib/db.js';
import { generateDiagnosticReport, clearLogs, initLogger } from '../lib/logger.js';

const GEMMA4_E2B_URL = 'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it.litertlm';
const MODEL_ID       = 'gemma4-e2b-it-gpu-int4';

// -- DOM helpers --------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const show = (el) => el?.classList.remove('hidden');
const hide = (el) => el?.classList.add('hidden');

// -- State --------------------------------------------------------------------
let dirHandle          = null;
let ingestedFiles      = [];
let exportDirHandle    = null;
let modelSaveDirHandle = null;
const PALETTE = ['#7c6ef2','#4cb8c4','#f0a030','#4caf82','#e05555','#c47dff','#ff8c69','#5bc0eb'];

// -- Initialisation -----------------------------------------------------------
document.addEventListener('DOMContentLoaded', async () => {
  await initLogger();
  checkWebGPU();
  setupNavigation();
  setupIngestView();
  setupSettingsView();
  setupDiagnostics();
  setupPipelineListener();
  await restoreDefaultInputDir();
  await loadGraphStats();
});

// -- WebGPU check -------------------------------------------------------------
function checkWebGPU() {
  if (!navigator.gpu) {
    show($('#webgpu-gate'));
    $('#btn-run-pipeline')?.setAttribute('disabled', 'true');
  }
}

// -- Navigation ---------------------------------------------------------------
function setupNavigation() {
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
      btn.classList.add('active');
      $(`#view-${view}`)?.classList.add('active');
      if (view === 'graph')  loadGraphView();
      if (view === 'export') loadExportView();
    });
  });
}

// -- Ingest view --------------------------------------------------------------
function setupIngestView() {
  const dropZone     = $('#drop-zone');
  const btnSelectDir = $('#btn-select-dir');
  const btnClearDir  = $('#btn-clear-dir');
  const btnRun       = $('#btn-run-pipeline');
  const btnClearLog  = $('#btn-clear-log');

  btnSelectDir.addEventListener('click', selectDirectory);
  btnClearDir?.addEventListener('click', clearDirectory);
  btnRun?.addEventListener('click', runPipeline);
  btnClearLog?.addEventListener('click', () => { $('#log-output').innerHTML = ''; });

  dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('over'));
  dropZone.addEventListener('drop', (e) => { e.preventDefault(); dropZone.classList.remove('over'); selectDirectory(); });
  dropZone.addEventListener('click', (e) => { if (e.target !== btnSelectDir) selectDirectory(); });
}

async function selectDirectory() {
  try {
    dirHandle = await window.showDirectoryPicker({ mode: 'read' });
    await loadDirectoryFiles();
  } catch (err) {
    if (err.name !== 'AbortError') logLine('error', 'Directory access denied: ' + err.message);
  }
}

async function loadDirectoryFiles() {
  if (!dirHandle) return;
  logLine('info', `Reading directory: ${dirHandle.name}...`);
  ingestedFiles = await readDirectoryHandle(dirHandle);
  await chrome.storage.local.set({ lastDirName: dirHandle.name });

  $('#dir-name').textContent       = dirHandle.name;
  $('#dir-file-count').textContent = `${ingestedFiles.length} files`;
  $('#file-list').innerHTML = ingestedFiles.map((f) => `<div class="file-list__item">${escHTML(f.name)}</div>`).join('');

  show($('#dir-info'));
  hide($('#drop-zone'));
  logLine('success', `Found ${ingestedFiles.length} supported files.`);
}

async function restoreDefaultInputDir() {
  try {
    const handle = await loadHandle('defaultInputDir');
    if (!handle) return;
    dirHandle = handle;
    await loadDirectoryFiles();
    logLine('info', `Restored default input folder: ${handle.name}`);
    const lbl = $('#default-input-dir-label');
    if (lbl) lbl.textContent = handle.name;
  } catch (_) {}
}

function clearDirectory() {
  dirHandle     = null;
  ingestedFiles = [];
  hide($('#dir-info'));
  show($('#drop-zone'));
  $('#log-output').innerHTML = '';
  hide($('#log-container'));
}

async function runPipeline() {
  if (!ingestedFiles.length) { logLine('error', 'No files loaded.'); return; }
  if (!navigator.gpu)        { logLine('error', 'WebGPU required.'); return; }
  const btn    = $('#btn-run-pipeline');
  btn.disabled = true;
  show($('#log-container'));
  logLine('info', '-- Starting GraphRAG pipeline --');
  await chrome.runtime.sendMessage({ type: 'PIPELINE_START', payload: { files: ingestedFiles } });
  btn.disabled = false;
}

// -- Pipeline listener --------------------------------------------------------
function setupPipelineListener() {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== 'PIPELINE_EVENT') return;
    const { event, data } = msg;
    switch (event) {
      case 'PHASE':    logLine('info', `[Phase ${data.phase}] ${data.label}`); updatePhaseTracker(data.phase); setStatusDot('working', data.label); break;
      case 'PROGRESS': updateProgressBar(data.total > 0 ? Math.round((data.done / data.total) * 100) : 0); logLine('', `  ${data.done}/${data.total} ${data.label ?? ''}`); break;
      case 'DONE':     logLine('success', `-- Pipeline complete! ${data.perspectives.length} perspectives. --`); setStatusDot('done', 'Complete'); updateProgressBar(100); loadGraphStats(); break;
      case 'ERROR':    logLine('error', 'Pipeline error: ' + data.message); setStatusDot('error', 'Error'); break;
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== 'STATUS') return;
    if (msg.status === 'downloading_model')   logLine('info', 'Downloading model...');
    if (msg.status === 'loading_model_cache') logLine('info', 'Loading model from cache...');
    if (msg.status === 'initialising_llm')    logLine('info', 'Initialising LLM (WebGPU)...');
    if (msg.status === 'ready')               logLine('success', 'Model ready.');
  });
}

function updatePhaseTracker(activePhase) {
  document.querySelectorAll('.phase-step').forEach((el) => {
    const phase = Number(el.dataset.phase);
    el.classList.remove('active', 'done');
    if (phase < activePhase)   el.classList.add('done');
    if (phase === activePhase) el.classList.add('active');
  });
}

function setStatusDot(state, label) {
  $('#pipeline-status-dot').className     = `status-dot status-dot--${state}`;
  $('#pipeline-status-label').textContent = label;
}

function updateProgressBar(pct) {
  show($('#progress-bar-wrap'));
  $('#progress-bar').style.width   = pct + '%';
  $('#progress-label').textContent = pct + '%';
}

// -- Graph view ---------------------------------------------------------------
async function loadGraphStats() {
  const [perspectives, triplets, chunks] = await Promise.all([getPerspectives(), getTriplets(), getChunks()]);
  if (!perspectives.length) return;
  const entities = new Set(triplets.flatMap((t) => [t.source, t.target]));
  $('#stat-nodes').textContent        = entities.size;
  $('#stat-edges').textContent        = triplets.length;
  $('#stat-perspectives').textContent = perspectives.length;
  $('#stat-chunks').textContent       = chunks.length;
}

async function loadGraphView() {
  const [perspectives, triplets, chunks] = await Promise.all([getPerspectives(), getTriplets(), getChunks()]);
  if (!perspectives.length) {
    show($('#graph-empty')); hide($('#graph-stats')); hide($('#perspectives-grid')); return;
  }
  hide($('#graph-empty'));
  show($('#graph-stats'));
  const entities = new Set(triplets.flatMap((t) => [t.source, t.target]));
  $('#stat-nodes').textContent        = entities.size;
  $('#stat-edges').textContent        = triplets.length;
  $('#stat-perspectives').textContent = perspectives.length;
  $('#stat-chunks').textContent       = chunks.length;
  const grid = $('#perspectives-grid');
  grid.innerHTML = '';
  perspectives.forEach((p, idx) => {
    const color = PALETTE[idx % PALETTE.length];
    const card  = document.createElement('div');
    card.className = 'perspective-card';
    card.innerHTML = `
      <div class="perspective-card__color" style="background:${color}"></div>
      <div class="perspective-card__label">${escHTML(p.label ?? p.id)}</div>
      <div class="perspective-card__meta">${p.entities?.length ?? 0} entities &middot; ${p.topEntities?.slice(0,3).map(escHTML).join(', ')}</div>
    `;
    grid.appendChild(card);
  });
  show(grid);
}

// -- Export view --------------------------------------------------------------
async function loadExportView() {
  const perspectives = await getPerspectives();
  if (!perspectives.length) { show($('#export-empty')); hide($('#export-content')); return; }
  hide($('#export-empty'));
  show($('#export-content'));

  $('#export-perspective-list').innerHTML = perspectives.map((p) => `
    <div class="export-item">
      <input type="checkbox" id="exp-${p.id}" data-id="${escHTML(p.id)}" checked />
      <label class="export-item__label" for="exp-${p.id}">${escHTML(p.label ?? p.id)}</label>
      <span class="export-item__count">${p.entities?.length ?? 0} entities</span>
    </div>
  `).join('');

  $('#btn-export-all').addEventListener('click', exportSelectedWikis);
  $('#btn-export-select-dir').addEventListener('click', async () => {
    try {
      exportDirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
      show($('#export-output-dir'));
      $('#export-dir-name').textContent = exportDirHandle.name;
    } catch (_) {}
  });

  show($('#export-seed-section'));
  $('#btn-export-seed').addEventListener('click', exportKnowledgeSeed);
}

async function exportKnowledgeSeed() {
  const perspectives = await getPerspectives();
  if (!perspectives.length) { logLine('error', 'No indexed data found. Run the pipeline first.'); return; }
  const btn    = $('#btn-export-seed');
  btn.disabled = true;
  show($('#log-container'));
  logLine('info', `Generating Knowledge Seed from ${perspectives.length} perspectives...`);
  try {
    const response = await chrome.runtime.sendMessage({ type: 'INFERENCE_REQUEST', payload: { type: 'GENERATE_SEED', perspectives } });
    const md   = response?.result ?? '# Knowledge Seed\n\nGeneration failed.';
    const blob = new Blob([md], { type: 'text/markdown' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `knowledge-seed-${Date.now()}.md`;
    a.click();
    URL.revokeObjectURL(url);
    logLine('success', 'Knowledge Seed exported.');
  } catch (err) {
    logLine('error', 'Seed generation failed: ' + err.message);
  } finally {
    btn.disabled = false;
  }
}

async function exportSelectedWikis() {
  if (!exportDirHandle) {
    try {
      exportDirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
      show($('#export-output-dir'));
      $('#export-dir-name').textContent = exportDirHandle.name;
    } catch { return; }
  }
  const selected     = [...document.querySelectorAll('#export-perspective-list input:checked')].map((cb) => cb.dataset.id);
  const perspectives = await getPerspectives();
  const toExport     = perspectives.filter((p) => selected.includes(p.id));
  logLine('info', `Exporting ${toExport.length} wikis...`);
  for (const perspective of toExport) {
    const response = await chrome.runtime.sendMessage({ type: 'INFERENCE_REQUEST', payload: { type: 'GENERATE_WIKI', perspective, entities: perspective.topEntities ?? [], chunks: [] } });
    const md       = response?.result ?? `# ${perspective.label}\n\nNo content generated.`;
    const filename = sanitizeFilename(perspective.label ?? perspective.id) + '.md';
    const fh       = await exportDirHandle.getFileHandle(filename, { create: true });
    const wr       = await fh.createWritable();
    await wr.write(md);
    await wr.close();
    logLine('success', `  Wrote ${filename}`);
  }
  const indexMd = `# LLM Wiki Index\n\n${toExport.map((p) => `- [${p.label ?? p.id}](./${sanitizeFilename(p.label ?? p.id)}.md)`).join('\n')}\n`;
  const idxFh   = await exportDirHandle.getFileHandle('index.md', { create: true });
  const idxWr   = await idxFh.createWritable();
  await idxWr.write(indexMd);
  await idxWr.close();
  logLine('success', 'Export complete! index.md + perspective wikis written.');
}

// -- Settings view ------------------------------------------------------------
function setupSettingsView() {
  // Pre-fill URL with saved value or the recommended HuggingFace URL
  chrome.storage.local.get('modelUrl').then(({ modelUrl }) => {
    $('#model-url-input').value = modelUrl || GEMMA4_E2B_URL;
  });

  // Restore default input dir label if a handle is saved
  loadHandle('defaultInputDir').then((handle) => {
    if (handle) $('#default-input-dir-label').textContent = handle.name;
  }).catch(() => {});

  // ── 1. Quick Install ──────────────────────────────────────────────────────
  $('#btn-quick-install').addEventListener('click', async () => {
    const btn = $('#btn-quick-install');
    btn.disabled    = true;
    btn.textContent = 'Installing…';
    await chrome.storage.local.set({ modelUrl: GEMMA4_E2B_URL });
    $('#model-url-input').value = GEMMA4_E2B_URL;
    try {
      await runModelInstall(GEMMA4_E2B_URL);
      btn.textContent = '✓ Model Installed';
    } catch (err) {
      btn.disabled    = false;
      btn.textContent = '⬡ Download & Install Model (~1.3 GB)';
    }
  });

  // ── 2a. Choose model save folder ─────────────────────────────────────────
  $('#btn-choose-model-save-dir').addEventListener('click', async () => {
    try {
      modelSaveDirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
      $('#model-save-dir-label').textContent = modelSaveDirHandle.name;
      $('#btn-save-model-to-disk').disabled  = false;
      logLine('info', `Model save folder set: ${modelSaveDirHandle.name}`);
    } catch (err) {
      if (err.name !== 'AbortError') logLine('error', 'Could not access folder: ' + err.message);
    }
  });

  // ── 2b. Save cached model from IndexedDB to chosen folder ─────────────────
  $('#btn-save-model-to-disk').addEventListener('click', async () => {
    if (!modelSaveDirHandle) { logLine('error', 'Choose a save folder first.'); return; }
    const cached = await isModelCached(MODEL_ID);
    if (!cached) { logLine('error', 'No cached model found. Download or load the model first.'); return; }

    const btn    = $('#btn-save-model-to-disk');
    btn.disabled    = true;
    btn.textContent = 'Saving...';
    show($('#log-container'));
    show($('#model-status-row'));
    logLine('info', 'Saving model to disk -- streaming from IndexedDB (no full RAM load)...');

    try {
      const filename   = 'gemma-4-E2B-it.litertlm';
      const fileHandle = await modelSaveDirHandle.getFileHandle(filename, { create: true });
      await streamModelToFile(MODEL_ID, fileHandle, (written, total) => {
        if (total > 0) {
          const pct = Math.round((written / total) * 100);
          $('#model-download-fill').style.width   = pct + '%';
          $('#model-download-label').textContent  = pct + '%';
        }
      });
      logLine('success', `Model saved to: ${modelSaveDirHandle.name}/gemma-4-E2B-it.litertlm`);
      btn.textContent = 'Saved';
    } catch (err) {
      logLine('error', 'Save failed: ' + err.message);
      btn.disabled    = false;
      btn.textContent = '&#x2193; Save Model to Disk';
    }
  });

  // ── 2c. Load model from local file into IndexedDB ─────────────────────────
  $('#btn-load-model-from-file').addEventListener('click', async () => {
    let fileHandles;
    try {
      fileHandles = await window.showOpenFilePicker({
        types: [{ description: 'LiteRT Model', accept: { 'application/octet-stream': ['.litertlm', '.bin', '.task'] } }],
        multiple: false,
      });
    } catch (err) {
      if (err.name !== 'AbortError') logLine('error', 'File picker error: ' + err.message);
      return;
    }

    const fh   = fileHandles[0];
    const file = await fh.getFile();
    const btn  = $('#btn-load-model-from-file');
    btn.disabled    = true;
    btn.textContent = 'Loading…';
    show($('#log-container'));
    show($('#model-status-row'));
    logLine('info', `Loading model from file: ${file.name} (${(file.size / 1e9).toFixed(2)} GB)`);

    try {
      await storeModelFromFile(MODEL_ID, file, (received, total) => {
        const pct = total > 0 ? Math.round((received / total) * 100) : 0;
        $('#model-download-fill').style.width   = pct + '%';
        $('#model-download-label').textContent  = pct + '%';
      });
      logLine('success', 'Cached. Compiling WebGPU shaders…');
      // Use INIT_FROM_CACHE — skip re-download, compile from IDB only
      await chrome.runtime.sendMessage({ type: 'INFERENCE_REQUEST', payload: { type: 'INIT_FROM_CACHE' } });
      logLine('success', 'Model ready. You can now run the GraphRAG pipeline.');
      btn.textContent = '✓ Model Loaded';
    } catch (err) {
      logLine('error', 'Load failed: ' + err.message);
      btn.disabled    = false;
      btn.textContent = '↑ Load from .litertlm File';
    }
  });

  // ── 3. Custom model URL ───────────────────────────────────────────────────
  $('#btn-save-model-url').addEventListener('click', async () => {
    const url = $('#model-url-input').value.trim();
    if (!url) return;
    await chrome.storage.local.set({ modelUrl: url });
    logLine('success', 'Model URL saved.');
  });

  $('#btn-init-model').addEventListener('click', async () => {
    const { modelUrl } = await chrome.storage.local.get('modelUrl');
    if (!modelUrl) { logLine('error', 'Save a model URL first.'); return; }
    show($('#model-status-row'));
    logLine('info', 'Initialising model (this may take a few minutes on first run)...');
    await chrome.runtime.sendMessage({ type: 'INFERENCE_REQUEST', payload: { type: 'INIT', modelUrl } });
  });

  // ── 4. Default input directory ────────────────────────────────────────────
  $('#btn-choose-default-input-dir').addEventListener('click', async () => {
    try {
      const handle = await window.showDirectoryPicker({ mode: 'read' });
      await saveHandle('defaultInputDir', handle);
      $('#default-input-dir-label').textContent = handle.name;
      logLine('success', `Default input folder saved: ${handle.name} -- auto-loads next session.`);
      // Also immediately use it for the current session
      dirHandle = handle;
      await loadDirectoryFiles();
    } catch (err) {
      if (err.name !== 'AbortError') logLine('error', 'Could not set default folder: ' + err.message);
    }
  });

  $('#btn-clear-default-input-dir').addEventListener('click', async () => {
    await clearHandle('defaultInputDir');
    $('#default-input-dir-label').textContent = 'No folder chosen';
    logLine('info', 'Default input folder cleared.');
  });

  // ── 5. Clear index ────────────────────────────────────────────────────────
  $('#btn-clear-index').addEventListener('click', async () => {
    if (!confirm('Clear all indexed data? This cannot be undone.')) return;
    await chrome.storage.local.remove('pipelineMeta');
    logLine('success', 'Index metadata cleared. Re-run the pipeline to re-index.');
  });
}

// -- Diagnostics --------------------------------------------------------------
function setupDiagnostics() {
  const btn = $('#btn-diagnostic-report');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const report = await generateDiagnosticReport();
    const blob   = new Blob([report], { type: 'text/plain' });
    const url    = URL.createObjectURL(blob);
    const a      = document.createElement('a');
    a.href       = url;
    a.download   = `llm-wiki-diagnostic-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  });

  const btnClear = $('#btn-clear-logs');
  if (!btnClear) return;
  btnClear.addEventListener('click', async () => {
    await clearLogs();
    logLine('success', 'Diagnostic logs cleared.');
  });
}

// -- Model install stepper ----------------------------------------------------
/**
 * Runs the full model install flow in the dashboard page context:
 *  1. Connect   — fetch starts
 *  2. Download  — streamModelToCache with live byte/speed progress
 *  3. Cache     — data fully written to IndexedDB
 *  4. Compile   — send INIT_FROM_CACHE to inference worker (WebGPU shader build)
 *  5. Ready     — model operational
 */
async function runModelInstall(fetchUrl) {
  const stepper = $('#install-stepper');
  show(stepper);

  const setStep = (id, state, subText) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.className = `install-step install-step--${state}`;
    const icon = el.querySelector('.install-step__icon');
    if (icon) {
      if (state === 'done')   icon.textContent = '✓';
      else if (state === 'error') icon.textContent = '✕';
      // keep numeric label for idle/active
    }
    const sub = el.querySelector('.install-step__sub');
    if (sub && subText !== undefined) sub.textContent = subText;
  };
  const setFill = (pct) => {
    const fill = $('#step-download-fill');
    if (fill) fill.style.width = pct + '%';
  };

  // Listen for STATUS messages relayed from inference worker via offscreen → broadcast
  let removeStatusListener = () => {};
  const statusPromise = new Promise((resolveStatus) => {
    const listener = (msg) => {
      if (msg.type !== 'PIPELINE_EVENT' || msg.event !== 'INFERENCE_STATUS') return;
      const s = msg.data?.status;
      if (s === 'loading_model_cache') setStep('step-compile', 'active', 'Loading model buffer…');
      if (s === 'initialising_llm')    setStep('step-compile', 'active', 'Compiling WebGPU shaders… (20–60 s)');
      if (s === 'ready')               resolveStatus();
    };
    chrome.runtime.onMessage.addListener(listener);
    removeStatusListener = () => chrome.runtime.onMessage.removeListener(listener);
  });

  try {
    // ── Step 1: Connect ─────────────────────────────────────────────
    setStep('step-connect', 'active', 'Connecting to HuggingFace…');
    let dlStart = Date.now();
    let lastReceived = 0;

    // ── Step 2: Download + Step 3: Cache (handled inside streamModelToCache) ─
    let stepTransitioned = false;
    await streamModelToCache(MODEL_ID, MODEL_ID, 0, fetchUrl, (received, total) => {
      if (!stepTransitioned) {
        setStep('step-connect', 'done', 'Connected');
        setStep('step-download', 'active', 'Starting…');
        setStep('step-cache', 'active', 'Writing chunks to IndexedDB…');
        stepTransitioned = true;
      }
      const pct     = total > 0 ? Math.round((received / total) * 100) : 0;
      const elapsed = (Date.now() - dlStart) / 1000;
      const speed   = elapsed > 0 ? (received - lastReceived) / elapsed : 0;
      lastReceived  = received; dlStart = Date.now();
      const mbDone  = (received / 1e6).toFixed(0);
      const mbTotal = total > 0 ? (total  / 1e6).toFixed(0) : '?';
      const mbps    = (speed  / 1e6).toFixed(1);
      setFill(pct);
      const dlSub = document.getElementById('step-download-sub');
      if (dlSub) dlSub.textContent = `${mbDone} / ${mbTotal} MB  (${mbps} MB/s)  ${pct}%`;
    });

    setStep('step-download', 'done', 'Download complete');
    setStep('step-cache',    'done', 'All chunks cached in IndexedDB');

    // ── Step 4: Compile ─────────────────────────────────────────────
    setStep('step-compile', 'active', 'Starting WebGPU compilation…');
    await chrome.runtime.sendMessage({ type: 'INFERENCE_REQUEST', payload: { type: 'INIT_FROM_CACHE' } });
    removeStatusListener();
    setStep('step-compile', 'done', 'Shaders compiled');

    // ── Step 5: Ready ───────────────────────────────────────────────
    setStep('step-ready', 'done', 'Model is operational ✓');
    logLine('success', 'Model installed and ready. You can now run the GraphRAG pipeline.');

  } catch (err) {
    removeStatusListener();
    ['step-connect','step-download','step-cache','step-compile','step-ready'].forEach((id) => {
      const el = document.getElementById(id);
      if (el?.classList.contains('install-step--active')) setStep(id, 'error', err.message);
    });
    logLine('error', 'Install failed: ' + err.message);
    throw err;
  }
}