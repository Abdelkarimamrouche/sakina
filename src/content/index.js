/**
 * Sakina — Content Script
 *
 * Injected into YouTube, Instagram, Facebook, and TikTok tabs.
 * Orchestrates the full pipeline:
 *   1. Detects the current platform via platforms.js adapter
 *   2. Detects video element and play events (platform-agnostic)
 *   3. Loads YAMNet model (lazy, first play only)
 *   4. Wires AudioPipeline + MuteController
 *   5. Handles SPA navigation for all platforms
 *   6. Communicates state to background service worker
 *   7. Responds to settings changes from popup
 *
 * Each platform uses a different SPA navigation pattern and video
 * selector — all of that is encapsulated in platforms.js adapters.
 */

import { AudioPipeline } from './AudioPipeline.js';
import { YamNetClassifier } from './YamNetClassifier.js';
import { MuteController } from './MuteController.js';
import { detectPlatform, waitForVideo, findBestVideo } from './platforms.js';
import {
  getSettings, onSettingsChange,
  addMutedSeconds, incrementMuteCount, incrementVideosProcessed,
  getAllowlist, addActivityEntry, addPlatformMutedSeconds,
} from '../shared/storage.js';
import { MSG, EXTENSION_STATE, STORAGE_KEYS, PLATFORM_TO_STORAGE_KEY, MIN_VIDEO_DURATION_SECONDS } from '../shared/constants.js';

// ─── Module-level State ───────────────────────────────────────────────────────

/** Single classifier instance — shared across video sessions */
const classifier = new YamNetClassifier();

/** Current active pipeline (recreated per video) */
let pipeline = null;

/** Current mute controller */
let controller = null;

/** Current settings */
let settings = {};

/** Whether extension is enabled */
let isEnabled = true;

/** Whether we're currently initialized on a video */
let isActive = false;

/** Last video element we attached to */
let lastVideoEl = null;

/** Stats flush interval handle */
let statsFlushInterval = null;

/** MutationObserver watching for video element changes */
let videoObserver = null;

/** Platform adapter for the current tab */
let platform = null;

/** Cleanup function returned by platform.setupNavigation() */
let removeNavListeners = null;

/** Allowlist of URLs/patterns to never mute */
let allowlist = [];

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function bootstrap() {
  // Detect which platform we're on. If unsupported, bail out silently.
  platform = detectPlatform();
  if (!platform) {
    console.info('[Sakina] Unsupported platform, exiting.');
    return;
  }

  console.info(`[Sakina] Loaded on ${platform.name}:`, location.href);

  [settings, allowlist] = await Promise.all([getSettings(), getAllowlist()]);
  isEnabled = settings[STORAGE_KEYS.ENABLED];

  if (!isEnabled) {
    console.info('[Sakina] Extension disabled, standing by.');
    return;
  }

  // Check if this platform is enabled
  const platformKey = PLATFORM_TO_STORAGE_KEY[platform.name.toLowerCase()];
  if (platformKey && settings[platformKey] === false) {
    console.info(`[Sakina] ${platform.name} is disabled in settings, standing by.`);
    return;
  }

  // Check if current URL is in allowlist
  if (isUrlAllowlisted(location.href)) {
    console.info('[Sakina] URL is allowlisted, standing by.');
    return;
  }

  // Register SPA navigation listener (platform-specific).
  removeNavListeners = platform.setupNavigation(onNavigation);

  // Watch for settings changes from popup.
  onSettingsChange(handleSettingsChange);

  // Listen for messages from background / popup.
  chrome.runtime.onMessage.addListener(handleMessage);

  // Initial setup if there's already a video page loaded.
  if (platform.isVideoPage()) {
    await setupForCurrentPage();
  }
}

// ─── SPA Navigation ───────────────────────────────────────────────────────────

async function onNavigation() {
  console.info(`[Sakina:${platform.name}] Navigation →`, location.href);
  await teardown();

  if (platform.isVideoPage() && isEnabled) {
    // Brief delay so the platform can finish rendering the new video element.
    setTimeout(setupForCurrentPage, 350);
  }
}

// ─── Page Setup ───────────────────────────────────────────────────────────────

async function setupForCurrentPage() {
  if (isActive) return;

  const videoEl = await waitForVideo(platform);
  if (!videoEl) {
    console.warn(`[Sakina:${platform.name}] No video element found.`);
    return;
  }

  if (videoEl === lastVideoEl && isActive) return;

  lastVideoEl = videoEl;

  // Skip very short clips.
  if (videoEl.duration && videoEl.duration < MIN_VIDEO_DURATION_SECONDS) {
    console.info(`[Sakina:${platform.name}] Skipping short video (${videoEl.duration}s)`);
    return;
  }

  console.info(`[Sakina:${platform.name}] Attaching to video. Duration:`, videoEl.duration);

  // ── Load YAMNet (lazy) ──────────────────────────────────────────────────────
  if (!classifier.isReady && !classifier.isLoading) {
    reportStatus(EXTENSION_STATE.LOADING);
    try {
      await classifier.load();
    } catch (err) {
      reportStatus(EXTENSION_STATE.ERROR);
      console.error('[Sakina] Failed to load classifier:', err);
      return;
    }
  } else if (classifier.isLoading) {
    reportStatus(EXTENSION_STATE.LOADING);
    await new Promise(resolve => {
      const check = setInterval(() => {
        if (!classifier.isLoading) { clearInterval(check); resolve(); }
      }, 200);
    });
    if (!classifier.isReady) return;
  }

  classifier.updateSettings({
    threshold: settings[STORAGE_KEYS.THRESHOLD],
    muteSinging: settings[STORAGE_KEYS.MUTE_SINGING],
  });

  // ── Wire AudioPipeline ─────────────────────────────────────────────────────
  pipeline = new AudioPipeline(videoEl);

  pipeline.onAudioChunk = async (frame) => {
    if (!isEnabled || !controller) return;
    try {
      const result = await classifier.classify(frame);
      controller.processResult(result);
    } catch (err) {
      if (isActive) console.warn('[Sakina] Classification error:', err.message);
    }
  };

  // ── Wire MuteController ────────────────────────────────────────────────────
  controller = new MuteController(pipeline, classifier);

  controller.onStateChange = (state) => {
    reportStatus(state);
    updateBadge(state);
  };

  controller.onClassification = ({ isMusic, confidence, topClass }) => {
    if (process.env.NODE_ENV === 'development') {
      console.debug(
        `[Sakina:${platform.name}] ${isMusic ? '🎵' : '💬'} ${topClass} (${(confidence * 100).toFixed(1)}%)`
      );
    }
  };

  // ── Initialize pipeline on first play ─────────────────────────────────────
  const initPipeline = async () => {
    try {
      await pipeline.initialize();
      isActive = true;
      incrementVideosProcessed();
      reportStatus(EXTENSION_STATE.READY);
    } catch (err) {
      console.error('[Sakina] Pipeline init failed:', err);
      reportStatus(EXTENSION_STATE.ERROR);
    }
  };

  console.info(`[Sakina:${platform.name}] Video paused=${videoEl.paused}, readyState=${videoEl.readyState}, src=${videoEl.src?.substring(0, 60) || videoEl.currentSrc?.substring(0, 60) || 'none'}`);

  if (!videoEl.paused) {
    await initPipeline();
  } else {
    // Listen for both 'play' and 'playing' — some platforms (TikTok)
    // may start playback without firing 'play' reliably.
    const onceInit = () => {
      videoEl.removeEventListener('play', onceInit);
      videoEl.removeEventListener('playing', onceInit);
      clearTimeout(fallbackTimer);
      initPipeline();
    };
    videoEl.addEventListener('play', onceInit, { once: true });
    videoEl.addEventListener('playing', onceInit, { once: true });

    // Fallback: poll every 500ms for up to 5s — TikTok may swap or
    // start the video element late.
    let fallbackAttempts = 0;
    const fallbackTimer = setInterval(() => {
      fallbackAttempts++;
      const v = videoEl.paused ? findBestVideo(platform) : videoEl;
      if (v && !v.paused) {
        clearInterval(fallbackTimer);
        videoEl.removeEventListener('play', onceInit);
        videoEl.removeEventListener('playing', onceInit);
        if (v !== videoEl) {
          console.info(`[Sakina:${platform.name}] Fallback found a different playing video`);
          pipeline._video = v;
          lastVideoEl = v;
        }
        initPipeline();
      } else if (fallbackAttempts >= 10) {
        clearInterval(fallbackTimer);
        console.warn(`[Sakina:${platform.name}] Fallback: no playing video found after 5s`);
      }
    }, 500);
  }

  watchVideoElement();
  startStatsFlush();
}

// ─── Stats Flushing ───────────────────────────────────────────────────────────

function startStatsFlush() {
  clearInterval(statsFlushInterval);
  statsFlushInterval = setInterval(async () => {
    if (!controller) return;
    const { totalMutedSeconds, muteSegmentCount } = controller.getSessionStats();
    if (totalMutedSeconds > 0) {
      await addMutedSeconds(totalMutedSeconds);
      if (muteSegmentCount > 0) await incrementMuteCount(muteSegmentCount);
    }
  }, 30_000);
}

// ─── Video Element Watcher ────────────────────────────────────────────────────

/**
 * Watch for the platform swapping out the video element under us.
 * This is common on TikTok (scroll) and YouTube Shorts (swipe).
 */
function watchVideoElement() {
  if (videoObserver) {
    videoObserver.disconnect();
    videoObserver = null;
  }

  videoObserver = new MutationObserver(async () => {
    const currentVideo = findBestVideo(platform);
    if (currentVideo && currentVideo !== lastVideoEl) {
      console.info(`[Sakina:${platform.name}] Video element swapped, reinitializing…`);
      await teardown();
      setTimeout(setupForCurrentPage, 100);
    }
  });

  const container =
    document.querySelector(platform.playerContainerSelector) ?? document.body;

  videoObserver.observe(container, { childList: true, subtree: true });
}

// ─── Teardown ─────────────────────────────────────────────────────────────────

async function teardown() {
  clearInterval(statsFlushInterval);
  statsFlushInterval = null;

  if (videoObserver) {
    videoObserver.disconnect();
    videoObserver = null;
  }

  if (controller) {
    const { totalMutedSeconds, muteSegmentCount } = controller.getSessionStats();
    if (totalMutedSeconds > 0) {
      await addMutedSeconds(totalMutedSeconds);
      // Log activity and platform-specific stats
      if (platform) {
        await addActivityEntry(platform.name.toLowerCase(), totalMutedSeconds);
        await addPlatformMutedSeconds(platform.name.toLowerCase(), totalMutedSeconds);
      }
    }
    if (muteSegmentCount > 0) await incrementMuteCount(muteSegmentCount);
    controller.reset();
    controller = null;
  }

  if (pipeline) {
    pipeline.destroy();
    pipeline = null;
  }

  isActive    = false;
  lastVideoEl = null;
}

// ─── Settings Changes ─────────────────────────────────────────────────────────

function handleSettingsChange(changes) {
  let needsClassifierUpdate = false;

  if (STORAGE_KEYS.ENABLED in changes) {
    isEnabled = changes[STORAGE_KEYS.ENABLED].newValue;
    if (!isEnabled) {
      pipeline?.unmute();
      reportStatus(EXTENSION_STATE.DISABLED);
    } else {
      reportStatus(EXTENSION_STATE.READY);
      if (!isActive) setupForCurrentPage();
    }
  }

  if (STORAGE_KEYS.THRESHOLD in changes) {
    settings[STORAGE_KEYS.THRESHOLD] = changes[STORAGE_KEYS.THRESHOLD].newValue;
    needsClassifierUpdate = true;
  }

  if (STORAGE_KEYS.MUTE_SINGING in changes) {
    settings[STORAGE_KEYS.MUTE_SINGING] = changes[STORAGE_KEYS.MUTE_SINGING].newValue;
    needsClassifierUpdate = true;
  }

  if (needsClassifierUpdate && classifier.isReady) {
    classifier.updateSettings({
      threshold: settings[STORAGE_KEYS.THRESHOLD],
      muteSinging: settings[STORAGE_KEYS.MUTE_SINGING],
    });
  }
}

// ─── Message Handler ──────────────────────────────────────────────────────────

function handleMessage(message, sender, sendResponse) {
  switch (message.type) {
    case MSG.TOGGLE_EXTENSION:
      isEnabled = message.enabled;
      if (!isEnabled && pipeline?.isMuted) pipeline.unmute();
      sendResponse({ ok: true });
      break;

    case MSG.GET_TAB_STATE:
      sendResponse({
        isActive,
        isEnabled,
        platform: platform?.name ?? 'Unknown',
        isMuted: pipeline?.isMuted ?? false,
        classifierReady: classifier.isReady,
        classifierLoading: classifier.isLoading,
        state: controller?.state ?? (isEnabled ? EXTENSION_STATE.READY : EXTENSION_STATE.DISABLED),
        stats: controller?.getSessionStats() ?? null,
        performance: classifier.isReady ? classifier.getPerformanceStats() : null,
      });
      break;

    default:
      break;
  }
  return true;
}

// ─── Communication Helpers ────────────────────────────────────────────────────

function reportStatus(state) {
  chrome.runtime.sendMessage({
    type: MSG.CLASSIFIER_STATUS,
    state,
    tabId: null,
  }).catch(() => {});
}

function updateBadge(state) {
  if (!settings[STORAGE_KEYS.SHOW_BADGE]) return;

  const badgeMap = {
    [EXTENSION_STATE.MUTED]:     { text: '',    color: '#ef4444' },
    [EXTENSION_STATE.LISTENING]: { text: '',    color: '#22c55e' },
    [EXTENSION_STATE.LOADING]:   { text: '⋯',  color: '#f59e0b' },
    [EXTENSION_STATE.DISABLED]:  { text: 'OFF', color: '#6b7280' },
    [EXTENSION_STATE.ERROR]:     { text: '!',   color: '#ef4444' },
  };

  const badge = badgeMap[state] ?? badgeMap[EXTENSION_STATE.LISTENING];
  chrome.runtime.sendMessage({
    type: MSG.MUTE_STATE_CHANGED,
    badgeText: badge.text,
    badgeColor: badge.color,
  }).catch(() => {});
}

// ─── Allowlist Matching ────────────────────────────────────────────────────────

/**
 * Check if a URL matches any entry in the allowlist.
 * Supports simple substring matching (e.g., "youtube.com/@channelName").
 * @param {string} url
 * @returns {boolean}
 */
function isUrlAllowlisted(url) {
  if (!allowlist || allowlist.length === 0) return false;
  const normalizedUrl = url.toLowerCase();
  return allowlist.some(pattern => {
    const normalizedPattern = pattern.toLowerCase().trim();
    if (!normalizedPattern) return false;
    // Simple substring match (handles channel names, paths, etc.)
    return normalizedUrl.includes(normalizedPattern);
  });
}

// ─── Start ────────────────────────────────────────────────────────────────────

bootstrap();
