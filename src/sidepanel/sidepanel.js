/**
 * sidepanel.js — Side panel UI
 * Fix: DOMPurify sanitization on all LLM-generated HTML before DOM injection.
 */
import './sidepanel.css';
import DOMPurify from 'dompurify';
import { getPerspectives } from '../lib/db.js';

const PURIFY_CONFIG = {
  ALLOWED_TAGS:  ['h1','h2','h3','h4','p','ul','ol','li','code','pre','blockquote','strong','em','hr','br','a'],
  ALLOWED_ATTR:  ['href'],
  ALLOW_DATA_ATTR: false,
  FORBID_TAGS:   ['script','iframe','object','embed','form','input'],
  FORBID_ATTR:   ['onerror','onload','onclick','onmouseover','style'],
};

function renderMarkdown(md) {
  return md
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm,  '<h2>$1</h2>')
    .replace(/^# (.+)$/gm,   '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g,     '<em>$1</em>')
    .replace(/`([^`]+)`/g,     '<code>$1</code>')
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) =>
      `<pre><code class="language-${lang}">${escapeHTML(code.trim())}</code></pre>`)
    .replace(/^> (.+)$/gm,    '<blockquote>$1</blockquote>')
    .replace(/^\s*[-*] (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>[\s\S]+?<\/li>)/g, '<ul>$1</ul>')
    .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
    .replace(/^---$/gm,       '<hr />')
    .replace(/\n\n(?!<[hup])/g, '</p><p>')
    .replace(/^(?!<[hup])/, '<p>') + '</p>';
}

function escapeHTML(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

const PALETTE = ['#7c6ef2','#4cb8c4','#f0a030','#4caf82','#e05555','#c47dff','#ff8c69','#5bc0eb'];
const $ = (sel) => document.querySelector(sel);

const statusBar      = $('#status-bar');
const statusText     = $('#status-text');
const statusDetail   = $('#status-detail');
const webgpuWarning  = $('#webgpu-warning');
const selectedPreview  = $('#selected-preview');
const selectedDisplay  = $('#selected-text-display');
const btnCrossRef    = $('#btn-cross-ref');
const crossRefResult = $('#cross-ref-result');
const crossRefAnswer = $('#cross-ref-answer');
const crossRefSources = $('#cross-ref-sources');
const btnResultClose = $('#btn-result-close');
const perspectivesEmpty = $('#perspectives-empty');
const perspectivesNav   = $('#perspectives-nav');
const wikiViewer     = $('#wiki-viewer');
const wikiTitle      = $('#wiki-title');
const wikiContent    = $('#wiki-content');
const wikiLoading    = $('#wiki-loading');
const btnWikiBack    = $('#btn-wiki-back');
const btnWikiExport  = $('#btn-wiki-export');
const btnDashboard   = $('#btn-dashboard');
const btnRefresh     = $('#btn-refresh');

let currentSelection    = '';
let currentPerspectives = [];
let currentWikiMd       = '';

document.addEventListener('DOMContentLoaded', async () => {
  if (!navigator.gpu) webgpuWarning.classList.remove('hidden');
  await loadPerspectives();
  setupListeners();
});

async function loadPerspectives() {
  try {
    currentPerspectives = await getPerspectives();
    renderPerspectives(currentPerspectives);
  } catch (err) { console.warn('[sidepanel] load perspectives:', err); }
}

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
    const btn   = document.createElement('button');
    btn.className     = 'perspective-btn';
    btn.dataset.id    = p.id;
    const color       = PALETTE[idx % PALETTE.length];
    btn.innerHTML = `
      <span class="perspective-btn__dot" style="background:${color}"></span>
      <span>${escapeHTML(p.label ?? p.id)}</span>
      <span class="perspective-btn__count">${p.entities?.length ?? 0} entities</span>`;
    btn.addEventListener('click', () => openPerspective(p, btn));
    perspectivesNav.appendChild(btn);
  });
}

async function openPerspective(perspective, btnEl) {
  document.querySelectorAll('.perspective-btn').forEach((b) => b.classList.remove('active'));
  btnEl.classList.add('active');
  wikiViewer.classList.remove('hidden');
  wikiTitle.textContent = perspective.label ?? perspective.id;
  wikiContent.innerHTML = '';
  wikiLoading.classList.remove('hidden');
  wikiViewer.scrollIntoView({ behavior: 'smooth' });
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'INFERENCE_REQUEST',
      payload: { type: 'GENERATE_WIKI', perspective, entities: perspective.topEntities ?? [], chunks: [] },
    });
    wikiLoading.classList.add('hidden');
    if (response?.result) {
      currentWikiMd         = response.result;
      // [Security] Sanitize before DOM injection
      wikiContent.innerHTML = DOMPurify.sanitize(renderMarkdown(response.result), PURIFY_CONFIG);
    } else {
      wikiContent.textContent = 'Could not generate wiki: ' + (response?.error ?? 'unknown error');
    }
  } catch (err) {
    wikiLoading.classList.add('hidden');
    wikiContent.textContent = 'Error: ' + err.message;
  }
}

function setupListeners() {
  setupVisionListeners();
  btnDashboard.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'OPEN_DASHBOARD' }));

  btnRefresh.addEventListener('click', async () => {
    setStatus('working', 'Refreshing…');
    await loadPerspectives();
    setStatus('idle', 'Ready');
  });

  btnCrossRef.addEventListener('click', handleCrossRef);
  btnResultClose.addEventListener('click', () => crossRefResult.classList.add('hidden'));

  btnWikiBack.addEventListener('click', () => {
    wikiViewer.classList.add('hidden');
    document.querySelectorAll('.perspective-btn').forEach((b) => b.classList.remove('active'));
  });

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

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== 'PIPELINE_EVENT') return;
    const { event, data } = msg;
    if (event === 'PHASE')    setStatus('working', data.label);
    if (event === 'PROGRESS') setStatus('working', data.label ?? `Phase ${data.phase}`, `${data.done}/${data.total}`);
    if (event === 'DONE')   { setStatus('done', 'Index ready'); renderPerspectives(data.perspectives); }
    if (event === 'ERROR')    setStatus('error', 'Pipeline error: ' + data.message);

    // [8] Vision events
    if (event === 'PAGE_ENTITIES') handlePageEntities(data);
    if (event === 'OCR_RESULT')    handleOcrResult(data);
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== 'TEXT_SELECTED') return;
    currentSelection            = msg.text;
    selectedDisplay.textContent = msg.text.slice(0, 80) + (msg.text.length > 80 ? '…' : '');
    selectedPreview.classList.remove('hidden');
    btnCrossRef.disabled        = false;
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
      type: 'CROSS_REF_QUERY', payload: { selectedText: currentSelection },
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

// ─── [8] Vision handlers ─────────────────────────────────────────────────────
function handlePageEntities({ entities, error }) {
  const section = $('#page-vision-section');
  const badge   = $('#page-vision-badge');
  const list    = $('#page-entities-list');
  if (!section) return;
  section.classList.remove('hidden');

  if (error) {
    badge.textContent  = 'Error';
    badge.className    = 'sp-badge sp-badge--error';
    list.textContent   = 'Vision scan failed: ' + error;
    return;
  }

  const ents = Array.isArray(entities) ? entities : [];
  badge.textContent = ents.length ? `${ents.length} found` : 'None found';
  badge.className   = ents.length ? 'sp-badge sp-badge--done' : 'sp-badge';

  if (ents.length) {
    list.innerHTML = ents
      .map((e) => `<span class="entity-chip" title="${escapeHTML(e)}">${escapeHTML(e.slice(0, 40))}</span>`)
      .join('');
  } else {
    list.innerHTML = '<span class="entity-chip-empty">No technical entities detected.</span>';
  }
  setStatus('done', 'Page scanned');
}

function handleOcrResult({ text, error }) {
  const section = $('#page-vision-section');
  const box     = $('#ocr-result-box');
  const out     = $('#ocr-result-text');
  if (!section || !box || !out) return;
  section.classList.remove('hidden');
  box.classList.remove('hidden');

  if (error) {
    out.textContent = 'OCR failed: ' + error;
    return;
  }
  out.textContent = text ?? '';
  setStatus('done', 'Text extracted');
}

function setupVisionListeners() {
  $('#btn-vision-close')?.addEventListener('click', () => {
    $('#page-vision-section')?.classList.add('hidden');
  });

  // "Use" button: feed OCR text into cross-reference as if the user selected it
  $('#btn-ocr-use')?.addEventListener('click', () => {
    const text = $('#ocr-result-text')?.textContent?.trim();
    if (!text) return;
    currentSelection            = text;
    selectedDisplay.textContent = text.slice(0, 80) + (text.length > 80 ? '\u2026' : '');
    selectedPreview.classList.remove('hidden');
    btnCrossRef.disabled        = false;
    $('#ocr-result-box')?.classList.add('hidden');
  });

  $('#btn-ocr-close')?.addEventListener('click', () => {
    $('#ocr-result-box')?.classList.add('hidden');
  });
}

function setStatus(state, text, detail = '') {
  statusBar.className      = `status-bar status-bar--${state}`;
  statusText.textContent   = text;
  statusDetail.textContent = detail;
}
