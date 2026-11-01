// The live worklet's jitter buffer, driven render quantum by render quantum with
// an identity "model" whose answers arrive after a chosen number of quanta.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { LIVE_CAPTURE_BATCH, LIVE_CUSHION, LIVE_PRESETS } from '../src/live/presets';

const QUANTUM = 128;
const { block: BLOCK, future: FUTURE } = LIVE_PRESETS.balanced;

interface Port {
  sent: { type: string; channels?: Float32Array[]; underruns?: number; dropped?: number; cushion?: number }[];
  onmessage: (event: { data: unknown }) => void;
  postMessage(msg: unknown): void;
}
interface Processor {
  port: Port;
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

function createWorklet(): Processor {
  let Ctor: new (options: object) => Processor = undefined!;
  class AudioWorkletProcessor {
    port = { sent: [] as unknown[], onmessage: undefined, postMessage(msg: unknown) { this.sent.push(msg); } };
  }
  runInNewContext(readFileSync(join(import.meta.dirname, '../public/worklets/live-io.js'), 'utf8'), {
    sampleRate: 44100,
    currentTime: 0,
    AudioWorkletProcessor,
    registerProcessor: (_: string, ctor: typeof Ctor) => (Ctor = ctor),
    Float32Array,
    Math,
  });
  const node = new Ctor({ processorOptions: { batch: LIVE_CAPTURE_BATCH } });
  node.port.onmessage({ data: { type: 'config', cushion: LIVE_CUSHION } });
  return node;
}

/**
 * Plays `seconds` of input whose samples are their own frame number (from 1),
 * so each output sample tells how late it is. `computeQuanta(n)` is how long
 * block n takes to come back; blocks are delivered in order, like LiveSession does.
 */
function simulate(seconds: number, computeQuanta: (n: number) => number) {
  const node = createWorklet();
  const pending: { at: number; frames: Float32Array }[] = [];
  let captured = 0;
  let nextBlock = 0;
  let blocks = 0;
  /** Delay in frames at the start of each quantum, or NaN while silent or crossfading. */
  const delays: number[] = [];
  let gapsAfterStart = 0;

  for (let q = 0; q < Math.ceil((seconds * 44100) / QUANTUM); q++) {
    while (pending.length && pending[0].at <= q) {
      const { frames } = pending.shift()!;
      node.port.onmessage({ data: { type: 'audio', channels: [frames, frames.slice()] } });
    }
    const t = q * QUANTUM;
    const input = Float32Array.from({ length: QUANTUM }, (_, i) => t + i + 1);
    const out = [new Float32Array(QUANTUM), new Float32Array(QUANTUM)];
    node.process([[input, input]], [out]);

    for (const msg of node.port.sent.splice(0)) if (msg.type === 'capture') captured += msg.channels![0].length;
    while (captured >= nextBlock + BLOCK + FUTURE) {
      const start = nextBlock;
      const at = Math.max(q + 1 + computeQuanta(blocks++), pending.at(-1)?.at ?? 0);
      pending.push({ at, frames: Float32Array.from({ length: BLOCK }, (_, i) => start + i + 1) });
      nextBlock += BLOCK;
    }

    const lags = Array.from(out[0], (v, i) => (v === 0 ? NaN : t + i + 1 - v));
    const steady = lags.every((lag) => lag === lags[0]);
    delays.push(steady ? lags[0] : NaN);
    if (delays.some((d) => !Number.isNaN(d))) gapsAfterStart += lags.filter(Number.isNaN).length;
  }
  node.port.onmessage({ data: { type: 'stats' } });
  const stats = node.port.sent.find((m) => m.type === 'stats')!;
  const playing = delays.filter((d) => !Number.isNaN(d));
  return { first: playing[0], last: playing.at(-1)!, max: Math.max(...playing), gapsAfterStart, stats };
}

describe('live jitter buffer', () => {
  // About 29 ms of model time per block.
  const NORMAL = 10;

  it('keeps a constant delay of block + future + model time + cushion', () => {
    const run = simulate(5, () => NORMAL);
    expect(run.stats).toMatchObject({ underruns: 0, dropped: 0 });
    expect(run.gapsAfterStart).toBe(0);
    expect(run.last).toBe(run.first);
    expect(run.first).toBeGreaterThanOrEqual(BLOCK + FUTURE + NORMAL * QUANTUM + LIVE_CUSHION);
    expect(run.first).toBeLessThan(BLOCK + FUTURE + (NORMAL + 1) * QUANTUM + LIVE_CUSHION + LIVE_CAPTURE_BATCH);
  });

  it('after a late block, grows the cushion a little and sheds the rest of the extra delay', () => {
    const steady = simulate(5, () => NORMAL).first;
    // One block takes 100 ms instead of 29 ms.
    const run = simulate(5, (n) => (n === 40 ? NORMAL + 25 : NORMAL));
    expect(run.stats.underruns).toBe(1);
    expect(run.stats.cushion).toBe(LIVE_CUSHION + 512);
    expect(run.stats.dropped).toBeGreaterThan(0);
    expect(run.last).toBeLessThanOrEqual(steady + 512 + QUANTUM);
  });

  it('sheds the delay a slow first block would otherwise add for good', () => {
    const steady = simulate(5, () => NORMAL).first;
    const run = simulate(5, (n) => (n === 0 ? NORMAL + 40 : NORMAL));
    expect(run.stats.underruns).toBe(0);
    expect(run.first).toBeGreaterThan(steady + 30 * QUANTUM);
    expect(run.last).toBeLessThanOrEqual(steady + QUANTUM);
    expect(run.gapsAfterStart).toBe(0);
  });
});
