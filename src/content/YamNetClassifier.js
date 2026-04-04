/**
 * Sakina — YamNetClassifier
 *
 * Loads YAMNet as a SavedModel/GraphModel from TFHub via tf.loadGraphModel().
 * No npm package required — model is fetched directly from TF Hub and cached
 * in the browser's IndexedDB by TF.js automatically.
 *
 * YAMNet input:  Float32Array of exactly 15600 samples at 16kHz mono
 * YAMNet output: Tensor of shape [N, 521] — one score per AudioSet class
 *
 * Reference: https://tfhub.dev/google/yamnet/1
 * Class map:  https://github.com/tensorflow/models/blob/master/research/audioset/yamnet/yamnet_class_map.csv
 */

import * as tf from '@tensorflow/tfjs';
import {
  YAMNET_MUSIC_CLASS_RANGE,
  YAMNET_INSTRUMENT_CLASS_RANGE,
  MIN_INSTRUMENT_SCORE_FOR_MUSIC,
  INSTRUMENT_THRESHOLD_STRICT,
  YAMNET_SINGING_CLASSES,
  DEFAULT_MUSIC_THRESHOLD,
  YAMNET_FRAME_SAMPLES,
  getYamnetModelUrl,
} from '../shared/constants.js';

/** Classification result object */
export class ClassificationResult {
  constructor(isMusic, confidence, topClass, topClassIndex) {
    this.isMusic = isMusic;
    this.confidence = confidence;
    this.topClass = topClass;
    this.topClassIndex = topClassIndex;
    this.timestamp = Date.now();
  }
}

export class YamNetClassifier {
  constructor() {
    /** @type {tf.GraphModel|null} */
    this._model = null;
    this._loading = false;
    this._loadingPromise = null;
    this._loadError = null;

    /** Configurable settings */
    this.threshold = DEFAULT_MUSIC_THRESHOLD;
    this.muteSinging = true;

    /** Inference performance tracking */
    this._inferenceCount = 0;
    this._totalInferenceMs = 0;
  }

  // ─── Initialization ────────────────────────────────────────────────────────

  get isReady() {
    return this._model !== null;
  }

  get isLoading() {
    return this._loading;
  }

  /**
   * Load the YAMNet TFHub GraphModel.
   * TF.js IndexedDB caching: first load ~13MB, subsequent loads instant.
   *
   * @param {function} [onProgress] - Progress callback (0–100)
   * @returns {Promise<void>}
   */
  async load(onProgress = null) {
    if (this._model) return;
    if (this._loading) return this._loadingPromise;

    this._loading = true;
    this._loadingPromise = this._doLoad(onProgress).finally(() => {
      this._loading = false;
    });

    return this._loadingPromise;
  }

  async _doLoad(onProgress, attempt = 0) {
    const MAX_ATTEMPTS = 3;

    try {
      console.info(`[Sakina:yamnet] Loading model, attempt ${attempt + 1}...`);

      // Select the fastest available backend
      try {
        await tf.setBackend('webgl');
      } catch {
        console.warn('[Sakina:yamnet] WebGL unavailable, falling back to cpu');
        await tf.setBackend('cpu');
      }
      await tf.ready();

      // Load from local extension bundle — instant, no network needed
      this._model = await tf.loadGraphModel(getYamnetModelUrl(), {
        onProgress: onProgress
          ? (fraction) => onProgress(Math.round(fraction * 100))
          : undefined,
      });

      // Warm-up inference to JIT-compile the graph
      await this._warmup();

      console.info(
        `[Sakina:yamnet] Model ready. Backend: ${tf.getBackend()}`
      );

    } catch (err) {
      this._loadError = err;
      console.error(`[Sakina:yamnet] Load attempt ${attempt + 1} failed:`, err);

      if (attempt + 1 < MAX_ATTEMPTS) {
        const delay = 1000 * Math.pow(2, attempt);
        await new Promise(r => setTimeout(r, delay));
        return this._doLoad(onProgress, attempt + 1);
      }

      throw new Error(`YAMNet failed to load after ${MAX_ATTEMPTS} attempts: ${err.message}`);
    }
  }

  async _warmup() {
    const silentFrame = tf.zeros([YAMNET_FRAME_SAMPLES]);
    try {
      const result = this._model.predict(silentFrame);
      if (Array.isArray(result)) {
        result.forEach(t => t.dispose?.());
      } else {
        result.dispose?.();
      }
    } finally {
      silentFrame.dispose();
    }
    console.info('[Sakina:yamnet] Warmup complete.');
  }

  // ─── Classification ────────────────────────────────────────────────────────

  /**
   * Classify a single 16kHz mono audio frame.
   *
   * @param {Float32Array} audioFrame - Exactly YAMNET_FRAME_SAMPLES (15600) samples
   * @returns {Promise<ClassificationResult>}
   */
  async classify(audioFrame) {
    if (!this._model) {
      throw new Error('Model not loaded. Call load() first.');
    }

    if (audioFrame.length !== YAMNET_FRAME_SAMPLES) {
      throw new Error(
        `Expected ${YAMNET_FRAME_SAMPLES} samples, got ${audioFrame.length}`
      );
    }

    const startMs = performance.now();
    let inputTensor = null;
    let outputTensor = null;

    try {
      inputTensor = tf.tensor1d(audioFrame, 'float32');
      const raw = this._model.predict(inputTensor);

      // YAMNet may return [scores, embeddings, spectrogram] or just scores
      outputTensor = Array.isArray(raw) ? raw[0] : raw;

      const scoresArray = await outputTensor.data();

      const result = this._interpretScores(scoresArray);

      this._inferenceCount++;
      this._totalInferenceMs += performance.now() - startMs;

      return result;

    } finally {
      inputTensor?.dispose();
      if (Array.isArray(outputTensor)) {
        outputTensor.forEach(t => t.dispose?.());
      } else {
        outputTensor?.dispose();
      }
    }
  }

  // ─── Score Interpretation ──────────────────────────────────────────────────

  /**
   * Interpret YAMNet's 521-class score vector.
   *
   * Uses instrument presence as a gate for music detection:
   * - Music range (132-276) only triggers if instruments (132-193) are detected
   * - This prevents Quran recitation (no instruments) from being classified
   *   as music even when it scores high on "Middle Eastern music" (class 207)
   *
   * @param {Float32Array|number[]} scores
   * @returns {ClassificationResult}
   */
  _interpretScores(scores) {
    // ── 1. Find global top class (for display/logging only) ──────────────────
    let topIndex = 0;
    let topScore = 0;
    for (let i = 0; i < scores.length; i++) {
      if (scores[i] > topScore) {
        topScore = scores[i];
        topIndex = i;
      }
    }

    // ── 2. Detect musical instruments (132–193) ───────────────────────────────
    // This is the KEY gate: real music has instruments, Quran recitation does not.
    const { min: instrMin, max: instrMax } = YAMNET_INSTRUMENT_CLASS_RANGE;
    let maxInstrumentScore = 0;
    for (let i = instrMin; i <= instrMax; i++) {
      if (scores[i] > maxInstrumentScore) maxInstrumentScore = scores[i];
    }

    // When muteSinging is disabled, the user wants to hear vocal content.
    // Use a stricter threshold so ambient acoustics in Quran recordings
    // do not accidentally trigger the instrument gate.
    const instrumentThreshold = this.muteSinging
      ? MIN_INSTRUMENT_SCORE_FOR_MUSIC  // 0.05 — catches subtle background music
      : INSTRUMENT_THRESHOLD_STRICT;    // 0.15 — only clearly audible instruments
    const hasInstruments = maxInstrumentScore >= instrumentThreshold;

    // ── 3. Music range score (132–276) — gated by instrument presence ─────────
    // If NO instruments detected → score is zeroed out.
    // This prevents Quran recitation from triggering the music range
    // even when YAMNet scores it high on "Middle Eastern music" (class 207).
    let maxMusicScore = 0;
    if (hasInstruments) {
      const { min: musicMin, max: musicMax } = YAMNET_MUSIC_CLASS_RANGE;
      for (let i = musicMin; i <= musicMax; i++) {
        if (scores[i] > maxMusicScore) maxMusicScore = scores[i];
      }
    }

    // ── 4. Singing/vocal score — gated by instruments like music ───────────────
    // YAMNET_SINGING_CLASSES excludes Choir (25), Chant (27), and Mantra (28).
    //
    // KEY INSIGHT: Apply the same instrument gate to singing!
    //   - Singing WITH instruments = music (pop, rock, etc.) → mute
    //   - Singing WITHOUT instruments = possibly religious recitation → DON'T mute
    //
    // This protects Quran recitation which has melody (tajweed) but NO instruments.
    // Without this gate, Quran triggers "Singing" (class 24) and gets muted.
    let maxSingingScore = 0;
    if (this.muteSinging && hasInstruments) {
      for (const i of YAMNET_SINGING_CLASSES) {
        if (scores[i] > maxSingingScore) maxSingingScore = scores[i];
      }
    }

    // ── 5. Final decision ─────────────────────────────────────────────────────
    const effectiveScore = Math.max(maxMusicScore, maxSingingScore);
    const isMusic = effectiveScore >= this.threshold;

    return new ClassificationResult(
      isMusic,
      effectiveScore,
      YAMNET_CLASS_NAMES[topIndex] || `class_${topIndex}`,
      topIndex
    );
  }

  // ─── Config ────────────────────────────────────────────────────────────────

  updateSettings({ threshold, muteSinging } = {}) {
    if (threshold !== undefined) this.threshold = threshold;
    if (muteSinging !== undefined) this.muteSinging = muteSinging;
  }

  // ─── Performance ──────────────────────────────────────────────────────────

  getPerformanceStats() {
    return {
      inferenceCount: this._inferenceCount,
      averageInferenceMs: this._inferenceCount > 0
        ? Math.round(this._totalInferenceMs / this._inferenceCount)
        : 0,
      backend: tf.getBackend(),
      memory: tf.memory(),
    };
  }

  // ─── Cleanup ───────────────────────────────────────────────────────────────

  dispose() {
    this._model?.dispose();
    this._model = null;
    console.info('[Sakina:yamnet] Disposed.');
  }
}

// ─── YAMNet 521 AudioSet Class Names (official class_map.csv ordering) ────────

const YAMNET_CLASS_NAMES = ['Speech','Child speech','Conversation','Narration','Babbling','Speech synthesizer','Shout','Bellow','Whoop','Yell','Children shouting','Screaming','Whispering','Laughter','Baby laughter','Giggle','Snicker','Belly laugh','Chuckle','Crying','Baby cry','Whimper','Wail','Sigh','Singing','Choir','Yodeling','Chant','Mantra','Child singing','Synthetic singing','Rapping','Humming','Groan','Grunt','Whistling','Breathing','Wheeze','Snoring','Gasp','Pant','Snort','Cough','Throat clearing','Sneeze','Sniff','Run','Shuffle','Walk','Chewing','Biting','Gargling','Stomach rumble','Burping','Hiccup','Fart','Hands','Finger snapping','Clapping','Heart sounds','Heart murmur','Cheering','Applause','Chatter','Crowd','Hubbub','Children playing','Animal','Domestic animals','Dog','Bark','Yip','Howl','Bow-wow','Growling','Whimper (dog)','Cat','Purr','Meow','Hiss','Caterwaul','Livestock','Horse','Clip-clop','Neigh','Cattle','Moo','Cowbell','Pig','Oink','Goat','Bleat','Sheep','Fowl','Chicken','Cluck','Crowing','Turkey','Gobble','Duck','Quack','Goose','Honk','Wild animals','Roaring cats (lions)','Roar','Bird','Bird vocalization','Chirp','Squawk','Pigeon','Coo','Crow','Caw','Owl','Hoot','Bird flight','Canidae','Rodents','Mouse','Patter','Insect','Cricket','Mosquito','Fly','Buzz','Bee','Frog','Croak','Snake','Rattle','Whale vocalization','Music','Musical instrument','Plucked string instrument','Guitar','Electric guitar','Bass guitar','Acoustic guitar','Steel guitar','Tapping (guitar technique)','Strum','Banjo','Sitar','Mandolin','Zither','Ukulele','Keyboard (musical)','Piano','Electric piano','Organ','Electronic organ','Hammond organ','Synthesizer','Sampler','Harpsichord','Percussion','Drum kit','Drum machine','Drum','Snare drum','Rimshot','Drum roll','Bass drum','Timpani','Tabla','Cymbal','Hi-hat','Wood block','Tambourine','Rattle (instrument)','Maraca','Gong','Tubular bells','Mallet percussion','Marimba','Glockenspiel','Vibraphone','Steelpan','Orchestra','Brass instrument','French horn','Trumpet','Trombone','Bowed string instrument','String section','Violin','Pizzicato','Cello','Double bass','Wind instrument','Flute','Saxophone','Clarinet','Harp','Bell','Church bell','Jingle bell','Bicycle bell','Tuning fork','Chime','Wind chime','Change ringing (campanology)','Harmonica','Accordion','Bagpipes','Didgeridoo','Shofar','Theremin','Singing bowl','Scratching (performance technique)','Pop music','Hip hop music','Beatboxing','Rock music','Heavy metal','Punk rock','Grunge','Progressive rock','Rock and roll','Psychedelic rock','Rhythm and blues','Soul music','Reggae','Country','Swing music','Bluegrass','Funk','Folk music','Middle Eastern music','Jazz','Disco','Classical music','Opera','Electronic music','House music','Techno','Dubstep','Drum and bass','Electronica','Electronic dance music','Ambient music','Trance music','Music of Latin America','Salsa music','Flamenco','Blues','Music for children','New-age music','Vocal music','A capella','Music of Africa','Afrobeat','Christian music','Gospel music','Music of Asia','Carnatic music','Music of Bollywood','Ska','Traditional music','Independent music','Song','Background music','Theme music','Jingle (music)','Soundtrack music','Lullaby','Video game music','Christmas music','Dance music','Wedding music','Happy music','Sad music','Tender music','Exciting music','Angry music','Scary music','Wind','Rustling leaves','Wind noise (microphone)','Thunderstorm','Thunder','Water','Rain','Raindrop','Rain on surface','Stream','Waterfall','Ocean','Waves','Steam','Gurgling','Fire','Crackle','Vehicle','Boat','Sailboat','Rowboat','Motorboat','Ship','Motor vehicle (road)','Car','Vehicle horn','Toot','Car alarm','Power windows','Skidding','Tire squeal','Car passing by','Race car','Truck','Air brake','Air horn','Reversing beeps','Ice cream truck','Bus','Emergency vehicle','Police car (siren)','Ambulance (siren)','Fire engine','Motorcycle','Traffic noise','Rail transport','Train','Train whistle','Train horn','Railroad car','Train wheels squealing','Subway','Aircraft','Aircraft engine','Jet engine','Propeller','Helicopter','Fixed-wing aircraft','Bicycle','Skateboard','Engine','Light engine (high frequency)','Dental drill','Lawn mower','Chainsaw','Medium engine (mid frequency)','Heavy engine (low frequency)','Engine knocking','Engine starting','Idling','Accelerating','Door','Doorbell','Ding-dong','Sliding door','Slam','Knock','Tap','Squeak','Cupboard open or close','Drawer open or close','Dishes','Cutlery','Chopping (food)','Frying (food)','Microwave oven','Blender','Water tap','Sink (filling or washing)','Bathtub (filling or washing)','Hair dryer','Toilet flush','Toothbrush','Electric toothbrush','Vacuum cleaner','Zipper (clothing)','Keys jangling','Coin (dropping)','Scissors','Electric shaver','Shuffling cards','Typing','Typewriter','Computer keyboard','Writing','Alarm','Telephone','Telephone bell ringing','Ringtone','Telephone dialing','Dial tone','Busy signal','Alarm clock','Siren','Civil defense siren','Buzzer','Smoke detector','Fire alarm','Foghorn','Whistle','Steam whistle','Mechanisms','Ratchet','Clock','Tick','Tick-tock','Gears','Pulleys','Sewing machine','Mechanical fan','Air conditioning','Cash register','Printer','Camera','Single-lens reflex camera','Tools','Hammer','Jackhammer','Sawing','Filing (rasp)','Sanding','Power tool','Drill','Explosion','Gunshot','Machine gun','Fusillade','Artillery fire','Cap gun','Fireworks','Firecracker','Burst','Eruption','Boom','Wood','Chop','Splinter','Crack','Glass','Chink','Shatter','Liquid','Splash','Slosh','Squish','Drip','Pour','Trickle','Gush','Fill (with liquid)','Spray','Pump (liquid)','Stir','Boiling','Sonar','Arrow','Whoosh','Thump','Thunk','Electronic tuner','Effects unit','Chorus effect','Basketball bounce','Bang','Slap','Whack','Smash','Breaking','Bouncing','Whip','Flap','Scratch','Scrape','Rub','Roll','Crushing','Crumpling','Tearing','Beep','Ping','Ding','Clang','Squeal','Creak','Rustle','Whir','Clatter','Sizzle','Clicking','Clickety-clack','Rumble','Plop','Jingle','Hum','Zing','Boing','Crunch','Silence','Sine wave','Harmonic','Chirp tone','Sound effect','Pulse','Inside (small room)','Inside (large room)','Inside (hall)','Outside (urban)','Outside (rural)','Reverberation','Echo','Noise','Environmental noise','Static','Mains hum','Distortion','Sidetone','Cacophony','White noise','Pink noise','Throbbing','Vibration','Television','Radio','Field recording'];
