/**
 * MusicShield — Tests: MuteController
 *
 * Tests the sliding window debounce algorithm:
 *   - Mute after N consecutive music frames
 *   - Unmute after M consecutive non-music frames
 *   - No oscillation on single-frame noise
 *   - State transitions fire callbacks
 */

import { MuteController } from '../../src/content/MuteController.js';
import { EXTENSION_STATE } from '../../src/shared/constants.js';

// ─── Mocks ────────────────────────────────────────────────────────────────────

function makeMockPipeline() {
  return {
    mute: jest.fn(),
    unmute: jest.fn(),
    isMuted: false,
  };
}

function makeMockClassifier() {
  return {};
}

function makeResult(isMusic, confidence = 0.8, topClass = 'Music') {
  return { isMusic, confidence, topClass };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('MuteController: mute triggering', () => {
  let pipeline, classifier, controller;

  beforeEach(() => {
    pipeline = makeMockPipeline();
    classifier = makeMockClassifier();
    controller = new MuteController(pipeline, classifier);
    // Default thresholds from constants (2 music → mute, 3 non-music → unmute)
  });

  test('mutes on a single music frame (MUTE_TRIGGER_FRAMES=1)', () => {
    pipeline.mute.mockImplementation(() => { pipeline.isMuted = true; });
    controller.processResult(makeResult(true));
    expect(pipeline.mute).toHaveBeenCalledTimes(1);
  });

  test('mutes after MUTE_TRIGGER_FRAMES consecutive music frames', () => {
    // Simulate pipeline.mute() updating isMuted
    pipeline.mute.mockImplementation(() => { pipeline.isMuted = true; });

    for (let i = 0; i < controller.muteThreshold; i++) {
      controller.processResult(makeResult(true));
    }

    expect(pipeline.mute).toHaveBeenCalledTimes(1);
  });

  test('unmutes then re-mutes when non-music frame interrupts', () => {
    pipeline.mute.mockImplementation(() => { pipeline.isMuted = true; });
    pipeline.unmute.mockImplementation(() => { pipeline.isMuted = false; });

    controller.processResult(makeResult(true));    // mutes immediately
    expect(pipeline.mute).toHaveBeenCalledTimes(1);

    // Enough non-music frames to trigger unmute
    for (let i = 0; i < controller.unmuteThreshold; i++) {
      controller.processResult(makeResult(false));
    }
    expect(pipeline.unmute).toHaveBeenCalledTimes(1);

    controller.processResult(makeResult(true));    // re-mutes
    expect(pipeline.mute).toHaveBeenCalledTimes(2);
  });

  test('does not mute again if already muted', () => {
    pipeline.mute.mockImplementation(() => { pipeline.isMuted = true; });

    // Trigger first mute
    for (let i = 0; i < controller.muteThreshold; i++) {
      controller.processResult(makeResult(true));
    }
    expect(pipeline.mute).toHaveBeenCalledTimes(1);

    // More music frames — should not call mute() again
    controller.processResult(makeResult(true));
    controller.processResult(makeResult(true));
    expect(pipeline.mute).toHaveBeenCalledTimes(1);
  });
});

describe('MuteController: unmute triggering', () => {
  let pipeline, classifier, controller;

  beforeEach(() => {
    pipeline = makeMockPipeline();
    classifier = makeMockClassifier();
    controller = new MuteController(pipeline, classifier);

    // Start in muted state
    pipeline.mute.mockImplementation(() => { pipeline.isMuted = true; });
    pipeline.unmute.mockImplementation(() => { pipeline.isMuted = false; });

    for (let i = 0; i < controller.muteThreshold; i++) {
      controller.processResult(makeResult(true));
    }
    expect(pipeline.isMuted).toBe(true);
  });

  test('does NOT unmute on a single non-music frame', () => {
    controller.processResult(makeResult(false));
    expect(pipeline.unmute).not.toHaveBeenCalled();
    expect(pipeline.isMuted).toBe(true);
  });

  test('unmutes after UNMUTE_TRIGGER_FRAMES consecutive non-music frames', () => {
    for (let i = 0; i < controller.unmuteThreshold; i++) {
      controller.processResult(makeResult(false));
    }
    expect(pipeline.unmute).toHaveBeenCalledTimes(1);
    expect(pipeline.isMuted).toBe(false);
  });

  test('resets unmute counter when music frame interrupts', () => {
    // Almost enough non-music frames, then music re-appears
    for (let i = 0; i < controller.unmuteThreshold - 1; i++) {
      controller.processResult(makeResult(false));
    }
    controller.processResult(makeResult(true));   // music re-appears
    controller.processResult(makeResult(false));  // non-music counter resets to 1

    expect(pipeline.unmute).not.toHaveBeenCalled();
    expect(pipeline.isMuted).toBe(true);
  });
});

describe('MuteController: state transitions', () => {
  let pipeline, classifier, controller;

  beforeEach(() => {
    pipeline = makeMockPipeline();
    classifier = makeMockClassifier();
    controller = new MuteController(pipeline, classifier);
    pipeline.mute.mockImplementation(() => { pipeline.isMuted = true; });
    pipeline.unmute.mockImplementation(() => { pipeline.isMuted = false; });
  });

  test('initial state is LISTENING', () => {
    expect(controller.state).toBe(EXTENSION_STATE.LISTENING);
  });

  test('state changes to MUTED after mute trigger', () => {
    const onStateChange = jest.fn();
    controller.onStateChange = onStateChange;

    for (let i = 0; i < controller.muteThreshold; i++) {
      controller.processResult(makeResult(true));
    }

    expect(onStateChange).toHaveBeenCalledWith(EXTENSION_STATE.MUTED);
    expect(controller.state).toBe(EXTENSION_STATE.MUTED);
  });

  test('state returns to LISTENING after unmute', () => {
    const onStateChange = jest.fn();
    controller.onStateChange = onStateChange;

    // Mute
    for (let i = 0; i < controller.muteThreshold; i++) {
      controller.processResult(makeResult(true));
    }

    // Unmute
    for (let i = 0; i < controller.unmuteThreshold; i++) {
      controller.processResult(makeResult(false));
    }

    expect(controller.state).toBe(EXTENSION_STATE.LISTENING);
  });

  test('onStateChange not called if state does not change', () => {
    const onStateChange = jest.fn();
    controller.onStateChange = onStateChange;

    // LISTENING → send speech frames — state stays LISTENING
    controller.processResult(makeResult(false));
    controller.processResult(makeResult(false));

    expect(onStateChange).not.toHaveBeenCalled();
  });
});

describe('MuteController: onClassification callback', () => {
  test('fires on every processResult call', () => {
    const pipeline = makeMockPipeline();
    const controller = new MuteController(pipeline, {});
    const onClassification = jest.fn();
    controller.onClassification = onClassification;

    controller.processResult(makeResult(true, 0.9, 'Piano'));
    controller.processResult(makeResult(false, 0.1, 'Speech'));
    controller.processResult(makeResult(true, 0.7, 'Guitar'));

    expect(onClassification).toHaveBeenCalledTimes(3);
    expect(onClassification).toHaveBeenNthCalledWith(1, {
      isMusic: true, confidence: 0.9, topClass: 'Piano'
    });
  });
});

describe('MuteController: session stats', () => {
  test('tracks mute segment count', () => {
    const pipeline = makeMockPipeline();
    const controller = new MuteController(pipeline, {});
    pipeline.mute.mockImplementation(() => { pipeline.isMuted = true; });
    pipeline.unmute.mockImplementation(() => { pipeline.isMuted = false; });

    // First mute
    for (let i = 0; i < controller.muteThreshold; i++) {
      controller.processResult(makeResult(true));
    }
    // Unmute
    for (let i = 0; i < controller.unmuteThreshold; i++) {
      controller.processResult(makeResult(false));
    }
    // Second mute
    for (let i = 0; i < controller.muteThreshold; i++) {
      controller.processResult(makeResult(true));
    }

    const stats = controller.getSessionStats();
    expect(stats.muteSegmentCount).toBe(2);
    expect(stats.currentlyMuted).toBe(true);
  });
});

describe('MuteController: reset', () => {
  test('unmutes and resets counters', () => {
    const pipeline = makeMockPipeline();
    const controller = new MuteController(pipeline, {});
    pipeline.mute.mockImplementation(() => { pipeline.isMuted = true; });
    pipeline.unmute.mockImplementation(() => { pipeline.isMuted = false; });

    for (let i = 0; i < controller.muteThreshold; i++) {
      controller.processResult(makeResult(true));
    }
    expect(pipeline.isMuted).toBe(true);

    controller.reset();

    expect(pipeline.unmute).toHaveBeenCalled();
    expect(pipeline.isMuted).toBe(false);
    expect(controller.state).toBe(EXTENSION_STATE.LISTENING);
  });
});
