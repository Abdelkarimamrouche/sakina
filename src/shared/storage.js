/**
 * Sakina — Storage Module
 *
 * Typed wrapper around chrome.storage.sync with local fallback.
 * All persistence goes through here — never call chrome.storage directly.
 *
 * Uses chrome.storage.sync so settings roam across devices.
 * Stats use chrome.storage.local (large values, no sync limit concern).
 */

import { DEFAULT_SETTINGS, STORAGE_KEYS } from './constants.js';

// ─── Core Storage Access ─────────────────────────────────────────────────────

/**
 * Get one or multiple settings values.
 * Automatically merges with defaults so callers never get undefined.
 *
 * @param {string|string[]|null} keys - Key(s) to fetch, or null for all
 * @returns {Promise<object>}
 */
export async function getSettings(keys = null) {
  return new Promise((resolve) => {
    const request = keys ? (Array.isArray(keys) ? keys : [keys]) : null;
    chrome.storage.sync.get(request, (result) => {
      if (chrome.runtime.lastError) {
        console.warn('[Sakina:storage] sync read failed, using defaults:', chrome.runtime.lastError);
        resolve(request ? Object.fromEntries(request.map(k => [k, DEFAULT_SETTINGS[k]])) : { ...DEFAULT_SETTINGS });
        return;
      }
      // Merge with defaults to ensure all keys are present
      const defaults = request
        ? Object.fromEntries(request.map(k => [k, DEFAULT_SETTINGS[k]]))
        : { ...DEFAULT_SETTINGS };
      resolve({ ...defaults, ...result });
    });
  });
}

/**
 * Get a single typed setting value.
 *
 * @param {string} key
 * @returns {Promise<any>}
 */
export async function getSetting(key) {
  const result = await getSettings([key]);
  return result[key];
}

/**
 * Save one or multiple settings.
 *
 * @param {object} updates - Key/value pairs to persist
 * @returns {Promise<void>}
 */
export async function saveSettings(updates) {
  return new Promise((resolve, reject) => {
    chrome.storage.sync.set(updates, () => {
      if (chrome.runtime.lastError) {
        console.error('[Sakina:storage] sync write failed:', chrome.runtime.lastError);
        reject(chrome.runtime.lastError);
        return;
      }
      resolve();
    });
  });
}

// ─── Statistics (local storage — larger data, no sync needed) ────────────────

/**
 * Increment the mute counter by count.
 * @param {number} count
 */
export async function incrementMuteCount(count = 1) {
  const stats = await getStats();
  await saveStats({
    ...stats,
    [STORAGE_KEYS.STATS_MUTE_COUNT]: (stats[STORAGE_KEYS.STATS_MUTE_COUNT] || 0) + count,
  });
}

/**
 * Add seconds to total muted time.
 * @param {number} seconds
 */
export async function addMutedSeconds(seconds) {
  const stats = await getStats();
  await saveStats({
    ...stats,
    [STORAGE_KEYS.STATS_MUTED_SECONDS]: (stats[STORAGE_KEYS.STATS_MUTED_SECONDS] || 0) + seconds,
  });
}

/**
 * Increment videos processed counter.
 */
export async function incrementVideosProcessed() {
  const stats = await getStats();
  await saveStats({
    ...stats,
    [STORAGE_KEYS.STATS_VIDEOS_PROCESSED]: (stats[STORAGE_KEYS.STATS_VIDEOS_PROCESSED] || 0) + 1,
  });
}

export async function getStats() {
  return new Promise((resolve) => {
    const keys = [
      STORAGE_KEYS.STATS_MUTE_COUNT,
      STORAGE_KEYS.STATS_MUTED_SECONDS,
      STORAGE_KEYS.STATS_VIDEOS_PROCESSED,
    ];
    chrome.storage.local.get(keys, (result) => {
      resolve({
        [STORAGE_KEYS.STATS_MUTE_COUNT]: 0,
        [STORAGE_KEYS.STATS_MUTED_SECONDS]: 0,
        [STORAGE_KEYS.STATS_VIDEOS_PROCESSED]: 0,
        ...result,
      });
    });
  });
}

async function saveStats(stats) {
  return new Promise((resolve) => {
    chrome.storage.local.set(stats, resolve);
  });
}

export async function resetStats() {
  return new Promise((resolve) => {
    chrome.storage.local.set({
      [STORAGE_KEYS.STATS_MUTE_COUNT]: 0,
      [STORAGE_KEYS.STATS_MUTED_SECONDS]: 0,
      [STORAGE_KEYS.STATS_VIDEOS_PROCESSED]: 0,
      [STORAGE_KEYS.STATS_BY_PLATFORM]: { youtube: 0, instagram: 0, facebook: 0, tiktok: 0 },
      [STORAGE_KEYS.ACTIVITY_LOG]: [],
    }, resolve);
  });
}

// ─── Activity Log ─────────────────────────────────────────────────────────────

const MAX_ACTIVITY_ENTRIES = 50;
const ACTIVITY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Get activity log entries (last 24h only).
 * @returns {Promise<Array<{platform: string, timestamp: number, durationSeconds: number}>>}
 */
export async function getActivityLog() {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEYS.ACTIVITY_LOG], (result) => {
      const log = result[STORAGE_KEYS.ACTIVITY_LOG] || [];
      const cutoff = Date.now() - ACTIVITY_TTL_MS;
      resolve(log.filter(entry => entry.timestamp > cutoff));
    });
  });
}

/**
 * Add an activity entry.
 * @param {string} platform - youtube, instagram, facebook, tiktok
 * @param {number} durationSeconds - how long was muted
 */
export async function addActivityEntry(platform, durationSeconds) {
  const log = await getActivityLog();
  log.unshift({
    platform,
    timestamp: Date.now(),
    durationSeconds: Math.round(durationSeconds),
  });
  // Keep only last MAX_ACTIVITY_ENTRIES
  const trimmed = log.slice(0, MAX_ACTIVITY_ENTRIES);
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEYS.ACTIVITY_LOG]: trimmed }, resolve);
  });
}

/**
 * Clear activity log.
 */
export async function clearActivityLog() {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEYS.ACTIVITY_LOG]: [] }, resolve);
  });
}

// ─── Allowlist ────────────────────────────────────────────────────────────────

/**
 * Get list of URLs/patterns to never mute.
 * @returns {Promise<string[]>}
 */
export async function getAllowlist() {
  return new Promise((resolve) => {
    chrome.storage.sync.get([STORAGE_KEYS.ALLOWLIST], (result) => {
      resolve(result[STORAGE_KEYS.ALLOWLIST] || []);
    });
  });
}

/**
 * Save allowlist.
 * @param {string[]} list
 */
export async function saveAllowlist(list) {
  return new Promise((resolve, reject) => {
    chrome.storage.sync.set({ [STORAGE_KEYS.ALLOWLIST]: list }, () => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
        return;
      }
      resolve();
    });
  });
}

/**
 * Add a URL pattern to allowlist.
 * @param {string} pattern
 */
export async function addToAllowlist(pattern) {
  const list = await getAllowlist();
  if (!list.includes(pattern)) {
    list.push(pattern);
    await saveAllowlist(list);
  }
}

/**
 * Remove a URL pattern from allowlist.
 * @param {string} pattern
 */
export async function removeFromAllowlist(pattern) {
  const list = await getAllowlist();
  const filtered = list.filter(p => p !== pattern);
  await saveAllowlist(filtered);
}

// ─── Stats by Platform ────────────────────────────────────────────────────────

/**
 * Get stats broken down by platform.
 * @returns {Promise<{youtube: number, instagram: number, facebook: number, tiktok: number}>}
 */
export async function getStatsByPlatform() {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEYS.STATS_BY_PLATFORM], (result) => {
      resolve(result[STORAGE_KEYS.STATS_BY_PLATFORM] || {
        youtube: 0, instagram: 0, facebook: 0, tiktok: 0
      });
    });
  });
}

/**
 * Add muted seconds to a specific platform.
 * @param {string} platform
 * @param {number} seconds
 */
export async function addPlatformMutedSeconds(platform, seconds) {
  const stats = await getStatsByPlatform();
  const key = platform.toLowerCase();
  if (key in stats) {
    stats[key] += seconds;
  }
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEYS.STATS_BY_PLATFORM]: stats }, resolve);
  });
}

// ─── Change Listener ─────────────────────────────────────────────────────────

/**
 * Subscribe to storage changes.
 * @param {function} callback - Called with (changes, areaName)
 * @returns {function} Unsubscribe function
 */
export function onSettingsChange(callback) {
  const listener = (changes, areaName) => {
    if (areaName === 'sync') {
      callback(changes, areaName);
    }
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

// ─── Initialize Defaults ─────────────────────────────────────────────────────

/**
 * Called once on install to set default values.
 * Only sets keys that don't already exist.
 */
export async function initializeDefaults() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(null, (existing) => {
      const missing = {};
      for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (!(key in existing)) {
          missing[key] = value;
        }
      }
      if (Object.keys(missing).length > 0) {
        chrome.storage.sync.set(missing, resolve);
      } else {
        resolve();
      }
    });
  });
}
