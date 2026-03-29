/**
 * MusicShield — Popup UI
 *
 * Vanilla JS, no framework — popup needs to be instant (<50ms load).
 * Queries content script state every time popup opens.
 * All settings changes go through chrome.storage.sync.
 */

import { getSettings, saveSettings, getStats, resetStats } from '../shared/storage.js';
import { MSG, EXTENSION_STATE, STORAGE_KEYS, EXTENSION_VERSION } from '../shared/constants.js';

// ─── State ────────────────────────────────────────────────────────────────────

let settings = {};
let tabState = null;
let sessionStats = { totalMutedSeconds: 0, muteSegmentCount: 0 };
let persistentStats = {};

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  [settings, persistentStats] = await Promise.all([getSettings(), getStats()]);

  // Try to get tab state from content script
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

// ─── Render ────────────────────────────────────────────────────────────────────

function render() {
  const root = document.getElementById('root');
  const isOnYouTube = tabState !== null;
  const isEnabled = settings[STORAGE_KEYS.ENABLED] !== false;
  const isMuted = tabState?.isMuted ?? false;
  const isLoading = tabState?.classifierLoading ?? false;
  const state = tabState?.state ?? EXTENSION_STATE.READY;

  // Format stats
  const totalMuted = (persistentStats[STORAGE_KEYS.STATS_MUTED_SECONDS] || 0) +
                     (sessionStats?.totalMutedSeconds || 0);
  const muteCount = (persistentStats[STORAGE_KEYS.STATS_MUTE_COUNT] || 0) +
                    (sessionStats?.muteSegmentCount || 0);

  root.innerHTML = `
    <!-- Header -->
    <div class="header">
      <div class="brand">
        <div class="brand-icon">🛡</div>
        <span class="brand-name">MusicShield</span>
        <span class="brand-version">v${EXTENSION_VERSION}</span>
      </div>
      <label class="toggle-wrap" title="${isEnabled ? 'Disable' : 'Enable'} MusicShield">
        <input type="checkbox" class="toggle-input" id="toggle-enabled" ${isEnabled ? 'checked' : ''} />
        <div class="toggle-track"><div class="toggle-thumb"></div></div>
      </label>
    </div>

    <!-- Dynamic content section -->
    <div id="main-content" class="${isEnabled ? '' : 'disabled-overlay'}">
      ${isOnYouTube ? renderActiveState(state, isMuted, isLoading) : renderIdleState()}

      ${isOnYouTube ? `
        <!-- Stats -->
        <div class="stats-row">
          <div class="stat-tile">
            <div class="stat-value">${formatTime(totalMuted)}</div>
            <div class="stat-label">Music muted</div>
          </div>
          <div class="stat-tile">
            <div class="stat-value">${muteCount}</div>
            <div class="stat-label">Segments blocked</div>
          </div>
        </div>
      ` : ''}

      <div class="divider"></div>
      <div class="section-title">Detection Settings</div>

      <div class="settings-list">
        <!-- Sensitivity slider -->
        <div class="slider-row">
          <div class="slider-header">
            <div>
              <div class="setting-label">Music Sensitivity</div>
              <div class="setting-desc">How confident the AI must be to mute</div>
            </div>
            <div class="slider-value" id="threshold-display">${Math.round((settings[STORAGE_KEYS.THRESHOLD] || 0.45) * 100)}%</div>
          </div>
          <input
            type="range"
            id="slider-threshold"
            min="20" max="85" step="5"
            value="${Math.round((settings[STORAGE_KEYS.THRESHOLD] || 0.45) * 100)}"
          />
          <div class="slider-labels">
            <span>More sensitive</span>
            <span>More accurate</span>
          </div>
        </div>

        <!-- Mute singing -->
        <div class="setting-row">
          <div>
            <div class="setting-label">Mute Singing &amp; Vocals</div>
            <div class="setting-desc">Includes a cappella, background vocals</div>
          </div>
          <label class="toggle-wrap">
            <input type="checkbox" class="toggle-input" id="toggle-singing"
              ${settings[STORAGE_KEYS.MUTE_SINGING] ? 'checked' : ''} />
            <div class="toggle-track"><div class="toggle-thumb"></div></div>
          </label>
        </div>

        <!-- Badge -->
        <div class="setting-row">
          <div>
            <div class="setting-label">Show Status Badge</div>
            <div class="setting-desc">🔇 icon on muted tabs</div>
          </div>
          <label class="toggle-wrap">
            <input type="checkbox" class="toggle-input" id="toggle-badge"
              ${settings[STORAGE_KEYS.SHOW_BADGE] !== false ? 'checked' : ''} />
            <div class="toggle-track"><div class="toggle-thumb"></div></div>
          </label>
        </div>
      </div>
    </div>

    <!-- Footer -->
    <div class="footer">
      <button class="footer-link" id="btn-reset-stats">Reset stats</button>
      <a class="footer-link" href="#" id="btn-options">Advanced settings ↗</a>
    </div>
  `;

  attachListeners();
}

function renderActiveState(state, isMuted, isLoading) {
  if (isLoading || state === EXTENSION_STATE.LOADING) {
    return `
      <div class="status-card loading">
        <div class="status-icon-wrap"><div class="spinner"></div></div>
        <div class="status-text">
          <div class="status-label">Loading AI Model</div>
          <div class="status-sub">First-time load ~5–10s, then cached</div>
        </div>
      </div>`;
  }

  if (isMuted || state === EXTENSION_STATE.MUTED) {
    return `
      <div class="status-card muted">
        <div class="status-icon-wrap">🔇</div>
        <div class="status-text">
          <div class="status-label">Music Detected — Muted</div>
          <div class="status-sub">Audio will restore when music ends</div>
        </div>
      </div>`;
  }

  if (state === EXTENSION_STATE.ERROR) {
    return `
      <div class="status-card">
        <div class="status-icon-wrap">⚠️</div>
        <div class="status-text">
          <div class="status-label">Classifier Error</div>
          <div class="status-sub">Reload the page to retry</div>
        </div>
      </div>`;
  }

  return `
    <div class="status-card listening">
      <div class="status-icon-wrap">👂</div>
      <div class="status-text">
        <div class="status-label">Listening — No Music</div>
        <div class="status-sub">Audio playing normally</div>
      </div>
    </div>`;
}

function renderIdleState() {
  return `
    <div class="idle-state">
      <div class="idle-icon">▶</div>
      <div class="idle-title">Open a YouTube video</div>
      <div class="idle-sub">MusicShield activates automatically when you play a video on YouTube.</div>
    </div>`;
}

// ─── Listeners ────────────────────────────────────────────────────────────────

function attachListeners() {
  // Main enable/disable toggle
  el('toggle-enabled')?.addEventListener('change', async (e) => {
    settings[STORAGE_KEYS.ENABLED] = e.target.checked;
    await saveSettings({ [STORAGE_KEYS.ENABLED]: e.target.checked });
    render();
  });

  // Singing toggle
  el('toggle-singing')?.addEventListener('change', async (e) => {
    settings[STORAGE_KEYS.MUTE_SINGING] = e.target.checked;
    await saveSettings({ [STORAGE_KEYS.MUTE_SINGING]: e.target.checked });
  });

  // Badge toggle
  el('toggle-badge')?.addEventListener('change', async (e) => {
    settings[STORAGE_KEYS.SHOW_BADGE] = e.target.checked;
    await saveSettings({ [STORAGE_KEYS.SHOW_BADGE]: e.target.checked });
  });

  // Threshold slider — debounced save
  const slider = el('slider-threshold');
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

  // Reset stats
  el('btn-reset-stats')?.addEventListener('click', async () => {
    if (confirm('Reset all mute statistics?')) {
      await resetStats();
      persistentStats = {};
      render();
    }
  });

  // Options page
  el('btn-options')?.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function el(id) {
  return document.getElementById(id);
}

function formatTime(seconds) {
  if (!seconds || seconds < 1) return '0s';
  if (seconds < 60) return Math.round(seconds) + 's';
  if (seconds < 3600) return Math.round(seconds / 60) + 'm';
  return (seconds / 3600).toFixed(1) + 'h';
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);
