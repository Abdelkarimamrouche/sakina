/**
 * MusicShield — Tests: AudioPipeline (resampler unit tests)
 *
 * We test the pure _resampleLinear function in isolation.
 * The full AudioPipeline class requires AudioContext (browser only),
 * so we test the resampler by extracting its logic.
 */

// ─── Resampler extracted for unit testing ─────────────────────────────────────

/**
 * Linear interpolation resampler (same implementation as AudioPipeline.js)
 * Extracted here to test without browser AudioContext dependency.
 */
function resampleLinear(input, fromRate, toRate) {
  if (fromRate === toRate) return input;

  const ratio = fromRate / toRate;
  const outputLength = Math.round(input.length / ratio);
  const output = new Float32Array(outputLength);

  for (let i = 0; i < outputLength; i++) {
    const srcIndex = i * ratio;
    const indexFloor = Math.floor(srcIndex);
    const indexCeil = Math.min(indexFloor + 1, input.length - 1);
    const fraction = srcIndex - indexFloor;
    output[i] = input[indexFloor] * (1 - fraction) + input[indexCeil] * fraction;
  }

  return output;
}

describe('AudioPipeline: resampleLinear', () => {
  test('returns input unchanged when rates are equal', () => {
    const input = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    const result = resampleLinear(input, 16000, 16000);
    expect(result).toBe(input); // Same reference — no copy made
  });

  test('downsamples 44100 → 16000 to correct output length', () => {
    const inputLength = 44100; // 1 second at 44.1kHz
    const input = new Float32Array(inputLength).fill(0.5);
    const result = resampleLinear(input, 44100, 16000);
    expect(result.length).toBe(16000);
  });

  test('downsamples 48000 → 16000 to correct output length', () => {
    const input = new Float32Array(48000).fill(0.5);
    const result = resampleLinear(input, 48000, 16000);
    expect(result.length).toBe(16000);
  });

  test('preserves DC offset (all same values)', () => {
    const input = new Float32Array(44100).fill(0.7);
    const result = resampleLinear(input, 44100, 16000);
    // All output samples should be ~0.7 (linear interp of equal values)
    for (const sample of result) {
      expect(sample).toBeCloseTo(0.7, 5);
    }
  });

  test('preserves signal amplitude (no clipping)', () => {
    // Generate a 440Hz sine wave at 44.1kHz
    const sampleRate = 44100;
    const freq = 440;
    const input = new Float32Array(sampleRate);
    for (let i = 0; i < sampleRate; i++) {
      input[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate);
    }

    const result = resampleLinear(input, sampleRate, 16000);

    // All samples must stay in [-1, 1]
    for (const sample of result) {
      expect(sample).toBeGreaterThanOrEqual(-1.01);
      expect(sample).toBeLessThanOrEqual(1.01);
    }
  });

  test('handles boundary — last sample does not go out of bounds', () => {
    const input = new Float32Array([0.1, 0.5, 0.9, 1.0]);
    // Should not throw even with very short inputs
    expect(() => resampleLinear(input, 44100, 16000)).not.toThrow();
  });

  test('output is a Float32Array', () => {
    const input = new Float32Array(1000).fill(0.3);
    const result = resampleLinear(input, 44100, 16000);
    expect(result).toBeInstanceOf(Float32Array);
  });

  test('silence in → silence out', () => {
    const input = new Float32Array(44100); // all zeros
    const result = resampleLinear(input, 44100, 16000);
    expect(result.every(v => v === 0)).toBe(true);
  });
});
