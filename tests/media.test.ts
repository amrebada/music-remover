// Tests against real audio. Generate the fixtures first with `pnpm fixtures`; the
// engine test also needs the Open-Unmix model at fixtures/models/umx-vocals.onnx.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ort from 'onnxruntime-web';
import { describe, expect, it } from 'vitest';
import { readWav } from '../scripts/wav.mjs';
import { siSdr } from '../src/engine/metrics';
import { MODEL_RATE, type Stereo } from '../src/engine/separator';
import { DemucsSeparator } from '../src/engine/demucs';
import { UmxSeparator } from '../src/engine/umx';
import { demux } from '../src/lookahead/demux';
import { FragmentAssembler } from '../src/lookahead/fragments';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures');
const fixture = (name: string) => join(FIXTURES, name);
const toArrayBuffer = (buf: Buffer) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;

function split(bytes: ArrayBuffer, sizes: number[]): ArrayBuffer[] {
  const parts: ArrayBuffer[] = [];
  let pos = 0;
  for (let i = 0; pos < bytes.byteLength; i++) {
    const size = sizes[i % sizes.length];
    parts.push(bytes.slice(pos, pos + size));
    pos += size;
  }
  return parts;
}

describe.skipIf(!existsSync(fixture('mix-audio.mp4')))('fragmented MP4 demuxing', () => {
  for (const name of ['mix-audio.mp4', 'mix-muxed.mp4']) {
    it(`finds the init segment and every fragment in ${name}, however it is appended`, () => {
      const bytes = toArrayBuffer(readFileSync(fixture(name)));
      const whole = new FragmentAssembler().push(bytes);
      expect(whole.init).toBeDefined();
      expect(whole.fragments.length).toBeGreaterThan(5);

      const assembler = new FragmentAssembler();
      let init: ArrayBuffer | undefined;
      const fragments: ArrayBuffer[] = [];
      for (const part of split(bytes, [1000, 37, 65536, 9])) {
        const out = assembler.push(part);
        init ??= out.init;
        fragments.push(...out.fragments);
      }
      expect(init?.byteLength).toBe(whole.init!.byteLength);
      expect(fragments.map((f) => f.byteLength)).toEqual(whole.fragments.map((f) => f.byteLength));
    });

    it(`extracts contiguous AAC samples from ${name}`, () => {
      const { init, fragments } = new FragmentAssembler().push(toArrayBuffer(readFileSync(fixture(name))));
      const { track } = demux(init!);
      expect(track).toMatchObject({ codec: 'mp4a.40.2', sampleRate: 44100, channels: 2 });
      expect(track!.description?.length).toBeGreaterThan(0);

      const samples = fragments.flatMap((f) => demux(init!, f).samples);
      // Consecutive frames must line up with no gaps, across fragment boundaries too.
      for (let i = 1; i < samples.length; i++) {
        expect(samples[i].timestamp).toBeCloseTo(samples[i - 1].timestamp + samples[i - 1].duration, 6);
      }
      const end = samples.at(-1)!.timestamp + samples.at(-1)!.duration;
      expect(end).toBeGreaterThan(20);
      expect(samples[0].timestamp).toBeLessThan(0.05);
    });
  }
});

const HTDEMUCS_MODEL = fixture('models/htdemucs.onnx');

// HTDemucs runs on the GPU in the extension; on Node's single-threaded WASM one window takes a while.
describe.skipIf(!existsSync(HTDEMUCS_MODEL) || !existsSync(fixture('mix.wav')))('HTDemucs separator', () => {
  it('raises the voice SI-SDR on one lookahead window', { timeout: 600_000 }, async () => {
    ort.env.wasm.numThreads = 1;
    const session = await ort.InferenceSession.create(readFileSync(HTDEMUCS_MODEL), { graphOptimizationLevel: 'basic' });
    const separator = new DemucsSeparator(ort, session);
    const mix = readWav(fixture('mix.wav')) as Stereo;
    const speech = readWav(fixture('speech.wav'));

    // Block [3, 8.6) s with 1 s of context each side, as in models.ts.
    const [from, keepFrom, keepTo, to] = [2, 3, 8.6, 9.6].map((s) => Math.round(s * MODEL_RATE));
    const voice = await separator.separateVoice([mix[0].slice(from, to), mix[1].slice(from, to)]);
    const kept = voice[0].subarray(keepFrom - from, keepTo - from);
    const before = siSdr(mix[0].subarray(keepFrom, keepTo), speech[0].subarray(keepFrom, keepTo));
    const after = siSdr(kept, speech[0].subarray(keepFrom, keepTo));
    console.log(`HTDemucs SI-SDR ${before.toFixed(1)} → ${after.toFixed(1)} dB`);
    expect(after - before).toBeGreaterThan(4);
  });
});

const UMX_MODEL = fixture('models/umx-vocals.onnx');

describe.skipIf(!existsSync(UMX_MODEL) || !existsSync(fixture('mix.wav')))('Open-Unmix separator', () => {
  it('raises the voice SI-SDR on a speech + music mix', async () => {
    ort.env.wasm.numThreads = 1;
    const session = await ort.InferenceSession.create(readFileSync(UMX_MODEL));
    const separator = new UmxSeparator(ort, session);
    const mix = readWav(fixture('mix.wav')) as Stereo;
    const speech = readWav(fixture('speech.wav'));

    // Process 10 s the way lookahead does: a 4 s block with 1.5 s of context each side.
    const voice: Float32Array[] = [];
    for (let start = 0; start < 10 * MODEL_RATE; start += 4 * MODEL_RATE) {
      const from = Math.max(0, start - 1.5 * MODEL_RATE);
      const to = Math.min(mix[0].length, start + 5.5 * MODEL_RATE);
      const out = await separator.separateVoice([mix[0].slice(from, to), mix[1].slice(from, to)]);
      voice.push(out[0].slice(start - from, start - from + 4 * MODEL_RATE));
    }
    const length = 10 * MODEL_RATE;
    const estimate = new Float32Array(length);
    let pos = 0;
    for (const part of voice) {
      estimate.set(part.subarray(0, length - pos), pos);
      pos += part.length;
    }
    const before = siSdr(mix[0].subarray(0, length), speech[0].subarray(0, length));
    const after = siSdr(estimate, speech[0].subarray(0, length));
    expect(after - before).toBeGreaterThan(4);
  });
});
