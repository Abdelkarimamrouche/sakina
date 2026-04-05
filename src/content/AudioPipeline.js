/**
 * Sakina — AudioPipeline
 *
 * Intercepts a <video> element's audio stream via Web Audio API.
 * Provides:
 *   - Real-time PCM capture for YAMNet classification
 *   - GainNode for smooth mute/unmute transitions
 *   - Proper cleanup and reattachment on video element recreation
 *
 * Signal chain:
 *   VideoElement → MediaElementSource → AnalyserNode → GainNode → AudioContext.destination
 *                                            └─────────→ ScriptProcessorNode (capture only, silent)
 *
 * NOTE: ScriptProcessorNode is deprecated but still widely supported.
 *       Migration to AudioWorklet is planned for v2.0.
 */

import {
  AUDIO_BUFFER_SIZE,
  YAMNET_SAMPLE_RATE,
  YAMNET_FRAME_SAMPLES,
  GAIN_FADE_DURATION,
  ACCUMULATE_SAMPLE_MULTIPLIER,
} from '../shared/constants.js';

// Cache MediaElementSourceNode per video element — createMediaElementSource()
// can only be called ONCE per element, ever. Reuse across pipeline re-creations.
const sourceNodeCache = new WeakMap();

// Track video elements that are already owned by the page's Web Audio API.
// These elements cannot have a second MediaElementSourceNode created for them.
// Common on TikTok which uses Web Audio API internally.
const incompatibleVideoElements = new WeakSet();

export class AudioPipeline {
  /** @param {HTMLVideoElement} videoElement */
  constructor(videoElement) {
    this._video = videoElement;
    this._ctx = null;
    this._source = null;
    this._analyser = null;
    this._gain = null;
    this._processor = null;
    this._silentGain = null; // keeps ScriptProcessor alive without audible output

    /** @type {function|null} Visibility change handler for AudioContext recovery */
    this._visibilityHandler = null;

    /** @type {function|null} One-time gesture handler to resume suspended AudioContext */
    this._gestureHandler = null;

    /** @type {function|null} Called when first audio frame arrives — signals AudioContext is truly running */
    this._onFirstFrameCallback = null;

    /** @type {Float32Array[]} Rolling buffer of raw PCM frames */
    this._sampleBuffer = [];
    this._totalBuffered = 0;

    /** How many original-rate samples we need before sending a YAMNet frame */
    this._samplesNeededOriginalRate = 0;

    /** @type {function(Float32Array): void} Callback with resampled 16kHz mono audio */
    this.onAudioChunk = null;

    /** @type {boolean} Whether audio is currently being muted */
    this._isMuted = false;

    this._initialized = false;
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Sets up the full Web Audio pipeline.
   * Must be called after the video element has started playing
   * (to avoid AudioContext suspended state issues).
   */
  async initialize() {
    if (this._initialized) return;

    try {
      // Reuse existing source node if this video element was previously connected.
      // createMediaElementSource() permanently binds an element to a context —
      // calling it twice on the same element throws InvalidStateError.
      if (sourceNodeCache.has(this._video)) {
        const cached = sourceNodeCache.get(this._video);
        this._source = cached.source;
        this._ctx = cached.ctx;
        // CRITICAL: Disconnect source from any previous connections (e.g., passthrough
        // from destroy()). Otherwise source will be connected to BOTH the old path
        // (direct to destination) AND the new analysis graph, and mute won't work.
        this._source.disconnect();
      } else {
        this._ctx = new AudioContext({
          latencyHint: 'playback',
        });
        try {
          this._source = this._ctx.createMediaElementSource(this._video);
          sourceNodeCache.set(this._video, { source: this._source, ctx: this._ctx });
        } catch (err) {
          if (err instanceof DOMException && err.name === 'InvalidStateError') {
            // This video element was already connected to a MediaElementSourceNode
            // by the page's own Web Audio API usage (common on TikTok).
            // A video element can only have ONE MediaElementSource — ever.
            // Mark it as incompatible so we don't retry, and throw a descriptive error.
            console.warn('[Sakina:pipeline] Video element already captured by page Web Audio API — skipping.');
            incompatibleVideoElements.add(this._video);
            // Close the unused AudioContext we just created
            this._ctx.close().catch(() => {});
            this._ctx = null;
            throw new Error('INCOMPATIBLE_VIDEO: page owns this MediaElementSource');
          }
          throw err; // re-throw other errors
        }
      }

      // BRAVE FIX: onstatechange handler re-registers gesture listeners when context becomes suspended.
      // We do NOT clean up on 'running' — cleanup happens when first frame arrives in _onAudioProcess.
      // This is critical for Brave where ctx.state may become 'running' but frames don't flow yet.
      this._ctx.onstatechange = () => {
        if (this._ctx.state === 'suspended') {
          // Context became suspended again (tab switch, Brave policy) — re-register gesture listeners
          this._ctx.resume().catch(() => {});
          this._registerGestureListeners();
        }
        // Note: no cleanup on 'running' — cleanup happens when first frame arrives
      };

      // Visibility handler: resume on tab focus (common suspension trigger)
      this._visibilityHandler = () => {
        if (document.visibilityState === 'visible' && this._ctx?.state === 'suspended') {
          this._ctx.resume().catch(() => {});
        }
      };
      document.addEventListener('visibilitychange', this._visibilityHandler);

      // Initial resume attempt for suspended-at-creation case
      if (this._ctx.state === 'suspended') {
        this._ctx.resume().catch(() => {});
      }

      // BRAVE FIX: Register gesture listeners unconditionally.
      // Brave: ctx.resume() may resolve without ctx.state becoming 'running'.
      // We do NOT rely on ctx.state for cleanup — instead, we remove listeners
      // only when the first real audio frame arrives (confirmed in _onAudioProcess).
      // If the context is already running, listeners will be removed on first frame anyway.
      this._registerGestureListeners();

      // ── Analyser: gives us frequency data for potential future FFT features ──
      this._analyser = this._ctx.createAnalyser();
      this._analyser.fftSize = 2048;

      // ── Gain: controls mute/unmute with smooth fades ──
      this._gain = this._ctx.createGain();
      this._gain.gain.value = 1.0;

      // ── PCM Capture branch ──
      // ScriptProcessorNode captures raw samples but produces no audible output.
      this._processor = this._ctx.createScriptProcessor(
        AUDIO_BUFFER_SIZE,
        1, // input channels (mono)
        1  // output channels
      );

      // Silent output node — required to keep the processor alive
      this._silentGain = this._ctx.createGain();
      this._silentGain.gain.value = 0;

      // Calculate how many original-rate samples = one 16kHz YAMNet frame
      this._samplesNeededOriginalRate = Math.ceil(
        YAMNET_FRAME_SAMPLES * (this._ctx.sampleRate / YAMNET_SAMPLE_RATE)
      ) * ACCUMULATE_SAMPLE_MULTIPLIER;

      this._processor.onaudioprocess = this._onAudioProcess.bind(this);

      // Wire everything up
      // Main path:  source → analyser → gain → speakers
      this._source.connect(this._analyser);
      this._analyser.connect(this._gain);
      this._gain.connect(this._ctx.destination);

      // Capture path (silent): analyser → processor → silentGain → destination
      // silentGain has gain=0 so no audible output, but the graph must reach
      // destination to prevent Chrome from suspending the ScriptProcessorNode.
      this._analyser.connect(this._processor);
      this._processor.connect(this._silentGain);
      this._silentGain.connect(this._ctx.destination);

      this._initialized = true;
      console.info('[Sakina:pipeline] Initialized. Sample rate:', this._ctx.sampleRate);

    } catch (err) {
      console.error('[Sakina:pipeline] Failed to initialize:', err);
      this.destroy();
      throw err;
    }
  }

  // ─── Audio Process Handler ──────────────────────────────────────────────────

  _onAudioProcess(event) {
    // BRAVE FIX: First real frame = AudioContext is confirmed running — safe to remove gesture listeners.
    // This is the only reliable signal across Chrome, Brave, and other Chromium variants.
    // We do NOT rely on ctx.state === 'running' because Brave may lie about it.
    if (this._gestureHandler) {
      this._removeGestureListeners();
    }

    // Get mono channel (channel 0 only — YAMNet expects mono)
    const channelData = event.inputBuffer.getChannelData(0);

    // Copy to avoid reuse of the buffer after this tick
    const copy = new Float32Array(channelData.length);
    copy.set(channelData);
    this._sampleBuffer.push(copy);
    this._totalBuffered += copy.length;

    // Once we've accumulated enough samples, downsample and fire callback
    if (this._totalBuffered >= this._samplesNeededOriginalRate) {
      // Flatten accumulated chunks
      const flat = new Float32Array(this._totalBuffered);
      let offset = 0;
      for (const chunk of this._sampleBuffer) {
        flat.set(chunk, offset);
        offset += chunk.length;
      }

      // Extract exactly what we need
      const needed = this._samplesNeededOriginalRate;
      const frame = flat.subarray(0, needed);
      const remainder = flat.subarray(needed);

      // Resample to 16kHz
      const resampled = this._resampleLinear(frame, this._ctx.sampleRate, YAMNET_SAMPLE_RATE);

      // Keep remainder for next frame
      this._sampleBuffer = remainder.length > 0 ? [remainder] : [];
      this._totalBuffered = remainder.length;

      if (this.onAudioChunk && resampled.length >= YAMNET_FRAME_SAMPLES) {
        this.onAudioChunk(resampled.subarray(0, YAMNET_FRAME_SAMPLES));
      }
    }
  }

  // ─── Mute Control ──────────────────────────────────────────────────────────

  /**
   * Smoothly mute the audio output.
   * Audio capture continues so classification keeps running.
   */
  mute() {
    if (!this._gain || this._isMuted) return;
    this._isMuted = true;
    this._gain.gain.setTargetAtTime(0, this._ctx.currentTime, GAIN_FADE_DURATION);
  }

  /**
   * Smoothly restore audio output.
   */
  unmute() {
    if (!this._gain || !this._isMuted) return;
    this._isMuted = false;
    this._gain.gain.setTargetAtTime(1, this._ctx.currentTime, GAIN_FADE_DURATION);
  }

  get isMuted() {
    return this._isMuted;
  }

  // ─── Resampler ─────────────────────────────────────────────────────────────

  /**
   * Linear interpolation downsampler.
   * Converts arbitrary sample rate to 16kHz for YAMNet input.
   *
   * @param {Float32Array} input - PCM samples at fromRate
   * @param {number} fromRate - Source sample rate (e.g. 44100)
   * @param {number} toRate - Target sample rate (16000)
   * @returns {Float32Array}
   */
  _resampleLinear(input, fromRate, toRate) {
    if (fromRate === toRate) return input;

    const ratio = fromRate / toRate;
    const outputLength = Math.round(input.length / ratio);
    const output = new Float32Array(outputLength);

    for (let i = 0; i < outputLength; i++) {
      const srcIndex = i * ratio;
      const indexFloor = Math.floor(srcIndex);
      const indexCeil = Math.min(indexFloor + 1, input.length - 1);
      const fraction = srcIndex - indexFloor;

      // Linear interpolation between adjacent samples
      output[i] = input[indexFloor] * (1 - fraction) + input[indexCeil] * fraction;
    }

    return output;
  }

  // ─── Analyser Data ─────────────────────────────────────────────────────────

  /**
   * Get current frequency domain data (for UI visualization, optional).
   * @returns {Uint8Array|null}
   */
  getFrequencyData() {
    if (!this._analyser) return null;
    const data = new Uint8Array(this._analyser.frequencyBinCount);
    this._analyser.getByteFrequencyData(data);
    return data;
  }

  // ─── Gesture Listener Management ─────────────────────────────────────────────

  /**
   * Register gesture listeners to resume suspended AudioContext.
   * BRAVE FIX: We do NOT rely on ctx.state for cleanup — instead, we remove
   * listeners only when the first real audio frame arrives (confirmed in _onAudioProcess).
   * This works reliably across Chrome, Brave, and other Chromium variants.
   */
  _registerGestureListeners() {
    // Remove any existing listeners first (prevent duplicates on re-registration)
    this._removeGestureListeners();

    const tryResume = () => {
      if (!this._ctx) { this._removeGestureListeners(); return; }
      // Try to resume regardless of reported state — Brave may lie about state
      this._ctx.resume().catch(() => {});
    };

    this._gestureHandler = tryResume;
    document.addEventListener('click',      tryResume, { passive: true });
    document.addEventListener('keydown',    tryResume, { passive: true });
    document.addEventListener('scroll',     tryResume, { passive: true });
    document.addEventListener('touchstart', tryResume, { passive: true });
  }

  /**
   * Remove all gesture listeners if still active.
   * Called when first audio frame arrives or on destroy.
   */
  _removeGestureListeners() {
    if (!this._gestureHandler) return;
    document.removeEventListener('click',      this._gestureHandler);
    document.removeEventListener('keydown',    this._gestureHandler);
    document.removeEventListener('scroll',     this._gestureHandler);
    document.removeEventListener('touchstart', this._gestureHandler);
    this._gestureHandler = null;
  }

  // ─── Wait for AudioContext Running ───────────────────────────────────────────

  /**
   * Returns a promise that resolves when the AudioContext is running,
   * or after timeoutMs if it never becomes running.
   * Used to ensure pipeline is actually processing audio before marking ACTIVE.
   *
   * @param {number} timeoutMs
   * @returns {Promise<boolean>} true if running, false if timed out
   */
  waitUntilContextRunning(timeoutMs = 3000) {
    if (!this._ctx || this._ctx.state === 'running') return Promise.resolve(true);

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve(false); // timed out — context still suspended
      }, timeoutMs);

      const check = () => {
        if (!this._ctx) { clearTimeout(timer); resolve(false); return; }
        if (this._ctx.state === 'running') { clearTimeout(timer); resolve(true); }
      };

      // Listen for state change
      const origStateChange = this._ctx.onstatechange;
      this._ctx.onstatechange = (e) => {
        origStateChange?.call(this._ctx, e);
        check();
      };
    });
  }

  // ─── Static Methods ─────────────────────────────────────────────────────────

  /**
   * Returns true if this video element is known to be incompatible
   * (already connected to a MediaElementSource by the page itself).
   * @param {HTMLVideoElement} videoEl
   * @returns {boolean}
   */
  static isIncompatible(videoEl) {
    return incompatibleVideoElements.has(videoEl);
  }

  // ─── Cleanup ───────────────────────────────────────────────────────────────

  destroy() {
    // Clean up visibility handler
    if (this._visibilityHandler) {
      document.removeEventListener('visibilitychange', this._visibilityHandler);
      this._visibilityHandler = null;
    }

    // Remove gesture listeners if they were registered
    this._removeGestureListeners();

    // FIRST: ensure audio keeps flowing to speakers
    // This is critical because createMediaElementSource() captures ALL audio
    // from the video element — if we just disconnect, the video goes silent.
    if (this._source && this._ctx) {
      this._source.disconnect();
      this._source.connect(this._ctx.destination);
    }

    // NOW safe to clean up the rest
    if (this._processor) {
      this._processor.onaudioprocess = null;
      this._processor.disconnect();
    }
    if (this._analyser) this._analyser.disconnect();
    if (this._gain) this._gain.disconnect();
    if (this._silentGain) this._silentGain.disconnect();
    // Do NOT close the AudioContext — the MediaElementSourceNode is permanently
    // bound to it. Closing would make the source unusable on re-navigation.
    // Do NOT disconnect _source — it's now connected directly to destination.

    this._sampleBuffer = [];
    this._totalBuffered = 0;
    this._initialized = false;
    this.onAudioChunk = null;
    console.info('[Sakina:pipeline] Destroyed — audio passthrough active.');
  }
}
