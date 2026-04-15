/**
 * background.js — MV3 Service Worker (slim router)
 *
 *  [1] Offscreen Document pipeline delegation
 *  [2] chrome.alarms keepalive
 *  [3] navigator.storage.persist()
 *  [4] activeTab scripting injection (no <all_urls>)
 *  [8] Vision: captureVisibleTab on icon click + CANVAS_SELECTION routing
 */

import { log, initLogger } from './lib/logger.js';

const TAG           = 'background';
const OFFSCREEN_URL = 'offscreen/offscreen.html';
const ALARM_NAME    = 'llm-wiki-keepalive';

chrome.runtime.onInstalled.addListener(async () => {
  await initLogger();
  if (navigator.storage?.persist) {
    const granted = await navigator.storage.persist();
    log.info(TAG, 'storage.persist granted', { granted });
    if (!granted) log.warn(TAG, 'Storage persistence denied');
  }
  log.info(TAG, 'Extension installed/updated');
});

chrome.runtime.onStartup.addListener(async () => {
  await initLogger();
  log.info(TAG, 'Extension started');
});

// [4]+[8] Icon click: open panel + inject content.js + capture screenshot for vision scan
chrome.action.onClicked.addListener(async (tab) => {
  // 1. Open side panel
  try { await chrome.sidePanel.open({ tabId: tab.id }); } catch {}

  // 2. Inject content.js (activeTab grant; guard against double-injection inside content.js)
  if (tab.url && (tab.url.startsWith('https://') || tab.url.startsWith('http://'))) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      log.info(TAG, 'content.js injected', { tabId: tab.id });
    } catch (err) {
      log.warn(TAG, 'Content script injection skipped', { reason: err.message });
    }
  }

  // 3. [8] Capture visible tab and run vision-based entity detection
  if (tab.url && (tab.url.startsWith('https://') || tab.url.startsWith('http://'))) {
    try {
      await ensureOffscreen();
      const screenshotDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
        format: 'jpeg', quality: 60,
      });
      // Fire-and-forget: offscreen will broadcast PAGE_ENTITIES when done
      chrome.runtime.sendMessage({ type: 'OFFSCREEN_IMAGE_DETECT', screenshotDataUrl }).catch(() => {});
      log.info(TAG, 'Screenshot captured for vision scan');
    } catch (err) {
      log.warn(TAG, 'Screenshot capture failed', { err: err.message });
    }
  }
});

// Keepalive alarm
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  chrome.runtime.sendMessage({ type: 'KEEPALIVE_PING' }).catch(() => chrome.alarms.clear(ALARM_NAME));
});

// Offscreen helpers
async function ensureOffscreen() {
  const has = await chrome.offscreen.hasDocument?.() ?? false;
  if (has) return;
  await chrome.offscreen.createDocument({
    url:           OFFSCREEN_URL,
    reasons:       [chrome.offscreen.Reason.BLOBS],
    justification: 'Run GraphRAG pipeline workers without SW lifetime limits',
  });
  log.info(TAG, 'Offscreen document created');
}

async function closeOffscreen() {
  try {
    if (await chrome.offscreen.hasDocument?.()) await chrome.offscreen.closeDocument();
  } catch {}
  chrome.alarms.clear(ALARM_NAME);
  log.info(TAG, 'Offscreen document closed');
}

// Message router
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type, payload } = message;

  switch (type) {
    case 'OPEN_DASHBOARD':
      chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html') });
      sendResponse({ ok: true });
      break;

    case 'PIPELINE_START': {
      (async () => {
        try {
          await ensureOffscreen();
          chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 / 3 });
          await chrome.runtime.sendMessage({ type: 'OFFSCREEN_PIPELINE_START', payload });
          sendResponse({ ok: true, status: 'pipeline_delegated' });
        } catch (err) {
          log.error(TAG, 'Pipeline delegation failed', { err: err.message });
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }

    case 'CLOSE_OFFSCREEN':
      closeOffscreen();
      sendResponse({ ok: true });
      break;

    case 'CROSS_REF_QUERY': {
      (async () => {
        try {
          await ensureOffscreen();
          const result = await chrome.runtime.sendMessage({
            type: 'OFFSCREEN_INFERENCE', payload: { type: 'CROSS_REF_ANSWER', ...payload },
          });
          sendResponse(result);
        } catch (err) { sendResponse({ ok: false, error: err.message }); }
      })();
      return true;
    }

    case 'INFERENCE_REQUEST': {
      (async () => {
        try {
          await ensureOffscreen();
          const result = await chrome.runtime.sendMessage({ type: 'OFFSCREEN_INFERENCE', payload });
          sendResponse(result);
        } catch (err) { sendResponse({ ok: false, error: err.message }); }
      })();
      return true;
    }

    // [8] Content script detected a canvas mouseup — capture + crop + OCR
    case 'CANVAS_SELECTION': {
      (async () => {
        try {
          if (!sender.tab) { sendResponse({ ok: false, error: 'No tab' }); return; }
          await ensureOffscreen();
          const screenshotDataUrl = await chrome.tabs.captureVisibleTab(sender.tab.windowId, {
            format: 'jpeg', quality: 80,
          });
          // Fire-and-forget; offscreen will broadcast OCR_RESULT
          chrome.runtime.sendMessage({
            type: 'OFFSCREEN_IMAGE_OCR',
            screenshotDataUrl,
            rect: payload.rect,
          }).catch(() => {});
          sendResponse({ ok: true });
        } catch (err) {
          log.warn(TAG, 'Canvas OCR capture failed', { err: err.message });
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }

    case 'OPEN_SIDE_PANEL':
      if (sender.tab?.id) chrome.sidePanel.open({ tabId: sender.tab.id });
      sendResponse({ ok: true });
      break;

    default:
      break;
  }
});
