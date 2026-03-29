/**
 * MusicShield — Content Script
 *
 * Injected into every YouTube tab. Orchestrates the full pipeline:
 *   1. Detects video element and play events
 *   2. Loads YAMNet model (lazy, first play only)
 *   3. Wires AudioPipeline + MuteController
 *   4. Handles YouTube SPA navigation (yt-navigate-finish)
 *   5. Communicates state to background service worker
 *   6. Responds to settings changes from popup
 *
 * YouTube is a Single Page App. We must handle navigation events
 * carefully as video elements are reused or recreated.
 */

import { AudioPipeline } from './AudioPipeline.js';
import { YamNetClassifier } from './YamNetClassifier.js';
import { MuteController } from './MuteController.js';
import { getSettings, onSettingsChange, addMutedSeconds, incrementMuteCount, incrementVideosProcessed } from '../shared/storage.js';
import { MSG, EXTENSION_STATE, STORAGE_KEYS, MIN_VIDEO_DURATION_SECONDS } from '../shared/constants.js';

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

/** Observer watching for video element changes */
let videoObserver = null;

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function bootstrap() {
  console.info('[MusicShield] Content script loaded on', location.href);

  // Load settings
  settings = await getSettings();
  isEnabled = settings[STORAGE_KEYS.ENABLED];

  if (!isEnabled) {
    console.info('[MusicShield] Extension is disabled, standing by.');
    return;
  }

  // Watch for YouTube SPA navigation
  document.addEventListener('yt-navigate-finish', onYouTubeNavigation);
  document.addEventListener('yt-page-data-updated', onYouTubeNavigation);

  // Watch for settings changes from popup
  onSettingsChange(handleSettingsChange);

  // Listen for messages from background/popup
  chrome.runtime.onMessage.addListener(handleMessage);

  // Initial setup if we're already on a watch page
  if (isWatchPage()) {
    await setupForCurrentPage();
  }
}

// ─── YouTube Navigation ───────────────────────────────────────────────────────

async function onYouTubeNavigation() {
  console.info('[MusicShield] Navigation event:', location.href);

  // Tear down existing pipeline cleanly
  await teardown();

  if (isWatchPage() && isEnabled) {
    // Small delay to let YouTube finish rendering the video element
    setTimeout(setupForCurrentPage, 300);
  }
}

function isWatchPage() {
  return (location.pathname === '/watch' && location.search.includes('v='))
    || location.pathname.startsWith('/shorts/');
}

// ─── Page Setup ───────────────────────────────────────────────────────────────

async function setupForCurrentPage() {
  if (isActive) return;

  const videoEl = await waitForVideoElement();
  if (!videoEl) {
    console.warn('[MusicShield] No video element found after waiting.');
    return;
  }

  // Don't re-attach to the same element
  if (videoEl === lastVideoEl && isActive) return;

  lastVideoEl = videoEl;

  // Skip very short clips (ads can be short, but we handle ads separately)
  if (videoEl.duration && videoEl.duration < MIN_VIDEO_DURATION_SECONDS) {
    console.info('[MusicShield] Skipping short video:', videoEl.duration, 's');
    return;
  }

  console.info('[MusicShield] Attaching to video element. Duration:', videoEl.duration);

  // Load model if not ready (lazy load)
  if (!classifier.isReady && !classifier.isLoading) {
    reportStatus(EXTENSION_STATE.LOADING);
    try {
      await classifier.load();
    } catch (err) {
      reportStatus(EXTENSION_STATE.ERROR);
      console.error('[MusicShield] Failed to load classifier:', err);
      return;
    }
  } else if (classifier.isLoading) {
    reportStatus(EXTENSION_STATE.LOADING);
    // Wait for existing load to complete
    await new Promise(resolve => {
      const check = setInterval(() => {
        if (!classifier.isLoading) {
          clearInterval(check);
          resolve();
        }
      }, 200);
    });
    if (!classifier.isReady) return;
  }

  // Apply current settings to classifier
  classifier.updateSettings({
    threshold: settings[STORAGE_KEYS.THRESHOLD],
    muteSinging: settings[STORAGE_KEYS.MUTE_SINGING],
  });

  // Create pipeline
  pipeline = new AudioPipeline(videoEl);

  // Wire up audio chunk processing
  pipeline.onAudioChunk = async (frame) => {
    if (!isEnabled || !controller) return;
    try {
      const result = await classifier.classify(frame);
      controller.processResult(result);
    } catch (err) {
      // Don't spam logs — classification errors during teardown are expected
      if (isActive) {
        console.warn('[MusicShield] Classification error:', err.message);
      }
    }
  };

  // Create controller
  controller = new MuteController(pipeline, classifier);

  controller.onStateChange = (state) => {
    reportStatus(state);
    updateBadge(state);
  };

  controller.onClassification = ({ isMusic, confidence, topClass }) => {
    if (process.env.NODE_ENV === 'development') {
      console.debug(
        `[MusicShield] ${isMusic ? '🎵' : '💬'} ${topClass} (${(confidence * 100).toFixed(1)}%)`
      );
    }
  };

  // Initialize pipeline on first play (respects autoplay policy)
  const initPipeline = async () => {
    try {
      await pipeline.initialize();
      isActive = true;
      incrementVideosProcessed();
      reportStatus(EXTENSION_STATE.READY);
    } catch (err) {
      console.error('[MusicShield] Pipeline init failed:', err);
      reportStatus(EXTENSION_STATE.ERROR);
    }
  };

  if (!videoEl.paused) {
    await initPipeline();
  } else {
    videoEl.addEventListener('play', initPipeline, { once: true });
  }

  // Watch for video element replacement (YouTube sometimes swaps elements)
  watchVideoElement(videoEl);

  // Start stats flush loop
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
  }, 30_000); // Flush every 30 seconds
}

// ─── Video Element Watcher ────────────────────────────────────────────────────

function watchVideoElement(videoEl) {
  if (videoObserver) {
    videoObserver.disconnect();
    videoObserver = null;
  }

  videoObserver = new MutationObserver(async () => {
    const currentVideo = document.querySelector('video.html5-main-video');
    if (currentVideo && currentVideo !== lastVideoEl) {
      console.info('[MusicShield] Video element changed, reinitializing...');
      await teardown();
      setTimeout(setupForCurrentPage, 100);
    }
  });

  const playerContainer = document.getElementById('movie_player');
  if (playerContainer) {
    videoObserver.observe(playerContainer, { childList: true, subtree: true });
  }
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
    // Flush final stats
    const { totalMutedSeconds, muteSegmentCount } = controller.getSessionStats();
    if (totalMutedSeconds > 0) await addMutedSeconds(totalMutedSeconds);
    if (muteSegmentCount > 0) await incrementMuteCount(muteSegmentCount);
    controller.reset();
    controller = null;
  }

  if (pipeline) {
    pipeline.destroy();
    pipeline = null;
  }

  isActive = false;
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
  return true; // Keep message channel open for async responses
}

// ─── Communication Helpers ────────────────────────────────────────────────────

function reportStatus(state) {
  chrome.runtime.sendMessage({
    type: MSG.CLASSIFIER_STATUS,
    state,
    tabId: null, // background will attach tabId
  }).catch(() => {}); // Ignore if background isn't ready
}

function updateBadge(state) {
  if (!settings[STORAGE_KEYS.SHOW_BADGE]) return;

  const badgeMap = {
    [EXTENSION_STATE.MUTED]: { text: '🔇', color: '#ef4444' },
    [EXTENSION_STATE.LISTENING]: { text: '', color: '#22c55e' },
    [EXTENSION_STATE.LOADING]: { text: '⋯', color: '#f59e0b' },
    [EXTENSION_STATE.DISABLED]: { text: 'OFF', color: '#6b7280' },
    [EXTENSION_STATE.ERROR]: { text: '!', color: '#ef4444' },
  };

  const badge = badgeMap[state] || badgeMap[EXTENSION_STATE.LISTENING];
  chrome.runtime.sendMessage({
    type: MSG.MUTE_STATE_CHANGED,
    badgeText: badge.text,
    badgeColor: badge.color,
  }).catch(() => {});
}

// ─── Utility: Wait for Video Element ──────────────────────────────────────────

/**
 * Wait for YouTube's main video element to appear in the DOM.
 * YouTube renders the player asynchronously.
 *
 * @param {number} timeout - Max wait time in ms
 * @returns {Promise<HTMLVideoElement|null>}
 */
function waitForVideoElement(timeout = 8000) {
  return new Promise((resolve) => {
    const selector = 'video.html5-main-video';
    const existing = document.querySelector(selector);
    if (existing) {
      resolve(existing);
      return;
    }

    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) {
        observer.disconnect();
        clearTimeout(timeoutHandle);
        resolve(el);
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    const timeoutHandle = setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, timeout);
  });
}

// ─── Start ────────────────────────────────────────────────────────────────────

bootstrap();
