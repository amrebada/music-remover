import { describe, expect, it } from 'vitest';
import { mixRegion, resample, type Stereo } from '../src/engine/separator';
import { FrameBuffer } from '../src/live/frameBuffer';
import { blockAt, planNextJob, type PlanInput } from '../src/lookahead/planner';
import { PcmTimeline } from '../src/lookahead/timeline';
import { VoiceStore } from '../src/lookahead/voiceStore';
import { decodePcm, encodePcm } from '../src/shared/pcm';

const ramp = (n: number, offset = 0) => Float32Array.from({ length: n }, (_, i) => ((i + offset) % 1000) / 1000);
const stereo = (n: number, offset = 0): Stereo => [ramp(n, offset), ramp(n, offset).map((v) => -v)];

describe('pcm', () => {
  it('round-trips through base64 16-bit PCM', () => {
    const input = stereo(1234);
    const [left, right] = decodePcm(encodePcm(input), 2);
    expect(left.length).toBe(1234);
    for (let i = 0; i < 1234; i++) {
      expect(left[i]).toBeCloseTo(input[0][i], 4);
      expect(right[i]).toBeCloseTo(input[1][i], 4);
    }
  });

  it('clips out-of-range samples', () => {
    const [left] = decodePcm(encodePcm([Float32Array.of(2, -2), Float32Array.of(0, 0)]), 2);
    expect(left[0]).toBeCloseTo(1, 3);
    expect(left[1]).toBeCloseTo(-1, 3);
  });
});

describe('separator helpers', () => {
  it('mixRegion keeps voice and scales the rest by 1 - strength', () => {
    const input: Stereo = [Float32Array.of(1, 1, 1, 1), Float32Array.of(2, 2, 2, 2)];
    const voice: Stereo = [Float32Array.of(0.25, 0.25, 0.25, 0.25), Float32Array.of(1, 1, 1, 1)];
    expect(Array.from(mixRegion(input, voice, 1, 1, 3)[0])).toEqual([0.25, 0.25]);
    const half = mixRegion(input, voice, 0.5, 0, 4);
    expect(half[0][0]).toBeCloseTo(0.625);
    expect(half[1][0]).toBeCloseTo(1.5);
    expect(Array.from(mixRegion(input, voice, 0, 0, 2)[1])).toEqual([2, 2]);
  });

  it('resample keeps duration and is a no-op at the same rate', () => {
    const x = ramp(48000);
    expect(resample(x, 44100, 44100)).toBe(x);
    expect(resample(x, 48000, 44100).length).toBe(44100);
  });
});

describe('FrameBuffer', () => {
  it('appends, slices across growth and trims', () => {
    const buf = new FrameBuffer(10);
    for (let i = 0; i < 10; i++) buf.append(stereo(7, i * 7));
    expect(buf.end).toBe(70);
    expect(Array.from(buf.slice(20, 25)[0])).toEqual(Array.from(ramp(5, 20)));
    buf.trim(30);
    expect(buf.start).toBe(30);
    // Trimmed frames read as silence.
    expect(Array.from(buf.slice(28, 32)[0])).toEqual([0, 0, 0.03, 0.031].map((v) => Math.fround(v)));
    buf.append(stereo(100, 70));
    expect(buf.slice(160, 170)[0][9]).toBeCloseTo(0.169);
  });
});

describe('PcmTimeline', () => {
  const rate = 1000;

  it('reads contiguous chunks and reports coverage', () => {
    const t = new PcmTimeline();
    t.add(0, rate, stereo(1000, 0));
    t.add(1, rate, stereo(1000, 1000));
    expect(t.coveredUntil(0.5)).toBeCloseTo(2);
    expect(t.coveredFrom(1.5)).toBeCloseTo(0);
    const read = t.read(0.9, 1.1)!;
    expect(read[0].length).toBe(200);
    expect(read[0][150]).toBeCloseTo(ramp(1, 1050)[0]);
  });

  it('returns null for gaps and supports remove/limit', () => {
    const t = new PcmTimeline();
    t.add(0, rate, stereo(1000));
    t.add(2, rate, stereo(1000));
    expect(t.read(0.5, 2.5)).toBeNull();
    expect(t.coveredUntil(2.2)).toBeCloseTo(3);
    t.remove(2, 3);
    expect(t.coveredUntil(2.2)).toBe(2.2);
    t.add(1, rate, stereo(1000));
    t.add(2, rate, stereo(1000));
    t.limit(2);
    expect(t.coveredFrom(2.5)).toBeCloseTo(1);
  });

  it('replaces chunks re-appended at the same time', () => {
    const t = new PcmTimeline();
    t.add(0, rate, [new Float32Array(1000), new Float32Array(1000)]);
    t.add(0, rate, [new Float32Array(1000).fill(0.5), new Float32Array(1000).fill(0.5)]);
    expect(t.read(0, 1)![0][500]).toBe(0.5);
  });

  it('resamples on read', () => {
    const t = new PcmTimeline();
    t.add(0, 48000, stereo(48000));
    expect(t.read(0, 1, 44100)![0].length).toBe(44100);
  });
});

describe('planner', () => {
  const base = (over: Partial<PlanInput>): PlanInput => ({
    playhead: 0,
    duration: 100,
    blockSec: 4,
    contextSec: 1,
    aheadSec: 20,
    isTaken: () => false,
    coveredFrom: () => 0,
    coveredUntil: () => 100,
    ...over,
  });

  it('plans the playhead block first with context on both sides', () => {
    expect(planNextJob(base({ playhead: 5 }))).toEqual({ block: 1, windowStart: 3, windowEnd: 9, keepStart: 4, keepEnd: 8 });
  });

  it('skips taken blocks and stops at the lookahead limit', () => {
    const taken = new Set([1, 2]);
    expect(planNextJob(base({ playhead: 5, isTaken: (b) => taken.has(b) }))?.block).toBe(3);
    expect(planNextJob(base({ playhead: 5, aheadSec: 2, isTaken: (b) => taken.has(b) }))).toBeNull();
  });

  it('waits when the audio is not appended yet', () => {
    expect(planNextJob(base({ playhead: 5, coveredUntil: () => 8.5 }))).toBeNull();
  });

  it('starts mid-block after a seek into freshly appended data', () => {
    const job = planNextJob(base({ playhead: 37.3, coveredFrom: () => 37, coveredUntil: () => 60 }));
    expect(job).toEqual({ block: 9, windowStart: 37, windowEnd: 41, keepStart: 37, keepEnd: 40 });
  });

  it('clamps the last block to the duration', () => {
    expect(planNextJob(base({ playhead: 98, duration: 99 }))).toEqual({ block: 24, windowStart: 95, windowEnd: 99, keepStart: 96, keepEnd: 99 });
    expect(blockAt(8, 4)).toBe(2);
  });

  it('accepts the last block when the decoder held back its final frames', () => {
    const job = planNextJob(base({ playhead: 98, duration: 99, coveredUntil: () => 98.95 }));
    expect(job).toEqual({ block: 24, windowStart: 95, windowEnd: 98.95, keepStart: 96, keepEnd: 98.95 });
    expect(planNextJob(base({ playhead: 98, duration: 99, coveredUntil: () => 98.5 }))).toBeNull();
  });
});

describe('VoiceStore', () => {
  it('reports contiguous ready audio and prunes old blocks', () => {
    const store = new VoiceStore();
    const block = (start: number, end: number) => ({ start, end, rate: 44100, channels: stereo(1) });
    store.set(0, block(0, 4));
    store.set(1, block(4, 8));
    store.set(3, block(12, 16));
    expect(store.readyAhead(1)).toBeCloseTo(7);
    expect(store.at(13)?.start).toBe(12);
    store.prune(50, 30);
    expect(store.has(0)).toBe(false);
  });
});
