/**
 * Sakina — Shared Constants
 * Single source of truth for all configuration values used across
 * background, content scripts, popup, and options.
 */

// ─── Audio Classification ────────────────────────────────────────────────────

/**
 * YAMNet class indices that represent music.
 * Covers all music/instrument classes in the 521-class YAMNet taxonomy.
 * Range 137–272 covers instruments, music genres, and song types.
 * Range 71–79 covers singing (treated as music by default, user-configurable).
 *
 * Full class map: https://github.com/tensorflow/models/blob/master/research/audioset/yamnet/yamnet_class_map.csv
 */
export const YAMNET_MUSIC_CLASS_RANGE = { min: 132, max: 276 };
// Excludes 27 (Chant) and 28 (Mantra) — these capture religious
// recitation (Quran, prayers, etc.) which should not be muted.
export const YAMNET_SINGING_CLASSES = new Set([24, 25, 26, 29, 30]);

/** YAMNet requires 16kHz mono audio input */
export const YAMNET_SAMPLE_RATE = 16000;

/** YAMNet frame size in samples at 16kHz (0.975 seconds) */
export const YAMNET_FRAME_SAMPLES = 15600;

/** Minimum confidence score (0–1) to classify audio as music */
export const DEFAULT_MUSIC_THRESHOLD = 0.45;

// ─── Smoothing & Debounce ────────────────────────────────────────────────────

/**
 * Number of consecutive frames classified as music before muting.
 * At ~1s per frame, 1 frame = instant mute on first detection.
 */
export const MUTE_TRIGGER_FRAMES = 1;

/**
 * Number of consecutive non-music frames before unmuting.
 * Prevents rapid mute/unmute oscillation.
 * At ~1s per frame, 3 frames = ~3 seconds of silence before unmuting.
 */
export const UNMUTE_TRIGGER_FRAMES = 3;

/** Gain fade duration in seconds (smooth mute/unmute transition) */
export const GAIN_FADE_DURATION = 0.15;

// ─── Audio Pipeline ──────────────────────────────────────────────────────────

/** ScriptProcessorNode buffer size (power of 2, 256–16384) */
export const AUDIO_BUFFER_SIZE = 4096;

/** How many source samples to accumulate before resampling and classifying.
 * 1 = classify every ~1s YAMNet frame with minimal delay. */
export const ACCUMULATE_SAMPLE_MULTIPLIER = 1;

// ─── Storage Keys ────────────────────────────────────────────────────────────

export const STORAGE_KEYS = {
  ENABLED: 'enabled',
  THRESHOLD: 'musicThreshold',
  MUTE_SINGING: 'muteSinging',
  MUTE_ADS: 'muteAds',
  SHOW_BADGE: 'showBadge',
  STATS_MUTE_COUNT: 'statsMuteCount',
  STATS_MUTED_SECONDS: 'statsMutedSeconds',
  STATS_VIDEOS_PROCESSED: 'statsVideosProcessed',
  ONBOARDING_DONE: 'onboardingDone',
  MODEL_CACHED: 'modelCached',
  // Platform-specific toggles
  ENABLED_YOUTUBE: 'enabledYouTube',
  ENABLED_INSTAGRAM: 'enabledInstagram',
  ENABLED_FACEBOOK: 'enabledFacebook',
  ENABLED_TIKTOK: 'enabledTikTok',
  // Advanced settings
  ALLOWLIST: 'allowlist',
  ACTIVITY_LOG: 'activityLog',
  // Stats by platform
  STATS_BY_PLATFORM: 'statsByPlatform',
};

// ─── Default Settings ────────────────────────────────────────────────────────

export const DEFAULT_SETTINGS = {
  [STORAGE_KEYS.ENABLED]: true,
  [STORAGE_KEYS.THRESHOLD]: DEFAULT_MUSIC_THRESHOLD,
  [STORAGE_KEYS.MUTE_SINGING]: true,
  [STORAGE_KEYS.MUTE_ADS]: false,
  [STORAGE_KEYS.SHOW_BADGE]: true,
  [STORAGE_KEYS.STATS_MUTE_COUNT]: 0,
  [STORAGE_KEYS.STATS_MUTED_SECONDS]: 0,
  [STORAGE_KEYS.STATS_VIDEOS_PROCESSED]: 0,
  [STORAGE_KEYS.ONBOARDING_DONE]: false,
  [STORAGE_KEYS.MODEL_CACHED]: false,
  // Platform toggles (all enabled by default)
  [STORAGE_KEYS.ENABLED_YOUTUBE]: true,
  [STORAGE_KEYS.ENABLED_INSTAGRAM]: true,
  [STORAGE_KEYS.ENABLED_FACEBOOK]: true,
  [STORAGE_KEYS.ENABLED_TIKTOK]: true,
};

// ─── Message Types ────────────────────────────────────────────────────────────

export const MSG = {
  // Content → Background
  CLASSIFIER_STATUS: 'classifier:status',
  MUTE_STATE_CHANGED: 'mute:stateChanged',
  VIDEO_STARTED: 'video:started',
  VIDEO_ENDED: 'video:ended',

  // Background → Content
  SETTINGS_CHANGED: 'settings:changed',
  TOGGLE_EXTENSION: 'extension:toggle',

  // Popup → Background
  GET_TAB_STATE: 'tab:getState',
  GET_SETTINGS: 'settings:get',
  SET_SETTINGS: 'settings:set',
  RESET_STATS: 'stats:reset',
};

// ─── Extension States ────────────────────────────────────────────────────────

export const EXTENSION_STATE = {
  LOADING: 'loading',
  READY: 'ready',
  MUTED: 'muted',
  LISTENING: 'listening',
  DISABLED: 'disabled',
  ERROR: 'error',
};

// ─── YAMNet Model ─────────────────────────────────────────────────────────────

// Bundled locally for instant loading — no network dependency.
// Uses a getter to defer chrome.runtime.getURL() until first access (avoids
// breaking in test environments where the chrome global isn't available at import time).
let _yamnetModelUrl;
export function getYamnetModelUrl() {
  if (!_yamnetModelUrl) {
    _yamnetModelUrl = chrome.runtime.getURL('yamnet/model.json');
  }
  return _yamnetModelUrl;
}

// ─── Platform Name → Storage Key Mapping ─────────────────────────────────────

export const PLATFORM_TO_STORAGE_KEY = {
  youtube:   STORAGE_KEYS.ENABLED_YOUTUBE,
  instagram: STORAGE_KEYS.ENABLED_INSTAGRAM,
  facebook:  STORAGE_KEYS.ENABLED_FACEBOOK,
  tiktok:    STORAGE_KEYS.ENABLED_TIKTOK,
};

// ─── Misc ─────────────────────────────────────────────────────────────────────

export const EXTENSION_VERSION = '1.3.0';
export const MIN_VIDEO_DURATION_SECONDS = 3; // Don't process very short clips
