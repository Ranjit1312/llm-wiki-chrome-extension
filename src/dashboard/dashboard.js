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
import { generateDiagnosticReport, clearLogs, initLogger, logLine } from '../lib/logger.js';

const GEMMA4_E2B_URL = 'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it-web.task';
const MODEL_ID       = 'gemma4-e2b-it-gpu-int4';

// -- DOM helpers --------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const show = (el) => el?.classList.remove('hidden');
const hide = (el) => el?.classList.add('hidden');

const escHTML = (str) => String(str).replace(/[&<>'"]/g, 
  (tag) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
  }[tag])
);
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
  const btnStop = $('#btn-stop-pipeline');

  btnSelectDir.addEventListener('click', selectDirectory);
  btnClearDir?.addEventListener('click', clearDirectory);
  btnRun?.addEventListener('click', runPipeline);
  btnClearLog?.addEventListener('click', () => { $('#log-output').innerHTML = ''; });

  dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('over'));
  dropZone.addEventListener('drop', (e) => { e.preventDefault(); dropZone.classList.remove('over'); selectDirectory(); });
  dropZone.addEventListener('click', (e) => { if (e.target !== btnSelectDir) selectDirectory(); });

  
  btnStop?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_PIPELINE_STOP' });
    btnStop.disabled = true;
    btnStop.textContent = 'Stopping...';
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
  
  // Swap buttons
  const btnRun = $('#btn-run-pipeline');
  const btnStop = $('#btn-stop-pipeline');
  btnRun.style.display = 'none';
  if (btnStop) {
    btnStop.style.display = 'block';
    btnStop.disabled = false;
    btnStop.innerHTML = '&#x25a0; Stop Pipeline';
  }
  
  show($('#log-container'));

  // --- DEVELOPER MODE: Capture UI Parameters ---
  const debugModeEnabled = document.getElementById('dev-debug-mode')?.checked ?? false;
  const devTempElem = $('#dev-temp');
  
  const devConfig = {
    debugMode: debugModeEnabled,
    debugChunkCount: parseInt($('#dev-max-chunks')?.value) || 3, 
    llmParams: {
      temperature: devTempElem ? (parseFloat(devTempElem.value) || 0.1) : 0.1,
      topK: $('#dev-topk') ? (parseInt($('#dev-topk').value) || 1) : 1
    },
    prompts: {
      triplet: $('#dev-prompt') && $('#dev-prompt').value.trim() !== "" ? $('#dev-prompt').value.trim() : undefined 
    },
    mapping: {
      source: $('#map-source') ? ($('#map-source').value || 'source') : 'source',
      rel: $('#map-rel') ? ($('#map-rel').value || 'rel') : 'rel',
      target: $('#map-target') ? ($('#map-target').value || 'target') : 'target',
      type: $('#map-type') ? ($('#map-type').value || 'type') : 'type'
    }
  };

  // Show debug console only if debug mode is enabled
  const debugConsole = $('#debug-console');
  if (debugConsole && debugModeEnabled) {
    debugConsole.classList.remove('hidden');
    debugConsole.style.display = 'block';
    debugConsole.innerHTML = '<div>--- Raw LLM Output (Debug Mode) ---</div>';
  } else if (debugConsole) {
    debugConsole.style.display = 'none';
  }
  // ---------------------------------------------

  logLine('info', '-- Starting GraphRAG pipeline --');
  
  const { modelUrl } = await chrome.storage.local.get('modelUrl');
  const finalModelUrl = modelUrl || GEMMA4_E2B_URL;

  await chrome.runtime.sendMessage({ 
    type: 'PIPELINE_START', 
    payload: { files: ingestedFiles, modelUrl: finalModelUrl, devConfig } 
  });
}
// -- Pipeline listener --------------------------------------------------------
function setupPipelineListener() {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== 'PIPELINE_EVENT') return;
    const { event, data } = msg;
    switch (event) {
      case 'PHASE':    
        logLine('info', `[Phase ${data.phase}] ${data.label}`); 
        updatePhaseTracker(data.phase); 
        setStatusDot('working', data.label); 
        break;
      case 'PROGRESS': 
        updateProgressBar(data.total > 0 ? Math.round((data.done / data.total) * 100) : 0); 
        logLine('', `  ${data.done}/${data.total} ${data.label ?? ''}`); 
        break;
      case 'DONE':     
        logLine('success', `-- Pipeline complete! ${data.perspectives.length} perspectives. --`); 
        setStatusDot('done', 'Complete'); 
        updateProgressBar(100); 
        loadGraphStats(); 
        // Reset buttons
        $('#btn-run-pipeline').style.display = 'block';
        $('#btn-run-pipeline').disabled = false;
        $('#btn-stop-pipeline').style.display = 'none';
        break;
      case 'ERROR':    
        logLine('error', 'Pipeline error: ' + data.message); 
        setStatusDot('error', 'Error'); 
        // Reset buttons
        $('#btn-run-pipeline').style.display = 'block';
        $('#btn-run-pipeline').disabled = false;
        $('#btn-stop-pipeline').style.display = 'none';
        break;
      // --- DEVELOPER MODE: Display Raw LLM Output ---
      case 'DEBUG_LOG': {
        const consoleDiv = $('#debug-console');
        if (consoleDiv) {
          const logEntry = document.createElement('div');
          logEntry.style.marginBottom = "10px";
          logEntry.style.borderBottom = "1px solid #333";
          logEntry.style.paddingBottom = "10px";
          logEntry.innerText = `[Chunk ${data.chunk}]:\n${data.rawText}`;
          consoleDiv.appendChild(logEntry);
          consoleDiv.scrollTop = consoleDiv.scrollHeight;
        }
        break;
      }
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== 'STATUS') return;
    if (msg.status === 'downloading_model')   logLine('info', 'Downloading model...');
    if (msg.status === 'loading_model_cache') logLine('info', 'Loading model from cache...');
    if (msg.status === 'initialising_llm')    logLine('info', 'Initialising LLM (WebGPU)...');
    
    if (msg.status === 'gpu_info') {
      const banner = $('#gpu-info-banner');
      show(banner);
      $('#gpu-info-label').textContent = msg.data;
    }

    if (msg.status === 'ready') logLine('success', 'Model ready.');
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

class ForceGraph {
  constructor(canvas, nodes, edges, onSelect) {
    this.canvas   = canvas;
    this.ctx      = canvas.getContext('2d');
    this.nodes    = nodes;
    this.edges    = edges;
    this.onSelect = onSelect;
    this.scale    = 1;
    this.tx       = 0;
    this.ty       = 0;
    this.hovered  = null;
    this.selected = null;
    this.panning  = false;
    this.panStart = null;
    this.rafId    = null;
    this.simSteps = 0;
    this.MAX_SIM  = 300;

    // Build lookup
    this.nodeMap  = Object.fromEntries(nodes.map((n) => [n.id, n]));

    this.resize();
    this.initPositions();
    this.attachEvents();
    this.loop();

    // Close detail btn
    $('#btn-close-detail')?.addEventListener('click', () => {
      this.selected = null;
      this.onSelect(null);
      this.scheduleRender();
    });

    // Zoom controls
    $('#btn-zoom-in')?.addEventListener('click',    () => this.zoom(1.25));
    $('#btn-zoom-out')?.addEventListener('click',   () => this.zoom(0.8));
    $('#btn-zoom-reset')?.addEventListener('click', () => { this.scale = 1; this.tx = 0; this.ty = 0; this.scheduleRender(); });
  }

  resize() {
    const wrap = this.canvas.parentElement;
    this.canvas.width  = wrap.clientWidth  || 800;
    this.canvas.height = wrap.clientHeight || 500;
    this.cx = this.canvas.width  / 2;
    this.cy = this.canvas.height / 2;
  }

  initPositions() {
    // Cluster by community, then add jitter
    const communities = [...new Set(this.nodes.map((n) => n.community))];
    const cAngle = (2 * Math.PI) / Math.max(communities.length, 1);
    const cRadius = Math.min(this.cx, this.cy) * 0.45;
    const cCenters = Object.fromEntries(communities.map((c, i) => [c, {
      x: this.cx + cRadius * Math.cos(i * cAngle),
      y: this.cy + cRadius * Math.sin(i * cAngle),
    }]));
    this.nodes.forEach((n) => {
      const center = cCenters[n.community] ?? { x: this.cx, y: this.cy };
      const r = 60 + Math.random() * 60;
      const a = Math.random() * 2 * Math.PI;
      n.x  = center.x + r * Math.cos(a);
      n.y  = center.y + r * Math.sin(a);
      n.vx = 0;
      n.vy = 0;
    });
  }

  tick() {
    if (this.simSteps >= this.MAX_SIM) return;
    const alpha  = Math.max(0.02, 1 - this.simSteps / this.MAX_SIM);
    const k      = Math.sqrt((this.canvas.width * this.canvas.height) / Math.max(this.nodes.length, 1)) * 0.7;
    const nodes  = this.nodes;
    const nm     = this.nodeMap;

    // Repulsion (O(n^2) for n <= 180)
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dx = nodes[i].x - nodes[j].x || 0.01;
        const dy = nodes[i].y - nodes[j].y || 0.01;
        const d2 = dx * dx + dy * dy;
        const d  = Math.sqrt(d2) + 0.1;
        const f  = (k * k) / d * alpha;
        const nx = dx / d * f, ny = dy / d * f;
        nodes[i].vx += nx; nodes[i].vy += ny;
        nodes[j].vx -= nx; nodes[j].vy -= ny;
      }
    }

    // Attraction (spring on edges)
    for (const e of this.edges) {
      const s = nm[e.source], t = nm[e.target];
      if (!s || !t) continue;
      const dx = t.x - s.x, dy = t.y - s.y;
      const d  = Math.sqrt(dx * dx + dy * dy) + 0.1;
      const f  = (d / k) * alpha * 0.5;
      const nx = dx / d * f, ny = dy / d * f;
      s.vx += nx; s.vy += ny;
      t.vx -= nx; t.vy -= ny;
    }

    // Gravity toward center
    for (const n of nodes) {
      n.vx += (this.cx - n.x) * 0.008 * alpha;
      n.vy += (this.cy - n.y) * 0.008 * alpha;
      n.vx *= 0.75; n.vy *= 0.75;
      n.x  += n.vx;  n.y  += n.vy;
    }

    this.simSteps++;
  }

  scheduleRender() {
    if (!this.rafId) this.rafId = requestAnimationFrame(() => { this.rafId = null; this.render(); });
  }

  loop() {
    this.tick();
    this.render();
    if (this.simSteps < this.MAX_SIM) {
      this.loopId = requestAnimationFrame(() => this.loop());
    }
  }

  render() {
    const ctx  = this.ctx;
    const W    = this.canvas.width, H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.translate(this.tx + W / 2, this.ty + H / 2);
    ctx.scale(this.scale, this.scale);
    ctx.translate(-W / 2, -H / 2);

    // Edges
    const sel  = this.selected;
    const hov  = this.hovered;
    const selEdges = sel ? new Set(this.edges.filter((e) => e.source === sel.id || e.target === sel.id).flatMap((e) => [e.source, e.target])) : null;

    ctx.lineWidth = 1;
    for (const e of this.edges) {
      const s = this.nodeMap[e.source], t = this.nodeMap[e.target];
      if (!s || !t) continue;
      const highlighted = selEdges && (selEdges.has(e.source) && selEdges.has(e.target));
      ctx.strokeStyle = highlighted ? 'rgba(200,200,255,0.5)' : 'rgba(120,120,160,0.18)';
      ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(t.x, t.y); ctx.stroke();
    }

    // Nodes
    for (const n of this.nodes) {
      const r   = 4 + Math.min(Math.sqrt(n.degree) * 2.5, 18);
      const isSel = n === sel, isHov = n === hov;
      const dimmed = sel && !isSel && !(selEdges?.has(n.id));

      ctx.globalAlpha = dimmed ? 0.25 : 1;
      if (isSel || isHov) {
        ctx.shadowColor = n.color; ctx.shadowBlur = isSel ? 18 : 10;
      }
      ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, 2 * Math.PI);
      ctx.fillStyle = n.color;
      ctx.fill();
      ctx.shadowBlur = 0;

      if (isSel) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5; ctx.stroke(); }
      else if (isHov) { ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 1.5; ctx.stroke(); }

      // Labels
      if (isSel || isHov || r > 14) {
        ctx.globalAlpha = dimmed ? 0.25 : 1;
        ctx.fillStyle   = isSel ? '#fff' : 'rgba(220,220,240,0.9)';
        ctx.font        = `${isSel ? 600 : 400} ${Math.min(12, 8 + r / 5)}px system-ui,sans-serif`;
        ctx.textAlign   = 'center';
        ctx.fillText(n.label.slice(0, 24), n.x, n.y - r - 5);
      }
      ctx.globalAlpha = 1;
    }

    ctx.restore();
  }

  hitTest(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const W = this.canvas.width, H = this.canvas.height;
    const scaleX = W / rect.width, scaleY = H / rect.height;
    const cx = (clientX - rect.left) * scaleX;
    const cy = (clientY - rect.top)  * scaleY;
    // Inverse transform
    const wx = (cx - this.tx - W / 2) / this.scale + W / 2;
    const wy = (cy - this.ty - H / 2) / this.scale + H / 2;
    let closest = null, minD = 20;
    for (const n of this.nodes) {
      const r = 4 + Math.min(Math.sqrt(n.degree) * 2.5, 18);
      const d = Math.hypot(n.x - wx, n.y - wy);
      if (d < r + 6 && d < minD) { minD = d; closest = n; }
    }
    return closest;
  }

  focusNode(id) {
    const n = this.nodeMap[id];
    if (!n) return;
    this.selected = n;
    this.onSelect(n);
    // Pan to center on node
    const W = this.canvas.width, H = this.canvas.height;
    this.tx = (W / 2 - n.x) * this.scale;
    this.ty = (H / 2 - n.y) * this.scale;
    this.scheduleRender();
  }

  zoom(factor) {
    this.scale = Math.max(0.2, Math.min(5, this.scale * factor));
    this.scheduleRender();
  }

  attachEvents() {
    const c = this.canvas;
    c.addEventListener('pointermove', (e) => {
      if (this.panning) {
        this.tx += e.clientX - this.panStart.x;
        this.ty += e.clientY - this.panStart.y;
        this.panStart = { x: e.clientX, y: e.clientY };
        this.scheduleRender();
      } else {
        const hit = this.hitTest(e.clientX, e.clientY);
        if (hit !== this.hovered) {
          this.hovered = hit;
          c.style.cursor = hit ? 'pointer' : 'grab';
          this.scheduleRender();
        }
      }
    });
    c.addEventListener('pointerdown', (e) => {
      const hit = this.hitTest(e.clientX, e.clientY);
      if (hit) {
        this.selected = hit; this.onSelect(hit); this.scheduleRender();
      } else {
        this.panning  = true;
        this.panStart = { x: e.clientX, y: e.clientY };
        c.setPointerCapture(e.pointerId);
      }
    });
    c.addEventListener('pointerup',   () => { this.panning = false; });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoom(e.deltaY < 0 ? 1.1 : 0.9);
    }, { passive: false });
    const ro = new ResizeObserver(() => { this.resize(); this.scheduleRender(); });
    ro.observe(c.parentElement);
    this._ro = ro;
  }

  destroy() {
    cancelAnimationFrame(this.loopId);
    cancelAnimationFrame(this.rafId);
    this._ro?.disconnect();
  }
}

function showNodeDetail(node, triplets, perspectives, communityColors) {
  const panel = $('#graph-detail');
  if (!node) { hide(panel); return; }
  show(panel);

  $('#detail-entity-name').textContent = node.label;

  const perspective = perspectives.find((p) => p.id === node.community);
  const badge = $('#detail-community-badge');
  if (perspective) {
    badge.textContent = perspective.label ?? perspective.id;
    badge.style.background = (communityColors[node.community] ?? '#888') + '33';
    badge.style.color      = communityColors[node.community] ?? '#888';
    badge.style.border     = `1px solid ${communityColors[node.community] ?? '#888'}66`;
  } else {
    badge.textContent = 'Uncategorised';
    badge.style.cssText = '';
  }

  // Relationships
  const outgoing = triplets.filter((t) => t.source === node.id).slice(0, 15);
  const incoming = triplets.filter((t) => t.target === node.id).slice(0, 10);
  const relDiv = $('#detail-relationships');
  relDiv.innerHTML = [
    ...outgoing.map((t) => `<div class="rel-item"><span class="rel-source">${escHTML(t.source)}</span> <span class="rel-verb">${escHTML(t.rel)}</span> <span class="rel-target">${escHTML(t.target)}</span></div>`),
    ...incoming.map((t) => `<div class="rel-item"><span class="rel-source">${escHTML(t.source)}</span> <span class="rel-verb">${escHTML(t.rel)}</span> <span class="rel-target">${escHTML(t.target)}</span></div>`),
  ].join('') || '<div class="rel-item" style="color:var(--text-muted)">No relationships found</div>';

  // Connected entities
  const connected = [...new Set([...outgoing.map((t) => t.target), ...incoming.map((t) => t.source)])].filter((e) => e !== node.id).slice(0, 20);
  $('#detail-connected').innerHTML = connected.map((e) =>
    `<span class="connected-chip" data-entity="${escHTML(e)}">${escHTML(e)}</span>`
  ).join('') || '<span style="font-size:12px;color:var(--text-muted)">None</span>';

  // Chip clicks -> navigate to entity
  $('#detail-connected').querySelectorAll('.connected-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      if (window.__forceGraph) window.__forceGraph.focusNode(chip.dataset.entity);
    });
  });
}

async function loadGraphView() {
  const [perspectives, triplets] = await Promise.all([getPerspectives(), getTriplets()]);
  const graphEmpty   = $('#graph-empty');
  const graphContent = $('#graph-content');

  if (!perspectives.length && !triplets.length) {
    show(graphEmpty); hide(graphContent); return;
  }
  hide(graphEmpty); show(graphContent);

  // Stats
  const entities = new Set(triplets.flatMap((t) => [t.source, t.target]));
  $('#stat-nodes').textContent        = entities.size;
  $('#stat-edges').textContent        = triplets.length;
  $('#stat-perspectives').textContent = perspectives.length;

  // Build community color map
  const communityColors = {};
  perspectives.forEach((p, i) => { communityColors[p.id] = PALETTE[i % PALETTE.length]; });

  // Entity -> community mapping
  const entityCommunity = {};
  perspectives.forEach((p) => {
    (p.entities ?? []).forEach((e) => { entityCommunity[e] = p.id; });
  });

  // Build nodes (cap at 180 by degree)
  const degreeMap = {};
  triplets.forEach((t) => {
    degreeMap[t.source] = (degreeMap[t.source] || 0) + 1;
    degreeMap[t.target] = (degreeMap[t.target] || 0) + 1;
  });
  const allEntities = [...entities].sort((a, b) => (degreeMap[b] || 0) - (degreeMap[a] || 0)).slice(0, 180);
  const nodeSet     = new Set(allEntities);

  const nodes = allEntities.map((id) => ({
    id,
    label:     id,
    community: entityCommunity[id] ?? null,
    color:     communityColors[entityCommunity[id]] ?? '#888',
    degree:    degreeMap[id] || 1,
  }));

  const edges = triplets
    .filter((t) => nodeSet.has(t.source) && nodeSet.has(t.target) && t.source !== t.target)
    .slice(0, 600);

  // Perspective cards
  const grid = $('#perspectives-grid');
  grid.innerHTML = '';
  perspectives.forEach((p, idx) => {
    const color = PALETTE[idx % PALETTE.length];
    const card  = document.createElement('div');
    card.className = 'perspective-card';
    card.innerHTML = `
      <div class="perspective-card__color" style="background:${color}"></div>
      <div class="perspective-card__label">${escHTML(p.label ?? p.id)}</div>
      <div class="perspective-card__meta">${p.entities?.length ?? 0} entities &middot; ${(p.topEntities ?? []).slice(0, 3).map(escHTML).join(', ')}</div>`;
    grid.appendChild(card);
  });
  show(grid);

  // Legend
  const legend = $('#graph-legend');
  legend.innerHTML = perspectives.slice(0, 8).map((p, i) =>
    `<div class="legend-item"><div class="legend-dot" style="background:${PALETTE[i % PALETTE.length]}"></div><span>${escHTML((p.label ?? p.id).slice(0, 22))}</span></div>`
  ).join('');

  // Force graph
  const canvas = $('#graph-canvas');
  if (!canvas) return;
  // Destroy old instance
  if (window.__forceGraph) { window.__forceGraph.destroy(); }
  window.__forceGraph = new ForceGraph(canvas, nodes, edges, (node) => showNodeDetail(node, triplets, perspectives, communityColors));
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
  chrome.storage.local.get('modelUrl').then(({ modelUrl }) => {
    $('#model-url-input').value = modelUrl || GEMMA4_E2B_URL;
  });

  loadHandle('defaultInputDir').then((handle) => {
    if (handle) $('#default-input-dir-label').textContent = handle.name;
  }).catch(() => {});

  $('#btn-quick-install').addEventListener('click', async () => {
    const btn = $('#btn-quick-install');
    btn.disabled    = true;
    btn.textContent = 'Installing...';
    await chrome.storage.local.set({ modelUrl: GEMMA4_E2B_URL });
    $('#model-url-input').value = GEMMA4_E2B_URL;
    try {
      await runModelInstall(GEMMA4_E2B_URL);
      btn.textContent = 'Model Installed';
    } catch (err) {
      btn.disabled    = false;
      btn.textContent = 'Download & Install Model (~1.3 GB)';
    }
  });

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
      btn.textContent = 'Save Model to Disk';
    }
  });

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
    btn.textContent = 'Loading...';
    show($('#log-container'));
    show($('#model-status-row'));
    logLine('info', `Loading model from file: ${file.name} (${(file.size / 1e9).toFixed(2)} GB)`);

    try {
      await storeModelFromFile(MODEL_ID, file, (received, total) => {
        const pct = total > 0 ? Math.round((received / total) * 100) : 0;
        $('#model-download-fill').style.width   = pct + '%';
        $('#model-download-label').textContent  = pct + '%';
      });
      logLine('success', 'Cached. Compiling WebGPU shaders...');
      await chrome.runtime.sendMessage({ type: 'INFERENCE_REQUEST', payload: { type: 'INIT_FROM_CACHE' } });
      logLine('success', 'Model ready. You can now run the GraphRAG pipeline.');
      btn.textContent = 'Model Loaded';
    } catch (err) {
      logLine('error', 'Load failed: ' + err.message);
      btn.disabled    = false;
      btn.textContent = 'Load from .litertlm File';
    }
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
    logLine('info', 'Initialising model (this may take a few minutes on first run)...');
    await chrome.runtime.sendMessage({ type: 'INFERENCE_REQUEST', payload: { type: 'INIT', modelUrl } });
  });

  $('#btn-choose-default-input-dir').addEventListener('click', async () => {
    try {
      const handle = await window.showDirectoryPicker({ mode: 'read' });
      await saveHandle('defaultInputDir', handle);
      $('#default-input-dir-label').textContent = handle.name;
      logLine('success', `Default input folder saved: ${handle.name} -- auto-loads next session.`);
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
async function runModelInstall(fetchUrl) {
  const stepper = $('#install-stepper');
  show(stepper);

  const setStep = (id, state, subText) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.className = `install-step install-step--${state}`;
    const icon = el.querySelector('.install-step__icon');
    if (icon) {
      if (state === 'done')   icon.textContent = 'v';
      else if (state === 'error') icon.textContent = 'x';
    }
    const sub = el.querySelector('.install-step__sub');
    if (sub && subText !== undefined) sub.textContent = subText;
  };
  const setFill = (pct) => {
    const fill = $('#step-download-fill');
    if (fill) fill.style.width = pct + '%';
  };

  let removeStatusListener = () => {};
  const statusPromise = new Promise((resolveStatus) => {
    const listener = (msg) => {
      if (msg.type !== 'PIPELINE_EVENT' || msg.event !== 'INFERENCE_STATUS') return;
      const s = msg.data?.status;
      if (s === 'loading_model_cache') setStep('step-compile', 'active', 'Loading model buffer...');
      if (s === 'initialising_llm')    setStep('step-compile', 'active', 'Compiling WebGPU shaders... (20-60 s)');
      if (s === 'ready')               resolveStatus();
    };
    chrome.runtime.onMessage.addListener(listener);
    removeStatusListener = () => chrome.runtime.onMessage.removeListener(listener);
  });

  try {
    setStep('step-connect', 'active', 'Connecting to HuggingFace...');
    let dlStart = Date.now();
    let lastReceived = 0;

    let stepTransitioned = false;
    await streamModelToCache(MODEL_ID, MODEL_ID, 0, fetchUrl, (received, total) => {
      if (!stepTransitioned) {
        setStep('step-connect', 'done', 'Connected');
        setStep('step-download', 'active', 'Starting...');
        setStep('step-cache', 'active', 'Writing chunks to IndexedDB...');
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

    setStep('step-compile', 'active', 'Starting WebGPU compilation...');
    await chrome.runtime.sendMessage({ type: 'INFERENCE_REQUEST', payload: { type: 'INIT_FROM_CACHE' } });
    removeStatusListener();
    setStep('step-compile', 'done', 'Shaders compiled');

    setStep('step-ready', 'done', 'Model is operational');
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
