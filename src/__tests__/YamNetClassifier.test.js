/**
 * Sakina — Tests: YamNetClassifier (score interpretation)
 *
 * We test _interpretScores() in isolation without loading the actual model.
 * The full classify() method requires TensorFlow.js — tested in integration tests.
 */

import { YamNetClassifier } from '../../src/content/YamNetClassifier.js';
import {
  YAMNET_MUSIC_CLASS_RANGE,
  YAMNET_SINGING_CLASSES,
  DEFAULT_MUSIC_THRESHOLD,
} from '../../src/shared/constants.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeScores(overrides = {}) {
  const scores = new Float32Array(521).fill(0.001);
  for (const [index, value] of Object.entries(overrides)) {
    scores[parseInt(index)] = value;
  }
  return scores;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('YamNetClassifier: construction', () => {
  test('initializes with default threshold', () => {
    const clf = new YamNetClassifier();
    expect(clf.threshold).toBe(DEFAULT_MUSIC_THRESHOLD);
  });

  test('isReady is false before load()', () => {
    const clf = new YamNetClassifier();
    expect(clf.isReady).toBe(false);
  });

  test('isLoading is false initially', () => {
    const clf = new YamNetClassifier();
    expect(clf.isLoading).toBe(false);
  });
});

describe('YamNetClassifier: updateSettings', () => {
  test('updates threshold', () => {
    const clf = new YamNetClassifier();
    clf.updateSettings({ threshold: 0.7 });
    expect(clf.threshold).toBe(0.7);
  });

  test('updates muteSinging', () => {
    const clf = new YamNetClassifier();
    clf.updateSettings({ muteSinging: false });
    expect(clf.muteSinging).toBe(false);
  });

  test('ignores undefined values (partial update)', () => {
    const clf = new YamNetClassifier();
    clf.updateSettings({ threshold: 0.6 });
    clf.updateSettings({ muteSinging: false });
    expect(clf.threshold).toBe(0.6); // unchanged
    expect(clf.muteSinging).toBe(false);
  });
});

describe('YamNetClassifier: _interpretScores — music detection', () => {
  let clf;

  beforeEach(() => {
    clf = new YamNetClassifier();
    clf.threshold = 0.45;
    clf.muteSinging = true;
  });

  test('classifies as music when a music class exceeds threshold', () => {
    const { min } = YAMNET_MUSIC_CLASS_RANGE;
    const scores = makeScores({ [min + 5]: 0.8 }); // Strong music signal
    const result = clf._interpretScores(scores);
    expect(result.isMusic).toBe(true);
    expect(result.confidence).toBeCloseTo(0.8, 5);
  });

  test('classifies as NOT music when all scores are low', () => {
    const scores = makeScores(); // All near-zero
    const result = clf._interpretScores(scores);
    expect(result.isMusic).toBe(false);
    expect(result.confidence).toBeLessThan(clf.threshold);
  });

  test('classifies speech as NOT music', () => {
    // Speech class 0 has high confidence
    const scores = makeScores({ 0: 0.95, 1: 0.85 });
    const result = clf._interpretScores(scores);
    expect(result.isMusic).toBe(false);
  });

  test('respects threshold — score above threshold classifies as music', () => {
    // NOTE: makeScores uses Float32Array. 0.45 in Float32 = 0.44999998..., which
    // is < the JS float 0.45. We test with threshold + margin to avoid Float32 precision edge.
    const { min } = YAMNET_MUSIC_CLASS_RANGE;
    const scores = makeScores({ [min + 10]: clf.threshold + 0.01 });
    const result = clf._interpretScores(scores);
    expect(result.isMusic).toBe(true);
  });

  test('respects threshold — score well below threshold is NOT music', () => {
    const { min } = YAMNET_MUSIC_CLASS_RANGE;
    const scores = makeScores({ [min + 10]: clf.threshold - 0.05 });
    const result = clf._interpretScores(scores);
    expect(result.isMusic).toBe(false);
  });

  test('covers all music class range indices', () => {
    const { min, max } = YAMNET_MUSIC_CLASS_RANGE;
    // Test both ends of the range
    for (const idx of [min, min + 1, max - 1, max]) {
      const scores = makeScores({ [idx]: 0.9 });
      const result = clf._interpretScores(scores);
      expect(result.isMusic).toBe(true);
    }
  });
});

describe('YamNetClassifier: _interpretScores — singing', () => {
  let clf;

  beforeEach(() => {
    clf = new YamNetClassifier();
    clf.threshold = 0.45;
  });

  test('classifies singing as music when muteSinging=true', () => {
    clf.muteSinging = true;
    const singingIndex = [...YAMNET_SINGING_CLASSES][0]; // 24 = Singing
    const scores = makeScores({ [singingIndex]: 0.9 });
    const result = clf._interpretScores(scores);
    expect(result.isMusic).toBe(true);
  });

  test('does NOT classify singing as music when muteSinging=false', () => {
    clf.muteSinging = false;
    const singingIndex = [...YAMNET_SINGING_CLASSES][0];
    // Only singing class has high score, no instrument/genre class
    const scores = makeScores({ [singingIndex]: 0.9 });
    const result = clf._interpretScores(scores);
    expect(result.isMusic).toBe(false);
  });
});

describe('YamNetClassifier: _interpretScores — result shape', () => {
  test('result has all required fields', () => {
    const clf = new YamNetClassifier();
    clf.threshold = 0.45;
    const scores = makeScores({ 0: 0.9 }); // Speech
    const result = clf._interpretScores(scores);

    expect(result).toHaveProperty('isMusic');
    expect(result).toHaveProperty('confidence');
    expect(result).toHaveProperty('topClass');
    expect(result).toHaveProperty('topClassIndex');
    expect(result).toHaveProperty('timestamp');
  });

  test('topClassIndex points to highest scoring class', () => {
    const clf = new YamNetClassifier();
    clf.threshold = 0.45;
    const scores = makeScores({ 5: 0.95, 10: 0.8 }); // Class 5 highest
    const result = clf._interpretScores(scores);
    expect(result.topClassIndex).toBe(5);
  });

  test('timestamp is recent', () => {
    const clf = new YamNetClassifier();
    clf.threshold = 0.45;
    const before = Date.now();
    const result = clf._interpretScores(makeScores());
    const after = Date.now();
    expect(result.timestamp).toBeGreaterThanOrEqual(before);
    expect(result.timestamp).toBeLessThanOrEqual(after);
  });
});

describe('YamNetClassifier: getPerformanceStats', () => {
  test('returns zero stats before any inference', () => {
    const clf = new YamNetClassifier();
    const stats = clf.getPerformanceStats();
    expect(stats.inferenceCount).toBe(0);
    expect(stats.averageInferenceMs).toBe(0);
  });
});

describe('YamNetClassifier: dispose', () => {
  test('sets model to null and does not throw', () => {
    const clf = new YamNetClassifier();
    // Simulate a loaded model with a dispose mock
    clf._model = { dispose: jest.fn() };
    expect(() => clf.dispose()).not.toThrow();
    expect(clf._model).toBeNull();
  });

  test('dispose is safe to call when no model loaded', () => {
    const clf = new YamNetClassifier();
    expect(() => clf.dispose()).not.toThrow();
  });
});

describe('YamNetClassifier: load deduplication', () => {
  test('concurrent load() calls resolve together (deduplication)', async () => {
    const clf = new YamNetClassifier();
    // Simulate an in-progress load
    let resolveLoad;
    clf._loading = true;
    clf._loadingPromise = new Promise(r => { resolveLoad = r; });

    const p1 = clf.load();
    const p2 = clf.load();

    // Both calls should be backed by the same underlying _loadingPromise
    // (async wraps in new Promise, so we verify they both settle together)
    resolveLoad();
    await expect(p1).resolves.toBeUndefined();
    await expect(p2).resolves.toBeUndefined();
  });
});

describe('YamNetClassifier: classify validation', () => {
  test('throws if model not loaded', async () => {
    const clf = new YamNetClassifier();
    const frame = new Float32Array(15600);
    await expect(clf.classify(frame)).rejects.toThrow('Model not loaded');
  });

  test('throws if frame size is wrong', async () => {
    const clf = new YamNetClassifier();
    // Simulate loaded model
    clf._model = { predict: jest.fn() };

    const wrongFrame = new Float32Array(100); // Wrong size
    await expect(clf.classify(wrongFrame)).rejects.toThrow('Expected 15600 samples');
  });
});
