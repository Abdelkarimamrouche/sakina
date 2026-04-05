/**
 * Sakina — Content Script
 *
 * State machine with SSOT:
 *   IDLE        → no pipeline, waiting for video
 *   SETTING_UP  → waitForVideo + loadModel + initialize (mutex locked)
 *   ACTIVE      → pipeline running, classifying audio
 *   TEARING_DOWN→ cleanup in progress (mutex locked)
 *   DISABLED    → extension off, listeners active, no pipeline
 */

import { AudioPipeline } from './AudioPipeline.js';
import { YamNetClassifier } from './YamNetClassifier.js';
import { MuteController } from './MuteController.js';
import { UnmuteBadge, getPagePattern } from './UnmuteBadge.js';
import { detectPlatform, waitForVideo, findBestVideo } from './platforms.js';
import {
  getSettings, onSettingsChange,
  addMutedSeconds, incrementMuteCount, incrementVideosProcessed,
  getAllowlist, addToAllowlist, addActivityEntry, addPlatformMutedSeconds,
} from '../shared/storage.js';
import {
  MSG, EXTENSION_STATE, STORAGE_KEYS,
  PLATFORM_TO_STORAGE_KEY, MIN_VIDEO_DURATION_SECONDS,
} from '../shared/constants.js';

// ─── State Machine ────────────────────────────────────────────────────────────

const State = Object.freeze({
  IDLE:         'IDLE',
  SETTING_UP:   'SETTING_UP',   // mutex locked — setup in progress
  ACTIVE:       'ACTIVE',       // pipeline running
  TEARING_DOWN: 'TEARING_DOWN', // mutex locked — teardown in progress
  DISABLED:     'DISABLED',     // extension off
});

// ─── Module-level Singletons ──────────────────────────────────────────────────

const classifier = new YamNetClassifier();

// ─── Module-level State (SSOT) ────────────────────────────────────────────────

let _state       = State.IDLE;
let _pipeline    = null;
let _controller  = null;
let _settings    = {};
let _allowlist   = [];
let _platform    = null;
let _lastVideoEl = null;
let _statsFlushInterval = null;
let _videoObserver      = null;
let _removeNavListeners = null;
let _navDebounceTimer   = null; // Bug 5 fix: debounce navigation events
let _badge              = null; // UnmuteBadge instance
let _sessionMuteDisabled = false; // true after user clicks "Undo" for this session
// First-load recovery: limits poll-timeout retries to 1 per video session
let _setupRetryCount = 0;

// BUG 2 FIX: Track last flushed stats to compute delta on periodic flush
let _lastFlushedMutedSeconds = 0;
let _lastFlushedMuteCount    = 0;

// BUG 4 FIX: Watchdog to detect stale audio frames
let _lastFrameTimestamp      = 0;
let _watchdogStartTime       = 0; // when the pipeline became ACTIVE
let _watchdogInterval        = null;
let _videoPlayHandler        = null; // resets _lastFrameTimestamp on video resume
const WATCHDOG_INTERVAL_MS     = 5_000;  // check every 5s
const WATCHDOG_STALE_THRESHOLD = 6_000;  // if no frame in 6s while playing → stale

// ─── State Transitions ────────────────────────────────────────────────────────

function canSetup() {
  return _state === State.IDLE;
}

function canTeardown() {
  return _state === State.ACTIVE || _state === State.SETTING_UP;
}

function setState(next) {
  console.info(`[Sakina] State: ${_state} → ${next}`);
  _state = next;
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function bootstrap() {
  _platform = detectPlatform();
  if (!_platform) return;

  console.info(`[Sakina] Loaded on ${_platform.name}:`, location.href);

  [_settings, _allowlist] = await Promise.all([getSettings(), getAllowlist()]);

  // Always register listeners — even when disabled, we need to hear re-enable
  _removeNavListeners = _platform.setupNavigation(onNavigation);
  onSettingsChange(handleSettingsChange);
  chrome.runtime.onMessage.addListener(handleMessage);

  // BUG 5 FIX: Handle tab visibility changes for IDLE recovery
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (_state !== State.IDLE) return;
    if (!_platform?.isVideoPage()) return;
    if (!_settings[STORAGE_KEYS.ENABLED]) return;
    if (isAllowlisted(location.href)) return;

    console.info('[Sakina] Tab became visible — attempting setup from IDLE');
    setup();
  });

  const isEnabled = _settings[STORAGE_KEYS.ENABLED];
  const platformKey = PLATFORM_TO_STORAGE_KEY[_platform.name.toLowerCase()];
  const isPlatformEnabled = !platformKey || _settings[platformKey] !== false;

  if (!isEnabled || !isPlatformEnabled) {
    setState(State.DISABLED);
    reportStatus(EXTENSION_STATE.DISABLED);
    updateBadge(EXTENSION_STATE.DISABLED);
    console.info('[Sakina] Disabled, standing by.');
    return;
  }

  if (isAllowlisted(location.href)) {
    console.info('[Sakina] URL allowlisted, standing by.');
    return;
  }

  if (_platform.isVideoPage()) {
    await setup();
  }
}

// ─── Navigation (with debounce — Bug 5 fix) ───────────────────────────────────

function onNavigation() {
  // Debounce: YouTube fires yt-navigate-finish + yt-page-data-updated
  // for the same navigation. Only process the first one within 200ms.
  clearTimeout(_navDebounceTimer);
  _navDebounceTimer = setTimeout(async () => {
    console.info(`[Sakina:${_platform.name}] Navigation →`, location.href);
    await teardown();

    const isEnabled = _settings[STORAGE_KEYS.ENABLED];
    if (_platform.isVideoPage() && isEnabled && !isAllowlisted(location.href)) {
      setTimeout(setup, 350);
    }
  }, 200);
}

// ─── Setup (with mutex — Bug 2 fix) ───────────────────────────────────────────

async function setup() {
  // Mutex: only one setup at a time
  if (!canSetup()) {
    console.info(`[Sakina] setup() skipped — state is ${_state}`);
    return;
  }
  setState(State.SETTING_UP);

  try {
    const videoEl = await waitForVideo(_platform);
    if (!videoEl) {
      console.warn(`[Sakina:${_platform.name}] No video found.`);
      setState(State.IDLE);
      return;
    }

    // Guard: if state changed while waiting (e.g. teardown was called)
    if (_state !== State.SETTING_UP) {
      console.info('[Sakina] setup() aborted — state changed during waitForVideo');
      return;
    }

    if (videoEl.duration && isFinite(videoEl.duration) && videoEl.duration < MIN_VIDEO_DURATION_SECONDS) {
      console.info(`[Sakina] Skipping short video (${videoEl.duration}s)`);
      setState(State.IDLE);
      return;
    }

    _lastVideoEl = videoEl;

    // Skip video elements already owned by the page's Web Audio API (e.g. TikTok)
    if (AudioPipeline.isIncompatible(videoEl)) {
      console.info('[Sakina] Video element is incompatible (page owns MediaElementSource) — skipping.');
      setState(State.IDLE);
      return;
    }

    // Load model
    if (!classifier.isReady && !classifier.isLoading) {
      reportStatus(EXTENSION_STATE.LOADING);
      await classifier.load();
    } else if (classifier.isLoading) {
      reportStatus(EXTENSION_STATE.LOADING);
      await waitForClassifier();
    }

    if (!classifier.isReady || _state !== State.SETTING_UP) {
      reportStatus(EXTENSION_STATE.READY);
      setState(State.IDLE);
      return;
    }

    classifier.updateSettings({
      threshold:   _settings[STORAGE_KEYS.THRESHOLD],
      muteSinging: _settings[STORAGE_KEYS.MUTE_SINGING],
    });

    // Wire pipeline
    _pipeline = new AudioPipeline(videoEl);
    _pipeline.onAudioChunk = async (frame) => {
      // BUG 4 FIX: Track last frame time for watchdog
      _lastFrameTimestamp = Date.now();

      if (_state !== State.ACTIVE || !_controller) return;
      // Skip classification when session mute is disabled (user clicked "Undo")
      if (_sessionMuteDisabled) return;
      try {
        const result = await classifier.classify(frame);
        _controller.processResult(result);
      } catch (err) {
        if (_state === State.ACTIVE) console.warn('[Sakina] Classification error:', err.message);
      }
    };

    _controller = new MuteController(_pipeline, classifier);
    _controller.onStateChange = (s) => {
      reportStatus(s);
      updateBadge(s);
      // Show/hide unmute badge based on mute state
      if (!_badge) return;
      if (s === EXTENSION_STATE.MUTED && !_sessionMuteDisabled) {
        _badge.show();
      } else {
        _badge.hide();
      }
    };

    // Initialize the floating unmute badge
    _badge = new UnmuteBadge({
      getPlayerContainer: () =>
        document.querySelector(_platform.playerContainerSelector) ?? document.body,

      onSessionUnmute: () => {
        _sessionMuteDisabled = true;
        if (_controller) _controller.reset();
        _badge.showConfirmation('Unmuted for this session');
      },

      onAllowlist: async () => {
        const pattern = getPagePattern();
        await addToAllowlist(pattern);
        _allowlist = await getAllowlist();
        _sessionMuteDisabled = true;
        if (_controller) _controller.reset();
        _badge.showConfirmation('Added to allowlist');
      },
    });

    // Initialize on play
    await initPipelineOnPlay(videoEl);

  } catch (err) {
    console.error('[Sakina] setup() failed:', err);
    reportStatus(EXTENSION_STATE.ERROR);
    setState(State.IDLE);
  }
}

async function initPipelineOnPlay(videoEl) {
  const doInit = async () => {
    // Final guard before initializing
    if (_state !== State.SETTING_UP) return;
    try {
      await _pipeline.initialize();
      setState(State.ACTIVE);
      incrementVideosProcessed();
      reportStatus(EXTENSION_STATE.READY);
      startStatsFlush();
      startWatchdog(); // BUG 4 FIX: Start watchdog after pipeline init
      watchVideoElement();
    } catch (err) {
      // Handle incompatible video silently — not a real error, just skip
      if (err.message?.includes('INCOMPATIBLE_VIDEO')) {
        console.info('[Sakina] Video incompatible with Web Audio interception — skipping.');
        setState(State.IDLE);
        return;
      }
      console.error('[Sakina] Pipeline init failed:', err);
      reportStatus(EXTENSION_STATE.ERROR);
      setState(State.IDLE);
    }
  };

  if (!videoEl.paused) {
    await doInit();
    // If AudioContext is still suspended after init (no user gesture available),
    // wait briefly for the persistent gesture handler to resume it.
    // This prevents marking ACTIVE when no audio will actually be processed.
    if (_pipeline && _pipeline._ctx?.state === 'suspended') {
      const running = await _pipeline.waitUntilContextRunning(3000);
      if (!running) {
        // Context still suspended after 3s — gesture handler is active and will
        // resume it on next user interaction. Pipeline is still ACTIVE and watchdog
        // will give it extended time (see Correction 3 below).
        console.info('[Sakina] AudioContext suspended — waiting for user gesture to resume');
      }
    }
    return;
  }

  // Wait for play event — Bug 4 fix: use proper cleanup
  let resolved = false;

  const onPlay = async () => {
    if (resolved) return;
    resolved = true;
    cleanup();
    await doInit();
  };

  const cleanup = () => {
    videoEl.removeEventListener('play', onPlay);
    videoEl.removeEventListener('playing', onPlay);
    clearInterval(pollInterval);
  };

  videoEl.addEventListener('play', onPlay, { once: true });
  videoEl.addEventListener('playing', onPlay, { once: true });

  // Fallback poll — Bug 4 fix: clearInterval (not clearTimeout)
  let attempts = 0;
  const pollInterval = setInterval(() => {
    attempts++;
    if (_state !== State.SETTING_UP) {
      cleanup();
      return;
    }
    const v = findBestVideo(_platform);
    if (v && !v.paused) {
      if (v !== videoEl) {
        _pipeline._video = v;
        _lastVideoEl = v;
      }
      resolved = true;
      cleanup();
      doInit();
    } else if (attempts >= 10) {
      cleanup();
      console.warn(`[Sakina] No playing video after 5s`);
      reportStatus(EXTENSION_STATE.READY);
      setState(State.IDLE);

      // First-load recovery: if the model just finished loading, the video
      // may not have started playing yet. Schedule one retry after 2s.
      // _setupRetryCount prevents infinite loops — max 1 retry per video session.
      // teardown() resets _setupRetryCount so each new video gets a fresh retry.
      if (_setupRetryCount === 0) {
        _setupRetryCount++;
        setTimeout(() => {
          if (
            _state === State.IDLE &&
            classifier.isReady &&
            _platform?.isVideoPage() &&
            _settings[STORAGE_KEYS.ENABLED] !== false &&
            !isAllowlisted(location.href)
          ) {
            console.info('[Sakina] Retrying setup — model ready, waiting for video to play');
            setup();
          }
        }, 2000);
      }
    }
  }, 500);
}

// BUG 3 FIX: Add timeout to prevent infinite wait on failed model load
function waitForClassifier(timeoutMs = 45_000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = setInterval(() => {
      if (!classifier.isLoading) {
        clearInterval(check);
        resolve();
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        clearInterval(check);
        reject(new Error('YAMNet model load timed out after 45s'));
      }
    }, 200);
  });
}

// ─── Teardown (with mutex — Bug 1 fix) ────────────────────────────────────────

async function teardown() {
  if (!canTeardown()) {
    // Already idle/disabled/tearing down — nothing to do
    return;
  }
  setState(State.TEARING_DOWN);

  clearTimeout(_navDebounceTimer);
  clearInterval(_statsFlushInterval);
  _statsFlushInterval = null;
  stopWatchdog(); // BUG 4 FIX: Stop watchdog on teardown

  if (_videoObserver) {
    _videoObserver.disconnect();
    _videoObserver = null;
  }

  // BUG 2 FIX: Use delta-based stats persistence (not cumulative)
  if (_controller) {
    const { totalMutedSeconds, muteSegmentCount } = _controller.getSessionStats();

    const secondsDelta = totalMutedSeconds - _lastFlushedMutedSeconds;
    const countDelta   = muteSegmentCount  - _lastFlushedMuteCount;

    if (secondsDelta > 0) {
      await addMutedSeconds(secondsDelta);
      if (_platform) {
        await addActivityEntry(_platform.name.toLowerCase(), secondsDelta);
        await addPlatformMutedSeconds(_platform.name.toLowerCase(), secondsDelta);
      }
    }
    if (countDelta > 0) await incrementMuteCount(countDelta);

    _controller.reset();
    _controller = null;
  }

  // BUG 2 FIX: Reset trackers after stats are persisted
  _lastFlushedMutedSeconds = 0;
  _lastFlushedMuteCount = 0;

  // BUG 4 FIX: Reset frame timestamp
  _lastFrameTimestamp = 0;
  _watchdogStartTime  = 0;

  if (_pipeline) {
    _pipeline.destroy();
    _pipeline = null;
  }

  // Destroy badge and reset session flag
  if (_badge) {
    _badge.destroy();
    _badge = null;
  }
  _sessionMuteDisabled = false;
  _setupRetryCount = 0;

  _lastVideoEl = null;
  reportStatus(EXTENSION_STATE.READY);
  setState(State.IDLE);
}

// ─── Stats Flush ──────────────────────────────────────────────────────────────

// BUG 2 FIX: Use delta-based flushing to avoid double-counting
function startStatsFlush() {
  clearInterval(_statsFlushInterval);
  _statsFlushInterval = setInterval(async () => {
    if (_state !== State.ACTIVE || !_controller) return;
    const { totalMutedSeconds, muteSegmentCount } = _controller.getSessionStats();

    const secondsDelta = totalMutedSeconds - _lastFlushedMutedSeconds;
    const countDelta   = muteSegmentCount  - _lastFlushedMuteCount;

    if (secondsDelta > 0) {
      await addMutedSeconds(secondsDelta);
      _lastFlushedMutedSeconds = totalMutedSeconds;
    }
    if (countDelta > 0) {
      await incrementMuteCount(countDelta);
      _lastFlushedMuteCount = muteSegmentCount;
    }
  }, 30_000);
}

// ─── Watchdog ─────────────────────────────────────────────────────────────────

// BUG 4 FIX: Detect stale audio frames when video is playing
function startWatchdog() {
  stopWatchdog();
  _watchdogStartTime = Date.now(); // record when pipeline became active

  // SLEEP/WAKE FIX: Reset frame timestamp when video resumes after pause.
  // Without this, the watchdog sees msSinceLastFrame = pause_duration (can be minutes)
  // and incorrectly tears down the pipeline the moment the user presses play.
  if (_lastVideoEl && !_videoPlayHandler) {
    _videoPlayHandler = () => {
      if (_state === State.ACTIVE) {
        _lastFrameTimestamp = Date.now();
      }
    };
    _lastVideoEl.addEventListener('play', _videoPlayHandler, { passive: true });
    _lastVideoEl.addEventListener('playing', _videoPlayHandler, { passive: true });
  }

  _watchdogInterval = setInterval(async () => {
    if (_state !== State.ACTIVE || !_pipeline || !_lastVideoEl) return;

    const videoEl = _lastVideoEl;
    const isPlaying = !videoEl.paused && !videoEl.ended && videoEl.readyState >= 2;
    if (!isPlaying) return; // paused — expected silence, not a bug

    // Use _lastFrameTimestamp if frames have arrived, otherwise measure
    // from when the pipeline became active. This catches the case where
    // AudioContext is suspended and NO frames have ever arrived.
    const refTime = _lastFrameTimestamp > 0 ? _lastFrameTimestamp : _watchdogStartTime;
    const msSinceLastFrame = Date.now() - refTime;

    // DEFINITIVE FIX: If no frames have ever arrived and the AudioContext is suspended,
    // use an extended threshold — the gesture handler is working to resume it.
    // Don't tear down prematurely; the user just needs to scroll or click.
    const ctxSuspended = _pipeline?._ctx?.state === 'suspended';
    const effectiveThreshold = (_lastFrameTimestamp === 0 && ctxSuspended)
      ? 30_000  // 30s grace for user gesture when AudioContext is suspended
      : WATCHDOG_STALE_THRESHOLD; // 6s for normal stale frame detection

    if (msSinceLastFrame > effectiveThreshold) {
      if (ctxSuspended && _lastFrameTimestamp === 0) {
        // BRAVE FIX: AudioContext is suspended and no frames have ever arrived.
        // Brave may silently block resume() — re-register gesture listeners
        // and retry resume() without full teardown. This avoids the infinite
        // teardown/setup cycle that doesn't help in Brave.
        console.warn(`[Sakina] Watchdog: AudioContext still suspended after ${msSinceLastFrame}ms — retrying resume`);
        _pipeline?._ctx?.resume().catch(() => {});
        _pipeline?._registerGestureListeners();
        // Reset watchdog start time to give another full grace period
        _watchdogStartTime = Date.now();
      } else {
        // Frames were arriving but stopped — real stale condition, full reinit
        console.warn(`[Sakina] Watchdog: no audio frame for ${msSinceLastFrame}ms — reinitializing pipeline`);
        await teardown();
        setTimeout(setup, 200);
      }
    }
  }, WATCHDOG_INTERVAL_MS);
}

function stopWatchdog() {
  clearInterval(_watchdogInterval);
  _watchdogInterval = null;

  // SLEEP/WAKE FIX: Remove play listener
  if (_videoPlayHandler && _lastVideoEl) {
    _lastVideoEl.removeEventListener('play',    _videoPlayHandler);
    _lastVideoEl.removeEventListener('playing', _videoPlayHandler);
  }
  _videoPlayHandler = null;
}

// ─── Video Element Watcher ────────────────────────────────────────────────────

function watchVideoElement() {
  if (_videoObserver) { _videoObserver.disconnect(); _videoObserver = null; }

  _videoObserver = new MutationObserver(async () => {
    if (_state !== State.ACTIVE) return;
    const current = findBestVideo(_platform);
    if (current && current !== _lastVideoEl) {
      console.info(`[Sakina:${_platform.name}] Video swapped, reinitializing…`);
      await teardown();
      setTimeout(setup, 100);
    }
  });

  const container = document.querySelector(_platform.playerContainerSelector) ?? document.body;
  _videoObserver.observe(container, { childList: true, subtree: true });
}

// ─── Settings Handler (Bug 1 fix — properly async) ────────────────────────────

async function handleSettingsChange(changes) {
  let needsClassifierUpdate = false;

  if (STORAGE_KEYS.ENABLED in changes) {
    const enabled = changes[STORAGE_KEYS.ENABLED].newValue;
    _settings[STORAGE_KEYS.ENABLED] = enabled;

    if (!enabled) {
      await teardown();           // ← properly awaited
      setState(State.DISABLED);
      reportStatus(EXTENSION_STATE.DISABLED);
    } else {
      if (_state === State.DISABLED) setState(State.IDLE);
      reportStatus(EXTENSION_STATE.READY);
      if (_platform?.isVideoPage() && !isAllowlisted(location.href)) {
        await setup();            // ← properly awaited
      }
    }
  }

  // Platform toggle changes
  for (const key of Object.values(PLATFORM_TO_STORAGE_KEY)) {
    if (key in changes) {
      _settings[key] = changes[key].newValue;
      const platformKey = PLATFORM_TO_STORAGE_KEY[_platform?.name?.toLowerCase()];
      if (key === platformKey) {
        if (!changes[key].newValue) {
          await teardown();
          setState(State.DISABLED);
        } else if (_state === State.DISABLED) {
          setState(State.IDLE);
          if (_platform?.isVideoPage()) await setup();
        }
      }
    }
  }

  if (STORAGE_KEYS.THRESHOLD in changes) {
    _settings[STORAGE_KEYS.THRESHOLD] = changes[STORAGE_KEYS.THRESHOLD].newValue;
    needsClassifierUpdate = true;
  }

  if (STORAGE_KEYS.MUTE_SINGING in changes) {
    _settings[STORAGE_KEYS.MUTE_SINGING] = changes[STORAGE_KEYS.MUTE_SINGING].newValue;
    needsClassifierUpdate = true;
  }

  if (STORAGE_KEYS.SHOW_BADGE in changes) {
    _settings[STORAGE_KEYS.SHOW_BADGE] = changes[STORAGE_KEYS.SHOW_BADGE].newValue;
  }

  if (needsClassifierUpdate && classifier.isReady) {
    classifier.updateSettings({
      threshold:   _settings[STORAGE_KEYS.THRESHOLD],
      muteSinging: _settings[STORAGE_KEYS.MUTE_SINGING],
    });
  }
}

// ─── Message Handler ──────────────────────────────────────────────────────────

function handleMessage(message, sender, sendResponse) {
  switch (message.type) {

    case MSG.TOGGLE_EXTENSION: {
      const enable = message.enabled;
      _settings[STORAGE_KEYS.ENABLED] = enable;
      if (!enable) {
        teardown().then(() => {
          setState(State.DISABLED);
          reportStatus(EXTENSION_STATE.DISABLED);
        });
      } else {
        if (_state === State.DISABLED) setState(State.IDLE);
        reportStatus(EXTENSION_STATE.READY);
        if (_platform?.isVideoPage() && !isAllowlisted(location.href)) setup();
      }
      sendResponse({ ok: true });
      break;
    }

    case MSG.GET_TAB_STATE:
      sendResponse({
        state:            stateToExtensionState(),
        isActive:         _state === State.ACTIVE,
        isEnabled:        _settings[STORAGE_KEYS.ENABLED] !== false,
        platform:         _platform?.name ?? 'Unknown',
        isMuted:          _pipeline?.isMuted ?? false,
        classifierReady:  classifier.isReady,
        classifierLoading: classifier.isLoading,
        stats:            _controller?.getSessionStats() ?? null,
        performance:      classifier.isReady ? classifier.getPerformanceStats() : null,
      });
      break;

    default:
      break;
  }
  return true;
}

function stateToExtensionState() {
  switch (_state) {
    case State.DISABLED:     return EXTENSION_STATE.DISABLED;
    case State.SETTING_UP:   return EXTENSION_STATE.LOADING;
    case State.TEARING_DOWN: return EXTENSION_STATE.LOADING;
    case State.ACTIVE:       return _pipeline?.isMuted ? EXTENSION_STATE.MUTED : EXTENSION_STATE.LISTENING;
    default:                 return EXTENSION_STATE.READY;
  }
}

// ─── Communication Helpers ────────────────────────────────────────────────────

function reportStatus(state) {
  chrome.runtime.sendMessage({ type: MSG.CLASSIFIER_STATUS, state, tabId: null }).catch(() => {});
}

function updateBadge(state) {
  if (!_settings[STORAGE_KEYS.SHOW_BADGE]) return;
  const badgeMap = {
    [EXTENSION_STATE.MUTED]:     { text: '',    color: '#ef4444' },
    [EXTENSION_STATE.LISTENING]: { text: '',    color: '#22c55e' },
    [EXTENSION_STATE.LOADING]:   { text: '⋯',  color: '#f59e0b' },
    [EXTENSION_STATE.DISABLED]:  { text: 'off', color: '#6b7280' },
    [EXTENSION_STATE.ERROR]:     { text: '!',   color: '#ef4444' },
  };
  const badge = badgeMap[state] ?? badgeMap[EXTENSION_STATE.LISTENING];
  chrome.runtime.sendMessage({ type: MSG.MUTE_STATE_CHANGED, badgeText: badge.text, badgeColor: badge.color }).catch(() => {});
}

// ─── Allowlist ────────────────────────────────────────────────────────────────

function isAllowlisted(url) {
  if (!_allowlist?.length) return false;
  const lower = url.toLowerCase();
  return _allowlist.some(p => p && lower.includes(p.toLowerCase().trim()));
}

// ─── Start ────────────────────────────────────────────────────────────────────

bootstrap();
