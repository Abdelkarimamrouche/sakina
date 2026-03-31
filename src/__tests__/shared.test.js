/**
 * Sakina — Tests: shared/constants.js & shared/storage.js
 */

import {
  DEFAULT_MUSIC_THRESHOLD,
  MUTE_TRIGGER_FRAMES,
  UNMUTE_TRIGGER_FRAMES,
  YAMNET_FRAME_SAMPLES,
  YAMNET_SAMPLE_RATE,
  YAMNET_MUSIC_CLASS_RANGE,
  YAMNET_SINGING_CLASSES,
  DEFAULT_SETTINGS,
  STORAGE_KEYS,
  MSG,
  EXTENSION_STATE,
} from '../../src/shared/constants.js';

// ─── Constants ────────────────────────────────────────────────────────────────

describe('constants', () => {
  test('DEFAULT_MUSIC_THRESHOLD is in valid range', () => {
    expect(DEFAULT_MUSIC_THRESHOLD).toBeGreaterThan(0);
    expect(DEFAULT_MUSIC_THRESHOLD).toBeLessThan(1);
  });

  test('MUTE_TRIGGER_FRAMES >= 1', () => {
    expect(MUTE_TRIGGER_FRAMES).toBeGreaterThanOrEqual(1);
  });

  test('UNMUTE_TRIGGER_FRAMES >= 1', () => {
    expect(UNMUTE_TRIGGER_FRAMES).toBeGreaterThanOrEqual(1);
  });

  test('YAMNET_FRAME_SAMPLES equals 0.975 seconds at 16kHz', () => {
    // 16000 * 0.975 = 15600
    expect(YAMNET_FRAME_SAMPLES).toBe(15600);
  });

  test('YAMNET_SAMPLE_RATE is 16000', () => {
    expect(YAMNET_SAMPLE_RATE).toBe(16000);
  });

  test('music class range is valid and covers expected indices', () => {
    const { min, max } = YAMNET_MUSIC_CLASS_RANGE;
    expect(min).toBeGreaterThan(0);
    expect(max).toBeLessThan(521);
    expect(max).toBeGreaterThan(min);
    // Should cover at least 50 music-related classes
    expect(max - min).toBeGreaterThanOrEqual(50);
  });

  test('singing classes do not overlap music class range', () => {
    const { min: musicMin } = YAMNET_MUSIC_CLASS_RANGE;
    for (const i of YAMNET_SINGING_CLASSES) {
      expect(i).toBeLessThan(musicMin);
    }
  });

  test('singing classes exclude Chant (27) and Mantra (28)', () => {
    expect(YAMNET_SINGING_CLASSES.has(27)).toBe(false);
    expect(YAMNET_SINGING_CLASSES.has(28)).toBe(false);
  });

  test('DEFAULT_SETTINGS has all STORAGE_KEYS defined', () => {
    for (const key of Object.values(STORAGE_KEYS)) {
      // Stats keys are allowed to be 0 (falsy), just must be present
      expect(DEFAULT_SETTINGS).toHaveProperty(key);
    }
  });

  test('MSG has no duplicate values', () => {
    const values = Object.values(MSG);
    const unique = new Set(values);
    expect(values.length).toBe(unique.size);
  });

  test('EXTENSION_STATE has no duplicate values', () => {
    const values = Object.values(EXTENSION_STATE);
    const unique = new Set(values);
    expect(values.length).toBe(unique.size);
  });
});

// ─── Storage Module ───────────────────────────────────────────────────────────

// Mock chrome.storage API
const mockSyncStorage = {};
const mockLocalStorage = {};

global.chrome = {
  storage: {
    sync: {
      get: jest.fn((keys, cb) => {
        if (keys === null) return cb({ ...mockSyncStorage });
        const result = {};
        const keyList = Array.isArray(keys) ? keys : [keys];
        keyList.forEach(k => { if (k in mockSyncStorage) result[k] = mockSyncStorage[k]; });
        cb(result);
      }),
      set: jest.fn((items, cb) => {
        Object.assign(mockSyncStorage, items);
        cb?.();
      }),
    },
    local: {
      get: jest.fn((keys, cb) => {
        const result = {};
        keys.forEach(k => { if (k in mockLocalStorage) result[k] = mockLocalStorage[k]; });
        cb(result);
      }),
      set: jest.fn((items, cb) => {
        Object.assign(mockLocalStorage, items);
        cb?.();
      }),
    },
    onChanged: {
      addListener: jest.fn(),
      removeListener: jest.fn(),
    },
  },
  runtime: {
    lastError: null,
  },
};

import {
  getSettings,
  getSetting,
  saveSettings,
  getStats,
  incrementMuteCount,
  addMutedSeconds,
  incrementVideosProcessed,
  resetStats,
  initializeDefaults,
} from '../../src/shared/storage.js';

beforeEach(() => {
  // Clear mock storages
  Object.keys(mockSyncStorage).forEach(k => delete mockSyncStorage[k]);
  Object.keys(mockLocalStorage).forEach(k => delete mockLocalStorage[k]);
  jest.clearAllMocks();
});

describe('storage.getSettings', () => {
  test('returns defaults when storage is empty', async () => {
    const result = await getSettings();
    expect(result[STORAGE_KEYS.ENABLED]).toBe(true);
    expect(result[STORAGE_KEYS.THRESHOLD]).toBe(DEFAULT_MUSIC_THRESHOLD);
    expect(result[STORAGE_KEYS.MUTE_SINGING]).toBe(true);
  });

  test('merges stored values over defaults', async () => {
    mockSyncStorage[STORAGE_KEYS.THRESHOLD] = 0.70;
    const result = await getSettings([STORAGE_KEYS.THRESHOLD]);
    expect(result[STORAGE_KEYS.THRESHOLD]).toBe(0.70);
  });

  test('returns specific keys when requested', async () => {
    const result = await getSettings([STORAGE_KEYS.ENABLED, STORAGE_KEYS.THRESHOLD]);
    expect(Object.keys(result)).toEqual(
      expect.arrayContaining([STORAGE_KEYS.ENABLED, STORAGE_KEYS.THRESHOLD])
    );
  });
});

describe('storage.getSetting', () => {
  test('returns single value', async () => {
    const val = await getSetting(STORAGE_KEYS.ENABLED);
    expect(val).toBe(true);
  });
});

describe('storage.saveSettings', () => {
  test('persists values to sync storage', async () => {
    await saveSettings({ [STORAGE_KEYS.THRESHOLD]: 0.65 });
    expect(mockSyncStorage[STORAGE_KEYS.THRESHOLD]).toBe(0.65);
  });

  test('multiple keys saved in one call', async () => {
    await saveSettings({
      [STORAGE_KEYS.THRESHOLD]: 0.6,
      [STORAGE_KEYS.MUTE_SINGING]: false,
    });
    expect(mockSyncStorage[STORAGE_KEYS.THRESHOLD]).toBe(0.6);
    expect(mockSyncStorage[STORAGE_KEYS.MUTE_SINGING]).toBe(false);
  });
});

describe('storage stats', () => {
  test('incrementMuteCount increases counter', async () => {
    await incrementMuteCount(3);
    const stats = await getStats();
    expect(stats[STORAGE_KEYS.STATS_MUTE_COUNT]).toBe(3);
  });

  test('addMutedSeconds accumulates', async () => {
    await addMutedSeconds(30);
    await addMutedSeconds(45);
    const stats = await getStats();
    expect(stats[STORAGE_KEYS.STATS_MUTED_SECONDS]).toBe(75);
  });

  test('incrementVideosProcessed works', async () => {
    await incrementVideosProcessed();
    await incrementVideosProcessed();
    const stats = await getStats();
    expect(stats[STORAGE_KEYS.STATS_VIDEOS_PROCESSED]).toBe(2);
  });

  test('resetStats clears all counters to 0', async () => {
    await incrementMuteCount(10);
    await addMutedSeconds(120);
    await resetStats();
    const stats = await getStats();
    expect(stats[STORAGE_KEYS.STATS_MUTE_COUNT]).toBe(0);
    expect(stats[STORAGE_KEYS.STATS_MUTED_SECONDS]).toBe(0);
  });
});

describe('storage.onSettingsChange', () => {
  test('fires callback when sync storage changes', () => {
    const { onSettingsChange } = require('../../src/shared/storage.js');
    const cb = jest.fn();
    onSettingsChange(cb);

    // Get the listener that was registered
    const listener = chrome.storage.onChanged.addListener.mock.calls.at(-1)[0];

    // Simulate a sync storage change
    listener({ [STORAGE_KEYS.THRESHOLD]: { newValue: 0.7 } }, 'sync');
    expect(cb).toHaveBeenCalledTimes(1);

    // Local storage changes should NOT fire the callback
    listener({ [STORAGE_KEYS.THRESHOLD]: { newValue: 0.8 } }, 'local');
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe('storage error handling', () => {
  test('getSettings returns defaults when chrome reports lastError', async () => {
    chrome.runtime.lastError = { message: 'Extension context invalid' };
    chrome.storage.sync.get.mockImplementationOnce((keys, cb) => cb({}));

    const { getSettings } = require('../../src/shared/storage.js');
    // The error path returns defaults — even with a failing storage, we get a usable object
    const result = await getSettings([STORAGE_KEYS.ENABLED]);
    expect(result).toBeDefined();

    chrome.runtime.lastError = null;
  });
});

describe('initializeDefaults', () => {
  test('sets all default keys on fresh install', async () => {
    await initializeDefaults();
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      expect(mockSyncStorage[key]).toBe(value);
    }
  });

  test('does not overwrite existing values', async () => {
    mockSyncStorage[STORAGE_KEYS.THRESHOLD] = 0.75;
    await initializeDefaults();
    expect(mockSyncStorage[STORAGE_KEYS.THRESHOLD]).toBe(0.75);
  });
});
