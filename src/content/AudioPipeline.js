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
        this._source = this._ctx.createMediaElementSource(this._video);
        sourceNodeCache.set(this._video, { source: this._source, ctx: this._ctx });
      }

      // BUG 1 FIX: Permanent AudioContext recovery handlers.
      // The onstatechange handler auto-resumes if the context suspends for any reason.
      // This replaces the one-shot gesture listeners which only worked once.
      this._ctx.onstatechange = () => {
        if (this._ctx.state === 'suspended') {
          this._ctx.resume().catch(() => {});
        }
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

      // Gesture handler: resume on first user interaction.
      // Needed when AudioContext is created suspended (browser restoring session
      // without user gesture). onstatechange alone cannot handle this case because
      // the context never leaves suspended state — there is no state change to fire on.
      if (this._ctx.state === 'suspended') {
        this._gestureHandler = () => {
          if (this._ctx?.state === 'suspended') {
            this._ctx.resume().catch(() => {});
          }
          // Remove all gesture listeners after first interaction
          document.removeEventListener('click',      this._gestureHandler);
          document.removeEventListener('keydown',    this._gestureHandler);
          document.removeEventListener('scroll',     this._gestureHandler);
          document.removeEventListener('touchstart', this._gestureHandler);
          this._gestureHandler = null;
        };
        document.addEventListener('click',      this._gestureHandler, { passive: true });
        document.addEventListener('keydown',    this._gestureHandler, { passive: true });
        document.addEventListener('scroll',     this._gestureHandler, { passive: true });
        document.addEventListener('touchstart', this._gestureHandler, { passive: true });
      }

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

  // ─── Cleanup ───────────────────────────────────────────────────────────────

  destroy() {
    // BUG 1 FIX: Clean up visibility handler
    if (this._visibilityHandler) {
      document.removeEventListener('visibilitychange', this._visibilityHandler);
      this._visibilityHandler = null;
    }

    // Remove gesture listeners if they were registered
    if (this._gestureHandler) {
      document.removeEventListener('click',      this._gestureHandler);
      document.removeEventListener('keydown',    this._gestureHandler);
      document.removeEventListener('scroll',     this._gestureHandler);
      document.removeEventListener('touchstart', this._gestureHandler);
      this._gestureHandler = null;
    }

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
