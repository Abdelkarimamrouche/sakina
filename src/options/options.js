/**
 * MusicShield — Options Page
 * Full-featured settings with advanced controls, debug info, and export.
 */

import { getSettings, saveSettings, getStats, resetStats } from '../shared/storage.js';
import { STORAGE_KEYS, EXTENSION_VERSION } from '../shared/constants.js';

async function init() {
  const [settings, stats] = await Promise.all([getSettings(), getStats()]);

  document.getElementById('version').textContent = `v${EXTENSION_VERSION}`;

  // Populate all inputs
  document.getElementById('setting-enabled').checked = settings[STORAGE_KEYS.ENABLED];
  document.getElementById('setting-singing').checked = settings[STORAGE_KEYS.MUTE_SINGING];
  document.getElementById('setting-badge').checked = settings[STORAGE_KEYS.SHOW_BADGE] !== false;
  document.getElementById('setting-threshold').value = Math.round((settings[STORAGE_KEYS.THRESHOLD] || 0.45) * 100);
  document.getElementById('threshold-value').textContent = Math.round((settings[STORAGE_KEYS.THRESHOLD] || 0.45) * 100) + '%';

  // Stats
  const muted = stats[STORAGE_KEYS.STATS_MUTED_SECONDS] || 0;
  const muteCount = stats[STORAGE_KEYS.STATS_MUTE_COUNT] || 0;
  const videos = stats[STORAGE_KEYS.STATS_VIDEOS_PROCESSED] || 0;

  document.getElementById('stat-muted-time').textContent = formatTime(muted);
  document.getElementById('stat-mute-count').textContent = muteCount.toLocaleString();
  document.getElementById('stat-videos').textContent = videos.toLocaleString();

  // Wire listeners
  setupListeners();
}

function setupListeners() {
  // Auto-save on any input change
  document.querySelectorAll('input').forEach(input => {
    input.addEventListener('change', saveAll);
  });

  document.getElementById('setting-threshold').addEventListener('input', (e) => {
    document.getElementById('threshold-value').textContent = e.target.value + '%';
  });

  document.getElementById('btn-reset-stats').addEventListener('click', async () => {
    if (confirm('Reset all lifetime statistics?')) {
      await resetStats();
      location.reload();
    }
  });

  // Welcome state from install
  const params = new URLSearchParams(location.search);
  if (params.get('welcome') === 'true') {
    document.getElementById('welcome-banner')?.classList.remove('hidden');
  }
}

async function saveAll() {
  const updates = {
    [STORAGE_KEYS.ENABLED]: document.getElementById('setting-enabled').checked,
    [STORAGE_KEYS.MUTE_SINGING]: document.getElementById('setting-singing').checked,
    [STORAGE_KEYS.SHOW_BADGE]: document.getElementById('setting-badge').checked,
    [STORAGE_KEYS.THRESHOLD]: parseInt(document.getElementById('setting-threshold').value) / 100,
  };
  await saveSettings(updates);
  showSaved();
}

function showSaved() {
  const indicator = document.getElementById('saved-indicator');
  if (!indicator) return;
  indicator.textContent = 'Saved ✓';
  indicator.style.opacity = '1';
  setTimeout(() => { indicator.style.opacity = '0'; }, 1800);
}

function formatTime(seconds) {
  if (!seconds || seconds < 1) return '0s';
  if (seconds < 60) return Math.round(seconds) + 's';
  if (seconds < 3600) return Math.round(seconds / 60) + 'm';
  return (seconds / 3600).toFixed(1) + 'h';
}

document.addEventListener('DOMContentLoaded', init);
