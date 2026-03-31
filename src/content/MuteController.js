/**
 * Sakina — MuteController
 *
 * Bridges AudioPipeline (mute/unmute execution) and YamNetClassifier (decisions).
 * Implements a sliding window algorithm to prevent rapid oscillation:
 *
 *   - Requires N consecutive music frames before muting (avoids false positives)
 *   - Requires M consecutive non-music frames before unmuting (avoids brief gaps)
 *
 * Also tracks mute statistics and fires callbacks for UI updates.
 */

import {
  MUTE_TRIGGER_FRAMES,
  UNMUTE_TRIGGER_FRAMES,
  EXTENSION_STATE,
} from '../shared/constants.js';

export class MuteController {
  /**
   * @param {import('./AudioPipeline.js').AudioPipeline} pipeline
   * @param {import('./YamNetClassifier.js').YamNetClassifier} classifier
   */
  constructor(pipeline, classifier) {
    this._pipeline = pipeline;
    this._classifier = classifier;

    /** @type {boolean[]} Recent classification results (true = music) */
    this._window = [];

    this._consecutiveMusicFrames = 0;
    this._consecutiveNonMusicFrames = 0;

    this._currentState = EXTENSION_STATE.LISTENING;

    /** Time when current mute segment started (for stats) */
    this._muteStartTime = null;
    this._totalMutedSeconds = 0;
    this._muteSegmentCount = 0;

    /** Configurable thresholds */
    this.muteThreshold = MUTE_TRIGGER_FRAMES;
    this.unmuteThreshold = UNMUTE_TRIGGER_FRAMES;

    /** @type {function(string): void} Called when state changes */
    this.onStateChange = null;

    /** @type {function({isMusic, confidence, topClass}): void} Called on each classification */
    this.onClassification = null;
  }

  // ─── Main Entry Point ──────────────────────────────────────────────────────

  /**
   * Process a new classification result and decide whether to mute/unmute.
   * Called by the content script after each YAMNet inference.
   *
   * @param {import('./YamNetClassifier.js').ClassificationResult} result
   */
  processResult(result) {
    const { isMusic, confidence, topClass } = result;

    // Fire the per-frame callback for debug/UI overlay purposes
    this.onClassification?.({ isMusic, confidence, topClass });

    if (isMusic) {
      this._consecutiveMusicFrames++;
      this._consecutiveNonMusicFrames = 0;
    } else {
      this._consecutiveNonMusicFrames++;
      this._consecutiveMusicFrames = 0;
    }

    const currently_muted = this._pipeline.isMuted;

    if (!currently_muted && this._consecutiveMusicFrames >= this.muteThreshold) {
      this._doMute();
    } else if (currently_muted && this._consecutiveNonMusicFrames >= this.unmuteThreshold) {
      this._doUnmute();
    }
  }

  // ─── Mute Actions ──────────────────────────────────────────────────────────

  _doMute() {
    this._pipeline.mute();
    this._muteStartTime = Date.now();
    this._muteSegmentCount++;
    this._setState(EXTENSION_STATE.MUTED);
    console.info('[Sakina:controller] 🔇 Music detected — muting audio');
  }

  _doUnmute() {
    this._pipeline.unmute();

    if (this._muteStartTime) {
      const segmentSeconds = (Date.now() - this._muteStartTime) / 1000;
      this._totalMutedSeconds += segmentSeconds;
      this._muteStartTime = null;
    }

    this._setState(EXTENSION_STATE.LISTENING);
    console.info('[Sakina:controller] 🔊 Music ended — restoring audio');
  }

  // ─── State Management ──────────────────────────────────────────────────────

  _setState(state) {
    if (this._currentState === state) return;
    this._currentState = state;
    this.onStateChange?.(state);
  }

  get state() {
    return this._currentState;
  }

  // ─── Stats ─────────────────────────────────────────────────────────────────

  getSessionStats() {
    const additionalSeconds = this._muteStartTime
      ? (Date.now() - this._muteStartTime) / 1000
      : 0;

    return {
      totalMutedSeconds: this._totalMutedSeconds + additionalSeconds,
      muteSegmentCount: this._muteSegmentCount,
      currentlyMuted: this._pipeline.isMuted,
    };
  }

  // ─── Manual Override ───────────────────────────────────────────────────────

  /**
   * Force-unmute and reset counters (e.g., user navigates to new video).
   */
  reset() {
    if (this._pipeline.isMuted) {
      this._pipeline.unmute();
    }
    this._consecutiveMusicFrames = 0;
    this._consecutiveNonMusicFrames = 0;
    this._muteStartTime = null;
    this._setState(EXTENSION_STATE.LISTENING);
  }
}
