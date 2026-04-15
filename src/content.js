/**
 * content.js — Injected on demand via chrome.scripting (activeTab)
 *
 * Activated when the user clicks the extension icon on a page.
 * Guards against double-injection.
 *
 *  [4] Text selection relay + Check My Notes tooltip
 *  [8] Canvas mouseup detection — sends bounding rect for Vision OCR
 */

if (window.__llmWikiInjected) {
  // Already active — relay any current selection and bail
  const sel = window.getSelection()?.toString().trim();
  if (sel && sel.length >= 10) {
    chrome.runtime.sendMessage({ type: 'TEXT_SELECTED', text: sel }).catch(() => {});
  }
} else {
  window.__llmWikiInjected = true;
  init();
}

function init() {
  let lastSelection  = '';
  let tooltip        = null;
  let tooltipTimeout = null;

  // [4] Text selection relay
  document.addEventListener('mouseup', handleMouseUp);
  document.addEventListener('keyup',   handleKeyUp);

  function handleKeyUp() {
    const text = window.getSelection()?.toString().trim() ?? '';
    if (!text || text === lastSelection || text.length < 10) return;
    lastSelection = text;
    chrome.runtime.sendMessage({ type: 'TEXT_SELECTED', text }).catch(() => {});
    showTextTooltip(window.getSelection(), text);
  }

  function handleMouseUp(e) {
    // [8] Canvas detection — check before text selection to take priority
    const canvasEl = e.target.closest?.('canvas');
    if (canvasEl) {
      showCanvasTooltip(e, canvasEl);
      return;
    }

    const text = window.getSelection()?.toString().trim() ?? '';
    if (!text || text === lastSelection || text.length < 10) return;
    lastSelection = text;
    chrome.runtime.sendMessage({ type: 'TEXT_SELECTED', text }).catch(() => {});
    showTextTooltip(window.getSelection(), text);
  }

  // Standard text selection tooltip
  function showTextTooltip(selection, text) {
    removeTooltip();
    if (!selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    const rect  = range.getBoundingClientRect();
    if (!rect.width) return;

    tooltip = buildTooltip(
      rect.bottom + 8, rect.left + rect.width / 2 - 80,
      '\u29c1 Check My Notes', '#7c6ef2',
      () => {
        removeTooltip();
        chrome.runtime.sendMessage({ type: 'TEXT_SELECTED', text }).catch(() => {});
        chrome.runtime.sendMessage({ type: 'OPEN_SIDE_PANEL' }).catch(() => {});
      }
    );
    document.body.appendChild(tooltip);
    tooltipTimeout = setTimeout(removeTooltip, 4000);
  }

  // [8] Canvas OCR tooltip — teal colour to distinguish from text tooltip
  function showCanvasTooltip(e, canvasEl) {
    removeTooltip();
    const rect = canvasEl.getBoundingClientRect();

    tooltip = buildTooltip(
      e.clientY + 12, e.clientX - 90,
      '\u29c1 Extract Text (Vision)', '#4cb8c4',
      () => {
        removeTooltip();
        const r = canvasEl.getBoundingClientRect();
        chrome.runtime.sendMessage({
          type:    'CANVAS_SELECTION',
          payload: {
            rect: { x: r.left, y: r.top, width: r.width, height: r.height,
                    devicePixelRatio: window.devicePixelRatio ?? 1 },
          },
        }).catch(() => {});
        chrome.runtime.sendMessage({ type: 'OPEN_SIDE_PANEL' }).catch(() => {});
      }
    );
    document.body.appendChild(tooltip);
    tooltipTimeout = setTimeout(removeTooltip, 5000);
  }

  function buildTooltip(top, left, label, color, onClick) {
    const wrap = document.createElement('div');
    wrap.id = '__llm-wiki-tooltip__';
    const btn = document.createElement('button');
    btn.id = '__llm-wiki-btn__';
    btn.textContent = label;
    wrap.appendChild(btn);

    Object.assign(wrap.style, {
      position: 'fixed', top: top + 'px', left: left + 'px',
      zIndex: '2147483647', background: '#1a1d27',
      border: '1px solid ' + color, borderRadius: '8px', padding: '4px',
      boxShadow: '0 4px 20px rgba(0,0,0,.5)', pointerEvents: 'auto',
    });
    Object.assign(btn.style, {
      background: color, color: '#fff', border: 'none', borderRadius: '6px',
      padding: '6px 14px', fontSize: '12px', fontWeight: '700',
      cursor: 'pointer', whiteSpace: 'nowrap', fontFamily: '-apple-system, sans-serif',
    });
    btn.addEventListener('click', (ev) => { ev.stopPropagation(); onClick(); });
    return wrap;
  }

  function removeTooltip() {
    clearTimeout(tooltipTimeout);
    tooltip?.remove();
    tooltip = null;
  }

  document.addEventListener('mousedown', (e) => {
    if (tooltip && !tooltip.contains(e.target)) removeTooltip();
  });
  document.addEventListener('scroll', removeTooltip, { passive: true });
}
