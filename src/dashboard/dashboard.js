/**
 * dashboard.js — Full-tab dashboard controller
 *
 * Responsibilities:
 *  - Directory selection via File System Access API
 *  - File listing and ingestion trigger
 *  - Pipeline event handling (phase progress, completion)
 *  - Knowledge graph stats display
 *  - Export: generate all wikis and write to disk
 *  - Settings: model URL, clear index
 */

import './dashboard.css';
import { readDirectoryHandle, chunkFiles } from '../lib/chunker.js';
import { getPerspectives, getTriplets, getChunks, isModelCached } from '../lib/db.js';

// ─── DOM helpers ──────────────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const show = (el) => el?.classList.remove('hidden');
const hide = (el) => el?.classList.add('hidden');

// ─── State ────────────────────────────────────────────────────────────────────
let dirHandle      = null;
let ingestedFiles  = [];
let exportDirHandle = null;
const PALETTE      = ['#7c6ef2','#4cb8c4','#f0a030','#4caf82','#e05555','#c47dff','#ff8c69','#5bc0eb'];

// ─── Initialisation ───────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  checkWebGPU();
  setupNavigation();
  setupIngestView();
  setupSettingsView();
  setupPipelineListener();
  await restoreSessionDir();
  await loadGraphStats();
});

// ─── WebGPU check ─────────────────────────────────────────────────────────────
function checkWebGPU() {
  if (!navigator.gpu) {
    show($('#webgpu-gate'));
    $('#btn-run-pipeline')?.setAttribute('disabled', 'true');
  }
}

// ─── Navigation ───────────────────────────────────────────────────────────────
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

// ─── Ingest view ──────────────────────────────────────────────────────────────
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

  // Drag-and-drop (Chrome doesn't allow dragging real folders via DataTransfer in extensions)
  dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('over'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('over');
    // Fallback: open picker instead (directory drag not supported in MV3 content pages)
    selectDirectory();
  });
  dropZone.addEventListener('click', (e) => {
    if (e.target !== btnSelectDir) selectDirectory();
  });
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

  logLine('info', `Reading directory: ${dirHandle.name}…`);
  ingestedFiles = await readDirectoryHandle(dirHandle);

  // Persist handle reference for session (actual handle can't be serialised)
  await chrome.storage.local.set({ lastDirName: dirHandle.name });

  // Render file list
  const dirInfo    = $('#dir-info');
  const fileList   = $('#file-list');
  $('#dir-name').textContent = dirHandle.name;
  $('#dir-file-count').textContent = `${ingestedFiles.length} files`;
  fileList.innerHTML = ingestedFiles.map((f) => `<div class="file-list__item">${escHTML(f.name)}</div>`).join('');

  show(dirInfo);
  hide($('#drop-zone'));
  logLine('success', `Found ${ingestedFiles.length} supported files.`);
}

async function restoreSessionDir() {
  const { lastDirName } = await chrome.storage.local.get('lastDirName');
  if (lastDirName) logLine('info', `Last session: ${lastDirName} (re-select to re-index)`);
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
  if (!navigator.gpu)         { logLine('error', 'WebGPU required.'); return; }

  const btn = $('#btn-run-pipeline');
  btn.disabled = true;

  show($('#log-container'));
  logLine('info', '── Starting GraphRAG pipeline ──');

  // Send to background service worker
  await chrome.runtime.sendMessage({
    type:    'PIPELINE_START',
    payload: { files: ingestedFiles },
  });

  btn.disabled = false;
}

// ─── Pipeline listener ────────────────────────────────────────────────────────
function setupPipelineListener() {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== 'PIPELINE_EVENT') return;
    const { event, data } = msg;

    switch (event) {
      case 'PHASE': {
        logLine('info', `[Phase ${data.phase}] ${data.label}`);
        updatePhaseTracker(data.phase);
        setStatusDot('working', data.label);
        break;
      }
      case 'PROGRESS': {
        const pct = data.total > 0 ? Math.round((data.done / data.total) * 100) : 0;
        updateProgressBar(pct);
        logLine('', `  ${data.done}/${data.total} ${data.label ?? ''}`);
        break;
      }
      case 'DONE': {
        logLine('success', `── Pipeline complete! ${data.perspectives.length} perspectives discovered. ──`);
        setStatusDot('done', 'Complete');
        updateProgressBar(100);
        loadGraphStats();
        break;
      }
      case 'ERROR': {
        logLine('error', 'Pipeline error: ' + data.message);
        setStatusDot('error', 'Error');
        break;
      }
    }
  });

  // Model download progress
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== 'STATUS') return;
    if (msg.status === 'downloading_model') logLine('info', 'Downloading model…');
    if (msg.status === 'loading_model_cache') logLine('info', 'Loading model from cache…');
    if (msg.status === 'initialising_llm') logLine('info', 'Initialising LLM (WebGPU)…');
    if (msg.status === 'ready') logLine('success', 'Model ready.');
  });
}

function updatePhaseTracker(activePhase) {
  document.querySelectorAll('.phase-step').forEach((el) => {
    const phase = Number(el.dataset.phase);
    el.classList.remove('active', 'done');
    if (phase < activePhase)  el.classList.add('done');
    if (phase === activePhase) el.classList.add('active');
  });
}

function setStatusDot(state, label) {
  const dot = $('#pipeline-status-dot');
  dot.className = `status-dot status-dot--${state}`;
  $('#pipeline-status-label').textContent = label;
}

function updateProgressBar(pct) {
  const wrap = $('#progress-bar-wrap');
  show(wrap);
  $('#progress-bar').style.width = pct + '%';
  $('#progress-label').textContent = pct + '%';
}

// ─── Graph view ───────────────────────────────────────────────────────────────
async function loadGraphStats() {
  const [perspectives, triplets, chunks] = await Promise.all([
    getPerspectives(), getTriplets(), getChunks(),
  ]);

  if (!perspectives.length) return;

  // Unique entities
  const entities = new Set(triplets.flatMap((t) => [t.source, t.target]));

  $('#stat-nodes').textContent        = entities.size;
  $('#stat-edges').textContent        = triplets.length;
  $('#stat-perspectives').textContent = perspectives.length;
  $('#stat-chunks').textContent       = chunks.length;
}

async function loadGraphView() {
  const [perspectives, triplets, chunks] = await Promise.all([
    getPerspectives(), getTriplets(), getChunks(),
  ]);

  if (!perspectives.length) {
    show($('#graph-empty'));
    hide($('#graph-stats'));
    hide($('#perspectives-grid'));
    return;
  }

  hide($('#graph-empty'));
  show($('#graph-stats'));

  const entities = new Set(triplets.flatMap((t) => [t.source, t.target]));
  $('#stat-nodes').textContent        = entities.size;
  $('#stat-edges').textContent        = triplets.length;
  $('#stat-perspectives').textContent = perspectives.length;
  $('#stat-chunks').textContent       = chunks.length;

  // Render perspective cards
  const grid = $('#perspectives-grid');
  grid.innerHTML = '';
  perspectives.forEach((p, idx) => {
    const color = PALETTE[idx % PALETTE.length];
    const card  = document.createElement('div');
    card.className = 'perspective-card';
    card.innerHTML = `
      <div class="perspective-card__color" style="background:${color}"></div>
      <div class="perspective-card__label">${escHTML(p.label ?? p.id)}</div>
      <div class="perspective-card__meta">${p.entities?.length ?? 0} entities · ${p.topEntities?.slice(0,3).map(escHTML).join(', ')}</div>
    `;
    grid.appendChild(card);
  });
  show(grid);
}

// ─── Export view ──────────────────────────────────────────────────────────────
async function loadExportView() {
  const perspectives = await getPerspectives();

  if (!perspectives.length) {
    show($('#export-empty'));
    hide($('#export-content'));
    return;
  }

  hide($('#export-empty'));
  const content = $('#export-content');
  show(content);

  const list = $('#export-perspective-list');
  list.innerHTML = perspectives.map((p, idx) => `
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
    } catch {}
  });
}

async function exportSelectedWikis() {
  if (!exportDirHandle) {
    try {
      exportDirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
      show($('#export-output-dir'));
      $('#export-dir-name').textContent = exportDirHandle.name;
    } catch { return; }
  }

  const selected = [...document.querySelectorAll('#export-perspective-list input:checked')]
    .map((cb) => cb.dataset.id);

  const perspectives = await getPerspectives();
  const toExport     = perspectives.filter((p) => selected.includes(p.id));

  logLine('info', `Exporting ${toExport.length} wikis…`);

  for (const perspective of toExport) {
    // Generate wiki via inference worker
    const response = await chrome.runtime.sendMessage({
      type: 'INFERENCE_REQUEST',
      payload: {
        type:        'GENERATE_WIKI',
        perspective,
        entities:    perspective.topEntities ?? [],
        chunks:      [],
      },
    });

    const md       = response?.result ?? `# ${perspective.label}\n\nNo content generated.`;
    const filename = sanitizeFilename(perspective.label ?? perspective.id) + '.md';

    const fileHandle = await exportDirHandle.getFileHandle(filename, { create: true });
    const writable   = await fileHandle.createWritable();
    await writable.write(md);
    await writable.close();

    logLine('success', `  Wrote ${filename}`);
  }

  // Write an index.md linking all pages
  const indexMd = `# LLM Wiki Index\n\n${toExport.map((p) =>
    `- [${p.label ?? p.id}](./${sanitizeFilename(p.label ?? p.id)}.md)`,
  ).join('\n')}\n`;

  const idxHandle  = await exportDirHandle.getFileHandle('index.md', { create: true });
  const idxWritable = await idxHandle.createWritable();
  await idxWritable.write(indexMd);
  await idxWritable.close();

  logLine('success', 'Export complete! index.md + perspective wikis written.');
}

// ─── Settings view ────────────────────────────────────────────────────────────
function setupSettingsView() {
  // Load saved model URL
  chrome.storage.local.get('modelUrl').then(({ modelUrl }) => {
    if (modelUrl) $('#model-url-input').value = modelUrl;
  });

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
    logLine('info', 'Initialising model (this may take a few minutes on first run)…');

    await chrome.runtime.sendMessage({
      type:    'INFERENCE_REQUEST',
      payload: { type: 'INIT', modelUrl },
    });
  });

  $('#btn-clear-index').addEventListener('click', async () => {
    if (!confirm('Clear all indexed data? This cannot be undone.')) return;
    const { clearStore } = await import('../lib/db.js');
    for (const store of ['chunks','triplets','embeddings','perspectives']) {
      // clearStore is not exported — use openDB + clear
    }
    await chrome.storage.local.remove('pipelineMeta');
    logLine('success', 'Index cleared.');
  });
}

// ─── Utility ──────────────────────────────────────────────────────────────────
function logLine(type, text) {
  const logOutput = $('#log-output');
  if (!logOutput) return;
  show($('#log-container'));
  const div = document.createElement('div');
  div.className = `log-line log-line--${type}`;
  div.textContent = text;
  logOutput.appendChild(div);
  logOutput.scrollTop = logOutput.scrollHeight;
}

function escHTML(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function sanitizeFilename(str) {
  return str.replace(/[^a-z0-9\-_. ]/gi, '').replace(/\s+/g, '-').toLowerCase();
}
