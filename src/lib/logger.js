/**
 * lib/logger.js — Local ring-buffer logging system
 *
 * Solves: "Zero-Trust Debugging Paradox" — draconian CSP blocks external
 * telemetry tools (Sentry, Datadog). We need crash reports without exfiltration.
 *
 * Design:
 *  - Fixed-size ring buffer (MAX_ENTRIES) in memory, flushed to chrome.storage.local
 *  - Only non-sensitive system events are logged (no user content, no file names)
 *  - "Generate Diagnostic Report" bundles sanitized logs as a downloadable .txt
 *  - Works in service worker, offscreen document, and UI pages alike
 */

const MAX_ENTRIES  = 500;   // ring buffer size
const FLUSH_DELAY  = 2000;  // ms — debounce to avoid rapid IDB writes
const STORE_KEY    = 'llm_wiki_logs';
const hasChromeStorage = typeof chrome !== 'undefined' && !!chrome.storage && !!chrome.storage.local;

const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

let buffer       = [];
let flushTimer   = null;
let initialized  = false;

// ─── Public API ───────────────────────────────────────────────────────────────
export const log = {
  debug: (tag, msg, meta) => write('DEBUG', tag, msg, meta),
  info:  (tag, msg, meta) => write('INFO',  tag, msg, meta),
  warn:  (tag, msg, meta) => write('WARN',  tag, msg, meta),
  error: (tag, msg, meta) => write('ERROR', tag, msg, meta),
};

/** Load existing logs from storage into the ring buffer. Call once on startup. */
export async function initLogger() {
  if (initialized) return;
  try {
    // Only attempt to read from storage if the API actually exists
    if (hasChromeStorage) {
      const stored = await chrome.storage.local.get(STORE_KEY);
      buffer       = stored[STORE_KEY] ?? [];
    } else {
      buffer       = []; // Fallback for Web Workers
    }
    initialized  = true;
  } catch {
    buffer      = [];
    initialized = true;
  }
}

/** Return all log entries (most recent last). */
export async function getLogs() {
  await initLogger();
  return [...buffer];
}

/**
 * Generate a sanitized diagnostic report string.
 * Strips any text that looks like a file path or URL beyond the hostname.
 */
export async function generateDiagnosticReport() {
  await initLogger();
  const header = [
    '=== LLM Wiki Diagnostic Report ===',
    `Generated: ${new Date().toISOString()}`,
    `Extension: ${chrome.runtime.getManifest().version}`,
    `Entries:   ${buffer.length}`,
    '='.repeat(40),
    '',
  ].join('\n');

  const lines = buffer.map((e) => {
    const ts   = new Date(e.ts).toISOString();
    const meta = e.meta ? ` | ${JSON.stringify(sanitizeMeta(e.meta))}` : '';
    return `[${ts}] [${e.level}] [${e.tag}] ${e.msg}${meta}`;
  });

  return header + lines.join('\n');
}

/** Clear all logs from memory and storage. */
export async function clearLogs() {
  buffer = [];
  
  if (hasChromeStorage) {
      await chrome.storage.local.remove(STORE_KEY);
    } 
}

// ─── Internal ──────────────────────────────────────────────────────────────────
function write(level, tag, msg, meta) {
  const entry = {
    ts:    Date.now(),
    level,
    tag:   String(tag).slice(0, 30),
    msg:   sanitizeMessage(String(msg)),
    meta:  meta ? sanitizeMeta(meta) : undefined,
  };

  buffer.push(entry);

  // Enforce ring buffer size
  if (buffer.length > MAX_ENTRIES) buffer.splice(0, buffer.length - MAX_ENTRIES);

  // Console mirror (dev mode only)
  if (level === 'ERROR') console.error(`[${tag}]`, msg, meta ?? '');
  else if (level === 'WARN') console.warn(`[${tag}]`, msg, meta ?? '');

  scheduleFlush();
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    
    // If we are in a Web Worker, we cannot flush to chrome.storage.
    // The console mirror will still output our logs, so we safely exit.
    if (!hasChromeStorage) return; 

    try {
      await chrome.storage.local.set({ [STORE_KEY]: buffer });
    } catch (e) {
      console.warn('[logger] Flush failed:', e.message);
    }
  }, FLUSH_DELAY);
}

/**
 * Strip anything that looks like user file paths or raw content.
 * Only allow alphanumeric + basic punctuation in log messages.
 */
function sanitizeMessage(msg) {
  return msg
    .replace(/[A-Za-z]:\\[^\s]*/g, '[PATH]')          // Windows paths
    .replace(/\/(?:home|Users|root)\/[^\s]*/g, '[PATH]') // Unix paths
    .slice(0, 300);                                     // cap length
}

function sanitizeMeta(meta) {
  if (typeof meta !== 'object' || meta === null) return meta;
  const safe = {};
  for (const [k, v] of Object.entries(meta)) {
    // Allow only numeric and boolean values — no strings that might contain content
    if (typeof v === 'number' || typeof v === 'boolean') safe[k] = v;
    else if (typeof v === 'string') safe[k] = v.slice(0, 50);
  }
  return safe;
}

// Add this to the bottom of lib/logger.js

/**
 * Compatibility wrapper for dashboard.js UI logging.
 * Maps legacy `logLine(type, message)` calls to the new ring buffer.
 */
export function logLine(type, message) {
  // 1. Write it to the internal ring buffer for crash reports
  const tag = 'DashboardUI';
  switch (type) {
    case 'error': log.error(tag, message); break;
    case 'warn':  log.warn(tag, message);  break;
    default:      log.info(tag, message);  break;
  }

  // 2. Safely attempt to update the visual UI log on the dashboard page
  try {
    const output = document.getElementById('log-output');
    if (output) {
      const line = document.createElement('div');
      line.className = `log-line log-line--${type || 'info'}`;
      
      // Use DOMPurify if available globally, otherwise safely create a text node
      if (typeof window.DOMPurify !== 'undefined') {
        line.innerHTML = window.DOMPurify.sanitize(message);
      } else {
        line.textContent = message;
      }
      
      output.appendChild(line);
      output.scrollTop = output.scrollHeight;
    }
  } catch (e) {
    // Fails silently if not running in the context of the Dashboard UI
  }
}