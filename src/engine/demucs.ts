import { CONSTANTS, prepareModelInput, standaloneIspec } from 'demucs-web';
import type * as Ort from 'onnxruntime-web';
import type { Separator, Stereo } from './separator';

const SEGMENT = CONSTANTS.TRAINING_SAMPLES;
const SPEC_BINS = CONSTANTS.MODEL_SPEC_BINS;
const SPEC_FRAMES = CONSTANTS.MODEL_SPEC_FRAMES;
const VOCALS = 3; // source order: drums, bass, other, vocals

/** HTDemucs v4. The graph takes one fixed 7.8 s segment; STFT/iSTFT run in JS. */
export class DemucsSeparator implements Separator {
  readonly id = 'htdemucs' as const;
  readonly maxWindow = SEGMENT;

  constructor(
    private readonly ort: typeof Ort,
    private readonly session: Ort.InferenceSession,
  ) {}

  async separateVoice(input: Stereo): Promise<Stereo> {
    const length = input[0].length;
    if (length > SEGMENT) throw new Error(`HTDemucs window too long: ${length} > ${SEGMENT}`);
    const [left, right] = input.map((x) => {
      const padded = new Float32Array(SEGMENT);
      padded.set(x);
      return padded;
    });

    const { waveform, magSpec } = prepareModelInput(left, right);
    const [waveName, specName] = this.session.inputNames;
    const results = await this.session.run({
      [waveName]: new this.ort.Tensor('float32', waveform, [1, 2, SEGMENT]),
      [specName]: new this.ort.Tensor('float32', magSpec, [1, 4, SPEC_BINS, SPEC_FRAMES]),
    });

    let time: Float32Array | undefined;
    let freq: Float32Array | undefined;
    for (const name of this.session.outputNames) {
      const tensor = results[name];
      if (tensor.dims.length === 4) time = tensor.data as Float32Array;
      if (tensor.dims.length === 5) freq = tensor.data as Float32Array;
    }
    if (!time || !freq) throw new Error('Unexpected HTDemucs outputs');

    // Frequency branch for the vocals source: 4 channels (L re, L im, R re, R im) × bins × frames.
    const plane = SPEC_BINS * SPEC_FRAMES;
    const base = VOCALS * 4 * plane;
    const spec = {
      leftReal: freq.subarray(base, base + plane),
      leftImag: freq.subarray(base + plane, base + 2 * plane),
      rightReal: freq.subarray(base + 2 * plane, base + 3 * plane),
      rightImag: freq.subarray(base + 3 * plane, base + 4 * plane),
    };
    const fromFreq = standaloneIspec(spec, SEGMENT);

    // Time branch: [source, channel, sample]; the model output is the sum of both branches.
    const timeBase = VOCALS * 2 * SEGMENT;
    return [fromFreq.left, fromFreq.right].map((branch, c) => {
      const out = new Float32Array(length);
      const offset = timeBase + c * SEGMENT;
      for (let i = 0; i < length; i++) out[i] = branch[i] + time[offset + i];
      return out;
    }) as Stereo;
  }
}
