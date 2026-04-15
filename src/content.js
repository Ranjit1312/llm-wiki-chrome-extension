/**
 * content.js — Content script injected into all pages
 *
 * Responsibilities:
 *  - Detect text selections and relay them to the side panel via background
 *  - Inject a lightweight "Check My Notes" tooltip on selection
 */

// ─── Selection listener ───────────────────────────────────────────────────────
let lastSelection = '';

document.addEventListener('mouseup', handleSelectionChange);
document.addEventListener('keyup',   handleSelectionChange);

function handleSelectionChange() {
  const selection = window.getSelection();
  const text      = selection?.toString().trim() ?? '';

  if (!text || text === lastSelection || text.length < 10) return;
  lastSelection = text;

  // Relay to side panel via background
  chrome.runtime.sendMessage({ type: 'TEXT_SELECTED', text }).catch(() => {
    // Side panel may not be open — that's fine
  });

  // Show floating tooltip
  showTooltip(selection, text);
}

// ─── Floating tooltip ─────────────────────────────────────────────────────────
let tooltip = null;
let tooltipTimeout = null;

function showTooltip(selection, text) {
  removeTooltip();

  const range = selection.getRangeAt(0);
  const rect  = range.getBoundingClientRect();
  if (!rect.width) return;

  tooltip = document.createElement('div');
  tooltip.id = '__llm-wiki-tooltip__';
  tooltip.innerHTML = `
    <button id="__llm-wiki-btn__">⬡ Check My Notes</button>
  `;

  Object.assign(tooltip.style, {
    position:        'fixed',
    top:             (rect.bottom + window.scrollY + 8) + 'px',
    left:            (rect.left + rect.width / 2 - 80) + 'px',
    zIndex:          '2147483647',
    background:      '#1a1d27',
    border:          '1px solid #7c6ef2',
    borderRadius:    '8px',
    padding:         '4px',
    boxShadow:       '0 4px 20px rgba(0,0,0,.5)',
    pointerEvents:   'auto',
  });

  const btn = tooltip.querySelector('#__llm-wiki-btn__');
  Object.assign(btn.style, {
    background:   '#7c6ef2',
    color:        '#fff',
    border:       'none',
    borderRadius: '6px',
    padding:      '6px 12px',
    fontSize:     '12px',
    fontWeight:   '700',
    cursor:       'pointer',
    whiteSpace:   'nowrap',
    fontFamily:   '-apple-system, sans-serif',
  });

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    removeTooltip();
    // Open the side panel
    chrome.runtime.sendMessage({ type: 'TEXT_SELECTED', text });
    chrome.runtime.sendMessage({ type: 'OPEN_SIDE_PANEL' }).catch(() => {});
  });

  document.body.appendChild(tooltip);

  // Auto-dismiss after 4 seconds
  tooltipTimeout = setTimeout(removeTooltip, 4000);
}

function removeTooltip() {
  clearTimeout(tooltipTimeout);
  tooltip?.remove();
  tooltip = null;
}

// Dismiss on click elsewhere
document.addEventListener('mousedown', (e) => {
  if (tooltip && !tooltip.contains(e.target)) removeTooltip();
});

// Dismiss on scroll
document.addEventListener('scroll', removeTooltip, { passive: true });
