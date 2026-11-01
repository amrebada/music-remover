import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Stereo } from '../src/engine/separator';
import { type ElementRouter, SyncPlayer } from '../src/lookahead/syncPlayer';
import { VoiceStore } from '../src/lookahead/voiceStore';

class FakeSource {
  buffer?: { duration: number };
  playbackRate = { value: 1 };
  started?: [number, number | undefined];
  stopped = false;
  onended: (() => void) | null = null;
  connect() {}
  start(when: number, offset?: number) {
    this.started = [when, offset];
  }
  stop() {
    this.stopped = true;
  }
}

function setup() {
  const sources: FakeSource[] = [];
  const ctx = {
    currentTime: 10,
    createBuffer: (_channels: number, length: number, rate: number) => ({ duration: length / rate, copyToChannel() {} }),
    createBufferSource: () => {
      const source = new FakeSource();
      sources.push(source);
      return source;
    },
  };
  const element = Object.assign(new EventTarget(), {
    paused: false,
    seeking: false,
    ended: false,
    readyState: 4,
    currentTime: 2.5,
    playbackRate: 1,
  });
  const setOriginal = vi.fn();
  const router = { ctx, voice: {}, element, running: true, setOriginal } as unknown as ElementRouter;
  const store = new VoiceStore();
  const voice = (seconds: number): Stereo => [new Float32Array(seconds * 100), new Float32Array(seconds * 100)];
  store.set(0, { start: 0, end: 4, rate: 100, channels: voice(4) });
  store.set(1, { start: 4, end: 8, rate: 100, channels: voice(4) });
  const player = new SyncPlayer(router, store);
  return { sources, ctx, element, setOriginal, store, player };
}

describe('SyncPlayer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('starts the current block mid-way and queues the next one back to back', () => {
    const { sources, player } = setup();
    player.tick();
    expect(sources).toHaveLength(2);
    expect(sources[0].started).toEqual([10, 2.5]);
    expect(sources[1].started).toEqual([11.5, undefined]);
  });

  it('re-anchors when the video drifts away from the audio clock', () => {
    const { sources, ctx, element, player } = setup();
    player.tick();
    ctx.currentTime = 11;
    element.currentTime = 3.52; // 20 ms off: within tolerance
    player.tick();
    expect(sources.some((s) => s.stopped)).toBe(false);

    element.currentTime = 3.8; // 300 ms off
    player.tick();
    expect(sources[0].stopped && sources[1].stopped).toBe(true);
    expect(sources[2].started).toEqual([11, 3.8]);
  });

  it('stops on pause and plays the playback rate', () => {
    const { sources, element, player } = setup();
    player.tick();
    element.paused = true;
    element.dispatchEvent(new Event('pause'));
    expect(sources.every((s) => s.stopped)).toBe(true);

    element.paused = false;
    element.playbackRate = 2;
    player.tick();
    expect(sources[2].playbackRate.value).toBe(2);
    // Block 1 starts 1.5 s of media later, which is 0.75 s of real time at 2×.
    expect(sources[3].started).toEqual([10.75, undefined]);
  });

  it('only lets the original through where nothing is cleaned yet, when asked to', () => {
    const { element, setOriginal, player } = setup();
    player.configure(true, true);
    expect(setOriginal).toHaveBeenLastCalledWith(false);
    element.currentTime = 9;
    player.tick();
    expect(setOriginal).toHaveBeenLastCalledWith(true);
    player.configure(true, false);
    expect(setOriginal).toHaveBeenLastCalledWith(false);
  });
});
