/**
 * Sakina — Background Service Worker (Manifest V3)
 *
 * Responsibilities:
 *   - Initialize storage defaults on install/update
 *   - Relay messages between content scripts and popup
 *   - Manage browser action badge (tab-specific)
 *   - Handle extension icon state (enabled/disabled)
 *   - Alarm-based health check (ensures service worker stays responsive)
 */

import { initializeDefaults, getSettings, saveSettings, onSettingsChange } from '../shared/storage.js';
import { MSG, EXTENSION_STATE, STORAGE_KEYS } from '../shared/constants.js';

// ─── Install / Update ─────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async (details) => {
  await initializeDefaults();

  if (details.reason === 'install') {
    console.info('[Sakina:bg] Fresh install — opening onboarding tab');
    chrome.tabs.create({
      url: chrome.runtime.getURL('options.html') + '?welcome=true',
    });
  } else if (details.reason === 'update') {
    console.info(`[Sakina:bg] Updated to ${details.previousVersion}`);
  }
});

// ─── Badge Management ─────────────────────────────────────────────────────────

/** Per-tab badge state */
const tabBadgeState = new Map();

function setBadge(tabId, text, color) {
  if (!tabId) return;
  tabBadgeState.set(tabId, { text, color });
  chrome.action.setBadgeText({ tabId, text: text || '' });
  if (color && text) {
    chrome.action.setBadgeBackgroundColor({ tabId, color });
  }
}

function clearBadge(tabId) {
  tabBadgeState.delete(tabId);
  chrome.action.setBadgeText({ tabId, text: '' });
}

// ─── Tab Cleanup ──────────────────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
  tabBadgeState.delete(tabId);
});

// ─── Message Routing ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  switch (message.type) {
    // Content script reporting state change
    case MSG.CLASSIFIER_STATUS:
      handleClassifierStatus(tabId, message.state);
      break;

    // Content script reporting mute state (for badge)
    case MSG.MUTE_STATE_CHANGED:
      if (tabId) setBadge(tabId, message.badgeText, message.badgeColor);
      break;

    // Popup asking for current tab state — forward to content script
    case MSG.GET_TAB_STATE:
      getCurrentTabId().then((currentTabId) => {
        if (!currentTabId) {
          sendResponse({ error: 'No active YouTube tab' });
          return;
        }
        chrome.tabs.sendMessage(currentTabId, message, (response) => {
          if (chrome.runtime.lastError) {
            sendResponse({ error: chrome.runtime.lastError.message });
          } else {
            sendResponse(response);
          }
        });
      });
      return true; // Keep channel open

    // Popup getting settings
    case MSG.GET_SETTINGS:
      getSettings().then(sendResponse);
      return true;

    // Popup saving settings
    case MSG.SET_SETTINGS:
      saveSettings(message.updates).then(() => sendResponse({ ok: true }));
      return true;

    default:
      break;
  }

  return false;
});

// ─── Status Handler ───────────────────────────────────────────────────────────

const DEFAULT_ICON = {
  16: 'icons/icon16.png',
  32: 'icons/icon32.png',
  48: 'icons/icon48.png',
  128: 'icons/icon128.png',
};

const MUTED_ICON = {
  16: 'icons/icon16-muted.png',
  32: 'icons/icon32-muted.png',
  48: 'icons/icon48-muted.png',
  128: 'icons/icon128-muted.png',
};

function handleClassifierStatus(tabId, state) {
  if (!tabId) return;

  const badgeConfig = {
    [EXTENSION_STATE.LOADING]: { text: '⋯', color: '#f59e0b' },
    [EXTENSION_STATE.READY]: { text: '', color: '#22c55e' },
    [EXTENSION_STATE.LISTENING]: { text: '', color: '#22c55e' },
    [EXTENSION_STATE.MUTED]: { text: '', color: '#ef4444' },
    [EXTENSION_STATE.DISABLED]: { text: 'off', color: '#6b7280' },
    [EXTENSION_STATE.ERROR]: { text: '!', color: '#ef4444' },
  };

  const cfg = badgeConfig[state];
  if (cfg) setBadge(tabId, cfg.text, cfg.color);

  // Swap icon between default and muted variant
  const isMuted = state === EXTENSION_STATE.MUTED;
  chrome.action.setIcon({
    tabId,
    path: isMuted ? MUTED_ICON : DEFAULT_ICON,
  }).catch(() => {});
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getCurrentTabId() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs[0]?.id || null);
    });
  });
}

// ─── Keep-Alive Alarm (MV3 service worker lifecycle) ─────────────────────────

chrome.alarms.create('keepAlive', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAlive') {
    // No-op: just keeps the service worker from being unloaded
  }
});

console.info('[Sakina:bg] Service worker started.');
