/**
 * Sakina — Options Page (Redesigned)
 *
 * Advanced settings: platform toggles, allowlist, activity log, expanded stats.
 * Basic controls (sensitivity, singing, badge) stay exclusively in the popup.
 */

import {
  getSettings, saveSettings, getStats, resetStats,
  getActivityLog, clearActivityLog,
  getAllowlist, addToAllowlist, removeFromAllowlist,
  getStatsByPlatform,
} from '../shared/storage.js';
import { STORAGE_KEYS, EXTENSION_VERSION } from '../shared/constants.js';
import { loadTranslations, t } from '../shared/i18n.js';

// ─── State ────────────────────────────────────────────────────────────────────

let settings = {};
let stats = {};
let statsByPlatform = {};
let activityLog = [];
let allowlist = [];

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  await loadTranslations();

  [settings, stats, statsByPlatform, activityLog, allowlist] = await Promise.all([
    getSettings(),
    getStats(),
    getStatsByPlatform(),
    getActivityLog(),
    getAllowlist(),
  ]);

  document.getElementById('version').textContent = `v${EXTENSION_VERSION}`;

  applyI18nLabels();
  renderPlatformToggles();
  renderAllowlist();
  renderActivityLog();
  renderStats();
  setupListeners();

  // Show welcome banner if first install
  const params = new URLSearchParams(location.search);
  if (params.get('welcome') === 'true') {
    document.getElementById('welcome-banner')?.classList.remove('hidden');
  }
}

// ─── i18n ─────────────────────────────────────────────────────────────────────

function applyI18nLabels() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const msg = t(key);
    if (msg && msg !== key) el.textContent = msg;
  });

  // Handle placeholder for allowlist input
  const input = document.getElementById('allowlist-input');
  if (input) input.placeholder = t('opt_allowlist_placeholder') || 'youtube.com/@ChannelName';
}

// ─── Platform Toggles ─────────────────────────────────────────────────────────

function renderPlatformToggles() {
  el('toggle-youtube').checked   = settings[STORAGE_KEYS.ENABLED_YOUTUBE] !== false;
  el('toggle-instagram').checked = settings[STORAGE_KEYS.ENABLED_INSTAGRAM] !== false;
  el('toggle-facebook').checked  = settings[STORAGE_KEYS.ENABLED_FACEBOOK] !== false;
  el('toggle-tiktok').checked    = settings[STORAGE_KEYS.ENABLED_TIKTOK] !== false;
}

// ─── Allowlist ────────────────────────────────────────────────────────────────

function renderAllowlist() {
  const container = el('allowlist-items');

  if (allowlist.length === 0) {
    container.innerHTML = `<div class="allowlist-empty">${t('opt_allowlist_empty') || 'No items yet'}</div>`;
    return;
  }

  container.innerHTML = allowlist.map(url => `
    <div class="allowlist-item">
      <span class="allowlist-url">${escapeHtml(url)}</span>
      <button class="allowlist-remove" data-url="${escapeHtml(url)}">×</button>
    </div>
  `).join('');

  // Attach remove handlers
  container.querySelectorAll('.allowlist-remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      const url = btn.dataset.url;
      await removeFromAllowlist(url);
      allowlist = await getAllowlist();
      renderAllowlist();
    });
  });
}

// ─── Activity Log ─────────────────────────────────────────────────────────────

function renderActivityLog() {
  const container = el('activity-log');

  if (activityLog.length === 0) {
    container.innerHTML = `<div class="activity-empty">${t('opt_activity_empty') || 'No recent activity'}</div>`;
    return;
  }

  const platformIcons = {
    youtube: '🎬',
    instagram: '📸',
    facebook: '👥',
    tiktok: '🎵',
  };

  container.innerHTML = activityLog.map(entry => {
    const icon = platformIcons[entry.platform?.toLowerCase()] || '🔇';
    const platform = capitalize(entry.platform || 'Unknown');
    const timeAgo = formatTimeAgo(entry.timestamp);
    const duration = formatDuration(entry.durationSeconds);

    return `
      <div class="activity-item">
        <span class="activity-icon">${icon}</span>
        <div class="activity-info">
          <div class="activity-platform">${platform}</div>
          <div class="activity-time">${timeAgo}</div>
        </div>
        <span class="activity-duration">${duration}</span>
      </div>
    `;
  }).join('');
}

// ─── Statistics ───────────────────────────────────────────────────────────────

function renderStats() {
  const muted = stats[STORAGE_KEYS.STATS_MUTED_SECONDS] || 0;
  const muteCount = stats[STORAGE_KEYS.STATS_MUTE_COUNT] || 0;
  const videos = stats[STORAGE_KEYS.STATS_VIDEOS_PROCESSED] || 0;

  el('stat-muted-time').textContent = formatTime(muted);
  el('stat-mute-count').textContent = muteCount.toLocaleString();
  el('stat-videos').textContent = videos.toLocaleString();
  el('stat-accuracy').textContent = '—'; // No accuracy tracking implemented

  // Platform breakdown
  const total = Object.values(statsByPlatform).reduce((a, b) => a + b, 0);
  const platforms = ['youtube', 'instagram', 'facebook', 'tiktok'];

  platforms.forEach(p => {
    const value = statsByPlatform[p] || 0;
    const percent = total > 0 ? Math.round((value / total) * 100) : 0;
    const barEl = el(`bar-${p}`);
    const percentEl = el(`percent-${p}`);
    if (barEl) barEl.style.width = `${percent}%`;
    if (percentEl) percentEl.textContent = `${percent}%`;
  });
}

// ─── Listeners ────────────────────────────────────────────────────────────────

function setupListeners() {
  // Platform toggles
  el('toggle-youtube')?.addEventListener('change', (e) => {
    saveSetting(STORAGE_KEYS.ENABLED_YOUTUBE, e.target.checked);
  });
  el('toggle-instagram')?.addEventListener('change', (e) => {
    saveSetting(STORAGE_KEYS.ENABLED_INSTAGRAM, e.target.checked);
  });
  el('toggle-facebook')?.addEventListener('change', (e) => {
    saveSetting(STORAGE_KEYS.ENABLED_FACEBOOK, e.target.checked);
  });
  el('toggle-tiktok')?.addEventListener('change', (e) => {
    saveSetting(STORAGE_KEYS.ENABLED_TIKTOK, e.target.checked);
  });

  // Allowlist add
  const addBtn = el('btn-add-allowlist');
  const addInput = el('allowlist-input');

  addBtn?.addEventListener('click', async () => {
    const value = addInput.value.trim();
    if (value) {
      await addToAllowlist(value);
      allowlist = await getAllowlist();
      renderAllowlist();
      addInput.value = '';
    }
  });

  addInput?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') addBtn?.click();
  });

  // Clear activity
  el('btn-clear-activity')?.addEventListener('click', async () => {
    if (confirm(t('confirm_clear_activity') || 'Clear activity history?')) {
      await clearActivityLog();
      activityLog = [];
      renderActivityLog();
    }
  });

  // Reset stats
  el('btn-reset-stats')?.addEventListener('click', async () => {
    if (confirm(t('opt_confirm_reset_stats') || 'Reset all statistics? This cannot be undone.')) {
      await resetStats();
      stats = await getStats();
      statsByPlatform = await getStatsByPlatform();
      renderStats();
    }
  });

  // Export CSV
  el('btn-export-csv')?.addEventListener('click', exportCsv);

  // About page
  el('btn-about')?.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL('about.html') });
  });
}

async function saveSetting(key, value) {
  settings[key] = value;
  await saveSettings({ [key]: value });
}

// ─── CSV Export ───────────────────────────────────────────────────────────────

function exportCsv() {
  const rows = [
    ['Metric', 'Value'],
    ['Total Muted (seconds)', stats[STORAGE_KEYS.STATS_MUTED_SECONDS] || 0],
    ['Mute Segments', stats[STORAGE_KEYS.STATS_MUTE_COUNT] || 0],
    ['Videos Processed', stats[STORAGE_KEYS.STATS_VIDEOS_PROCESSED] || 0],
    [''],
    ['Platform', 'Muted Seconds'],
    ['YouTube', statsByPlatform.youtube || 0],
    ['Instagram', statsByPlatform.instagram || 0],
    ['Facebook', statsByPlatform.facebook || 0],
    ['TikTok', statsByPlatform.tiktok || 0],
  ];

  const csv = rows.map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `sakina-stats-${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function el(id) { return document.getElementById(id); }

function formatTime(seconds) {
  if (!seconds || seconds < 1) return '0s';
  if (seconds < 60) return Math.round(seconds) + 's';
  if (seconds < 3600) return Math.round(seconds / 60) + 'm';
  return (seconds / 3600).toFixed(1) + 'h';
}

function formatDuration(seconds) {
  if (!seconds || seconds < 1) return '0s';
  return Math.round(seconds) + 's';
}

function formatTimeAgo(timestamp) {
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);

  if (mins < 1) return t('time_just_now') || 'just now';
  if (mins < 60) return `${mins}m ${t('time_ago') || 'ago'}`;
  if (hours < 24) return `${hours}h ${t('time_ago') || 'ago'}`;
  return t('time_over_24h') || '24h+ ago';
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ─── Start ────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);
