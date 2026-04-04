/**
 * Sakina — Popup UI (i18n)
 *
 * Vanilla JS, no framework — popup needs to be instant (<50ms load).
 * All user-facing strings go through chrome.i18n.getMessage() (t()).
 */

import './popup.css';
import { getSettings, saveSettings, getStats, resetStats } from '../shared/storage.js';
import { MSG, EXTENSION_STATE, STORAGE_KEYS, EXTENSION_VERSION } from '../shared/constants.js';
import { loadTranslations, t } from '../shared/i18n.js';

// ─── SVG Icons ────────────────────────────────────────────────────────────────

const ICON = {
  shield: `<svg width="22" height="22" viewBox="0 0 100 100" fill="none"><path d="M50 4 L94 22 V52 C94 76 74 90 50 98 C26 90 6 76 6 52 V22 Z" fill="#1a7a45" fill-opacity="0.15" stroke="#1a7a45" stroke-width="5" stroke-linejoin="round"/><g transform="translate(30,26)"><ellipse cx="16" cy="40" rx="10" ry="7" transform="rotate(-15,16,40)" fill="#1a7a45"/><rect x="24" y="6" width="4" height="35" rx="2" fill="#1a7a45"/><path d="M28 6 C40 8 42 18 36 26" stroke="#1a7a45" stroke-width="4.5" stroke-linecap="round"/></g></svg>`,
  muted:  `<svg width="22" height="22" viewBox="0 0 100 100" fill="none"><path d="M50 4 L94 22 V52 C94 76 74 90 50 98 C26 90 6 76 6 52 V22 Z" fill="#ef4444" fill-opacity="0.1" stroke="#ef4444" stroke-width="5" stroke-linejoin="round"/><g transform="translate(30,26)"><ellipse cx="16" cy="40" rx="10" ry="7" transform="rotate(-15,16,40)" fill="#ef4444" opacity="0.7"/><rect x="24" y="6" width="4" height="35" rx="2" fill="#ef4444" opacity="0.7"/><path d="M28 6 C40 8 42 18 36 26" stroke="#ef4444" stroke-width="4.5" stroke-linecap="round" opacity="0.7"/></g><line x1="15" y1="85" x2="85" y2="15" stroke="#ef4444" stroke-width="6" stroke-linecap="round"/></svg>`,
  listening: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18v-6a9 9 0 0118 0v6"/><path d="M21 19a2 2 0 01-2 2h-1a2 2 0 01-2-2v-3a2 2 0 012-2h3zm-18 0a2 2 0 002 2h1a2 2 0 002-2v-3a2 2 0 00-2-2H3z"/></svg>`,
  error:  `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  idle:   `<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#4a6057" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polygon points="10,8 16,12 10,16" fill="#4a6057" stroke="none"/></svg>`,
};

// ─── State ────────────────────────────────────────────────────────────────────

let settings = {};
let tabState = null;
let sessionStats = { totalMutedSeconds: 0, muteSegmentCount: 0 };
let persistentStats = {};
let _loadingPoller = null;

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  await loadTranslations(); // Load i18n translations first
  [settings, persistentStats] = await Promise.all([getSettings(), getStats()]);

  try {
    tabState = await getTabState();
  } catch {
    tabState = null;
  }

  if (tabState?.stats) {
    sessionStats = tabState.stats;
  }

  render();
}

async function getTabState() {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: MSG.GET_TAB_STATE }, (response) => {
      if (chrome.runtime.lastError || response?.error) {
        reject(new Error(response?.error || chrome.runtime.lastError?.message));
        return;
      }
      resolve(response);
    });
  });
}

function startLoadingPoller() {
  if (_loadingPoller) return; // já está rodando

  _loadingPoller = setInterval(async () => {
    try {
      const newState = await getTabState();
      // Continua polling enquanto classifier está loading ou state é LOADING
      if (!newState || newState.classifierLoading || newState.state === EXTENSION_STATE.LOADING) {
        return; // ainda carregando — tenta de novo em 1s
      }
      // Modelo carregou — atualiza e para
      clearInterval(_loadingPoller);
      _loadingPoller = null;
      tabState = newState;
      if (newState.stats) sessionStats = newState.stats;
      render();
    } catch {
      // Content script não respondeu — tenta de novo em 1s
    }
  }, 1000);
}

function stopLoadingPoller() {
  if (_loadingPoller) {
    clearInterval(_loadingPoller);
    _loadingPoller = null;
  }
}

// ─── Render ───────────────────────────────────────────────────────────────────

function render() {
  const root = document.getElementById('root');
  const isOnVideo = tabState !== null;
  const isEnabled = settings[STORAGE_KEYS.ENABLED] !== false;
  const isMuted   = tabState?.isMuted ?? false;
  const isLoading = tabState?.classifierLoading ?? false;
  const state     = tabState?.state ?? EXTENSION_STATE.READY;

  const totalMuted = (persistentStats[STORAGE_KEYS.STATS_MUTED_SECONDS] || 0) +
                     (sessionStats?.totalMutedSeconds || 0);
  const muteCount  = (persistentStats[STORAGE_KEYS.STATS_MUTE_COUNT] || 0) +
                     (sessionStats?.muteSegmentCount || 0);

  root.innerHTML = `
    <div class="header">
      <div class="brand">
        <div class="brand-icon">${ICON.shield}</div>
        <span class="brand-name">Sakina</span>
        <span class="brand-version">v${EXTENSION_VERSION}</span>
      </div>
      <label class="toggle-wrap" title="${isEnabled ? t('toggle_disable') : t('toggle_enable')}">
        <input type="checkbox" class="toggle-input" id="toggle-enabled" ${isEnabled ? 'checked' : ''} />
        <div class="toggle-track"><div class="toggle-thumb"></div></div>
      </label>
    </div>

    <div id="main-content" class="${isEnabled ? '' : 'disabled-overlay'}">
      ${isOnVideo ? renderActiveState(state, isMuted, isLoading) : renderIdleState()}

      ${isOnVideo ? `
        <div class="stats-row">
          <div class="stat-tile">
            <div class="stat-value">${formatTime(totalMuted)}</div>
            <div class="stat-label">${t('stat_music_muted')}</div>
          </div>
          <div class="stat-tile">
            <div class="stat-value">${muteCount}</div>
            <div class="stat-label">${t('stat_segments')}</div>
          </div>
        </div>
      ` : ''}

      <div class="divider"></div>
      <div class="section-title">${t('section_detection')}</div>

      <div class="settings-list">
        <div class="slider-row">
          <div class="slider-header">
            <div>
              <div class="setting-label">${t('setting_sensitivity_label')}</div>
              <div class="setting-desc">${t('setting_sensitivity_desc')}</div>
            </div>
            <div class="slider-value" id="threshold-display">${Math.round((settings[STORAGE_KEYS.THRESHOLD] || 0.45) * 100)}%</div>
          </div>
          <input type="range" id="slider-threshold" min="20" max="85" step="5"
            value="${Math.round((settings[STORAGE_KEYS.THRESHOLD] || 0.45) * 100)}" />
          <div class="slider-labels">
            <span>${t('sensitivity_more')}</span>
            <span>${t('sensitivity_accurate')}</span>
          </div>
        </div>

        <div class="setting-row">
          <div>
            <div class="setting-label">${t('setting_singing_label')}</div>
            <div class="setting-desc">${t('setting_singing_desc')}</div>
          </div>
          <label class="toggle-wrap">
            <input type="checkbox" class="toggle-input" id="toggle-singing"
              ${settings[STORAGE_KEYS.MUTE_SINGING] ? 'checked' : ''} />
            <div class="toggle-track"><div class="toggle-thumb"></div></div>
          </label>
        </div>

        <div class="setting-row">
          <div>
            <div class="setting-label">${t('setting_badge_label')}</div>
            <div class="setting-desc">${t('setting_badge_desc')}</div>
          </div>
          <label class="toggle-wrap">
            <input type="checkbox" class="toggle-input" id="toggle-badge"
              ${settings[STORAGE_KEYS.SHOW_BADGE] !== false ? 'checked' : ''} />
            <div class="toggle-track"><div class="toggle-thumb"></div></div>
          </label>
        </div>
      </div>
    </div>

    <div class="footer">
      <button class="footer-link" id="btn-reset-stats">${t('btn_reset_stats')}</button>
      <a class="footer-link" href="about.html" target="_blank" id="btn-about">${t('btn_about')}</a>
      <a class="footer-link" href="#" id="btn-options">${t('btn_advanced')}</a>
    </div>
  `;

  // Se extensão está em loading state, inicia poller para auto-refresh
  const isCurrentlyLoading = (tabState?.classifierLoading || tabState?.state === EXTENSION_STATE.LOADING);
  if (isCurrentlyLoading) {
    startLoadingPoller();
  } else {
    stopLoadingPoller(); // garante que para se não estiver mais em loading
  }

  attachListeners();
}

function renderActiveState(state, isMuted, isLoading) {
  if (isLoading || state === EXTENSION_STATE.LOADING) {
    return `
      <div class="status-card loading">
        <div class="status-icon-wrap"><div class="spinner"></div></div>
        <div class="status-text">
          <div class="status-label">${t('status_loading_title')}</div>
          <div class="status-sub">${t('status_loading_sub')}</div>
        </div>
      </div>`;
  }
  if (isMuted || state === EXTENSION_STATE.MUTED) {
    return `
      <div class="status-card muted">
        <div class="status-icon-wrap">${ICON.muted}</div>
        <div class="status-text">
          <div class="status-label">${t('status_muted_title')}</div>
          <div class="status-sub">${t('status_muted_sub')}</div>
        </div>
      </div>`;
  }
  if (state === EXTENSION_STATE.ERROR) {
    return `
      <div class="status-card">
        <div class="status-icon-wrap">${ICON.error}</div>
        <div class="status-text">
          <div class="status-label">${t('status_error_title')}</div>
          <div class="status-sub">${t('status_error_sub')}</div>
        </div>
      </div>`;
  }
  return `
    <div class="status-card listening">
      <div class="status-icon-wrap">${ICON.listening}</div>
      <div class="status-text">
        <div class="status-label">${t('status_listening_title')}</div>
        <div class="status-sub">${t('status_listening_sub')}</div>
      </div>
    </div>`;
}

function renderIdleState() {
  return `
    <div class="idle-state">
      <div class="idle-icon">${ICON.idle}</div>
      <div class="idle-title">${t('idle_title')}</div>
      <div class="idle-sub">${t('idle_sub')}</div>
    </div>`;
}

// ─── Listeners ────────────────────────────────────────────────────────────────

function attachListeners() {
  el('toggle-enabled')?.addEventListener('change', async (e) => {
    settings[STORAGE_KEYS.ENABLED] = e.target.checked;
    await saveSettings({ [STORAGE_KEYS.ENABLED]: e.target.checked });
    render();
  });

  el('toggle-singing')?.addEventListener('change', async (e) => {
    settings[STORAGE_KEYS.MUTE_SINGING] = e.target.checked;
    await saveSettings({ [STORAGE_KEYS.MUTE_SINGING]: e.target.checked });
  });

  el('toggle-badge')?.addEventListener('change', async (e) => {
    settings[STORAGE_KEYS.SHOW_BADGE] = e.target.checked;
    await saveSettings({ [STORAGE_KEYS.SHOW_BADGE]: e.target.checked });
  });

  const slider  = el('slider-threshold');
  const display = el('threshold-display');
  let saveTimeout;
  slider?.addEventListener('input', (e) => {
    const val = parseInt(e.target.value);
    if (display) display.textContent = val + '%';
    settings[STORAGE_KEYS.THRESHOLD] = val / 100;
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
      saveSettings({ [STORAGE_KEYS.THRESHOLD]: val / 100 });
    }, 400);
  });

  el('btn-reset-stats')?.addEventListener('click', async () => {
    if (confirm(t('confirm_reset'))) {
      await resetStats();
      persistentStats = {};
      render();
    }
  });

  el('btn-options')?.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function el(id) { return document.getElementById(id); }

function formatTime(seconds) {
  if (!seconds || seconds < 1) return '0s';
  if (seconds < 60) return Math.round(seconds) + 's';
  if (seconds < 3600) return Math.round(seconds / 60) + 'm';
  return (seconds / 3600).toFixed(1) + 'h';
}

document.addEventListener('DOMContentLoaded', init);
window.addEventListener('unload', stopLoadingPoller);
