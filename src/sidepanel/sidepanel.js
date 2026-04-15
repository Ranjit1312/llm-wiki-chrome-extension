/**
 * sidepanel.js — Side panel logic
 *
 * Responsibilities:
 *  - Listen for text selection from the content script
 *  - Trigger cross-reference queries via background
 *  - Load and render perspective buttons from IndexedDB
 *  - Render generated Markdown wikis
 *  - Listen for pipeline events (progress / done) from background
 */

import './sidepanel.css';
import { getPerspectives } from '../lib/db.js';

// ─── Markdown renderer (lightweight, no external dep) ────────────────────────
function renderMarkdown(md) {
  return md
    // Headings
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm,  '<h2>$1</h2>')
    .replace(/^# (.+)$/gm,   '<h1>$1</h1>')
    // Bold / italic
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g,     '<em>$1</em>')
    // Inline code
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // Fenced code blocks
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) =>
      `<pre><code class="language-${lang}">${escapeHTML(code.trim())}</code></pre>`,
    )
    // Blockquotes
    .replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>')
    // Unordered lists
    .replace(/^\s*[-*] (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>[\s\S]+?<\/li>)/g, '<ul>$1</ul>')
    // Ordered lists
    .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
    // Horizontal rule
    .replace(/^---$/gm, '<hr />')
    // Paragraphs (double newline → <p>)
    .replace(/\n\n(?!<[hup])/g, '</p><p>')
    .replace(/^(?!<[hup])/, '<p>')
    + '</p>';
}

function escapeHTML(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── Perspective colours (cycle through) ─────────────────────────────────────
const PALETTE = ['#7c6ef2','#4cb8c4','#f0a030','#4caf82','#e05555','#c47dff','#ff8c69','#5bc0eb'];

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);

const statusBar      = $('#status-bar');
const statusText     = $('#status-text');
const statusDetail   = $('#status-detail');
const webgpuWarning  = $('#webgpu-warning');
const selectedPreview  = $('#selected-preview');
const selectedDisplay  = $('#selected-text-display');
const btnCrossRef      = $('#btn-cross-ref');
const crossRefResult   = $('#cross-ref-result');
const crossRefAnswer   = $('#cross-ref-answer');
const crossRefSources  = $('#cross-ref-sources');
const btnResultClose   = $('#btn-result-close');
const perspectivesEmpty = $('#perspectives-empty');
const perspectivesNav  = $('#perspectives-nav');
const wikiViewer       = $('#wiki-viewer');
const wikiTitle        = $('#wiki-title');
const wikiContent      = $('#wiki-content');
const wikiLoading      = $('#wiki-loading');
const btnWikiBack      = $('#btn-wiki-back');
const btnWikiExport    = $('#btn-wiki-export');
const btnDashboard     = $('#btn-dashboard');
const btnRefresh       = $('#btn-refresh');

// ─── State ────────────────────────────────────────────────────────────────────
let currentSelection    = '';
let currentPerspectives = [];
let currentWikiMd       = '';

// ─── Initialisation ───────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  checkWebGPU();
  await loadPerspectives();
  setupListeners();
});

function checkWebGPU() {
  if (!navigator.gpu) webgpuWarning.classList.remove('hidden');
}

async function loadPerspectives() {
  try {
    currentPerspectives = await getPerspectives();
    renderPerspectives(currentPerspectives);
  } catch (err) {
    console.warn('[sidepanel] Could not load perspectives:', err);
  }
}

// ─── Perspective rendering ────────────────────────────────────────────────────
function renderPerspectives(perspectives) {
  perspectivesNav.innerHTML = '';

  if (!perspectives.length) {
    perspectivesEmpty.classList.remove('hidden');
    perspectivesNav.classList.add('hidden');
    return;
  }

  perspectivesEmpty.classList.add('hidden');
  perspectivesNav.classList.remove('hidden');

  perspectives.forEach((p, idx) => {
    const btn = document.createElement('button');
    btn.className     = 'perspective-btn';
    btn.dataset.id    = p.id;
    const color       = PALETTE[idx % PALETTE.length];

    btn.innerHTML = `
      <span class="perspective-btn__dot" style="background:${color}"></span>
      <span>${escapeHTML(p.label ?? p.id)}</span>
      <span class="perspective-btn__count">${p.entities?.length ?? 0} entities</span>
    `;

    btn.addEventListener('click', () => openPerspective(p, btn));
    perspectivesNav.appendChild(btn);
  });
}

async function openPerspective(perspective, btnEl) {
  // Highlight active button
  document.querySelectorAll('.perspective-btn').forEach((b) => b.classList.remove('active'));
  btnEl.classList.add('active');

  // Show wiki viewer
  wikiViewer.classList.remove('hidden');
  wikiTitle.textContent   = perspective.label ?? perspective.id;
  wikiContent.innerHTML   = '';
  wikiLoading.classList.remove('hidden');

  // Scroll to wiki
  wikiViewer.scrollIntoView({ behavior: 'smooth' });

  try {
    const response = await chrome.runtime.sendMessage({
      type:    'INFERENCE_REQUEST',
      type:    'INFERENCE_REQUEST',
      payload: {
        type:        'GENERATE_WIKI',
        perspective,
        entities:    perspective.topEntities ?? [],
        chunks:      [], // background fetches relevant chunks
      },
    });

    wikiLoading.classList.add('hidden');

    if (response?.result) {
      currentWikiMd           = response.result;
      wikiContent.innerHTML   = renderMarkdown(response.result);
    } else {
      wikiContent.textContent = 'Could not generate wiki: ' + (response?.error ?? 'unknown error');
    }
  } catch (err) {
    wikiLoading.classList.add('hidden');
    wikiContent.textContent = 'Error: ' + err.message;
  }
}

// ─── Event listeners ──────────────────────────────────────────────────────────
function setupListeners() {
  // Dashboard button
  btnDashboard.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'OPEN_DASHBOARD' });
  });

  // Refresh perspectives
  btnRefresh.addEventListener('click', async () => {
    setStatus('working', 'Refreshing index…');
    await loadPerspectives();
    setStatus('idle', 'Ready');
  });

  // Cross-reference
  btnCrossRef.addEventListener('click', handleCrossRef);
  btnResultClose.addEventListener('click', () => {
    crossRefResult.classList.add('hidden');
  });

  // Wiki back button
  btnWikiBack.addEventListener('click', () => {
    wikiViewer.classList.add('hidden');
    document.querySelectorAll('.perspective-btn').forEach((b) => b.classList.remove('active'));
  });

  // Wiki export
  btnWikiExport.addEventListener('click', () => {
    if (!currentWikiMd) return;
    const blob = new Blob([currentWikiMd], { type: 'text/markdown' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `${wikiTitle.textContent.replace(/\s+/g, '-')}.md`;
    a.click();
    URL.revokeObjectURL(url);
  });

  // Pipeline events from background
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== 'PIPELINE_EVENT') return;
    const { event, data } = msg;

    switch (event) {
      case 'PHASE':
        setStatus('working', data.label);
        break;
      case 'PROGRESS':
        setStatus('working', data.label ?? `Phase ${data.phase}`, `${data.done}/${data.total}`);
        break;
      case 'DONE':
        setStatus('done', 'Index ready');
        renderPerspectives(data.perspectives);
        break;
      case 'ERROR':
        setStatus('error', 'Pipeline error: ' + data.message);
        break;
    }
  });

  // Selected text from content script
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== 'TEXT_SELECTED') return;
    currentSelection                = msg.text;
    selectedDisplay.textContent     = msg.text.slice(0, 80) + (msg.text.length > 80 ? '…' : '');
    selectedPreview.classList.remove('hidden');
    btnCrossRef.disabled            = false;
    crossRefResult.classList.add('hidden');
  });
}

async function handleCrossRef() {
  if (!currentSelection) return;

  btnCrossRef.disabled = true;
  setStatus('working', 'Searching your notes…');
  crossRefResult.classList.add('hidden');

  try {
    const response = await chrome.runtime.sendMessage({
      type:    'CROSS_REF_QUERY',
      payload: { selectedText: currentSelection },
    });

    if (response?.ok && response.result?.found) {
      crossRefAnswer.textContent  = response.result.answer;
      crossRefSources.textContent = 'Sources: ' + (response.result.sources ?? []).join(', ');
      crossRefResult.classList.remove('hidden');
      setStatus('done', 'Found in notes');
    } else {
      crossRefAnswer.textContent  = 'No relevant content found in your indexed notes.';
      crossRefSources.textContent = '';
      crossRefResult.classList.remove('hidden');
      setStatus('idle', 'Ready');
    }
  } catch (err) {
    setStatus('error', 'Error: ' + err.message);
  } finally {
    btnCrossRef.disabled = false;
  }
}

// ─── Status helpers ───────────────────────────────────────────────────────────
function setStatus(state, text, detail = '') {
  statusBar.className    = `status-bar status-bar--${state}`;
  statusText.textContent = text;
  statusDetail.textContent = detail;
}
