import type * as Ort from 'onnxruntime-web';
import type { Separator, Stereo } from './separator';
import { Stft } from './stft';

const N_FFT = 4096;
const HOP = 1024;

/** Open-Unmix HQ vocals: predicts a vocal magnitude that we turn into a ratio mask. */
export class UmxSeparator implements Separator {
  readonly id = 'umx-vocals' as const;
  readonly maxWindow = Infinity;
  private readonly stft = new Stft(N_FFT, HOP);

  constructor(
    private readonly ort: typeof Ort,
    private readonly session: Ort.InferenceSession,
  ) {}

  async separateVoice(input: Stereo, keep: [number, number] = [0, input[0].length]): Promise<Stereo> {
    const length = input[0].length;
    const bins = this.stft.bins;
    const specs = this.stft.forward(input[0], input[1]);
    const frames = specs[0].frames;

    // Model input is [1, channel, bin, frame].
    const mag = new Float32Array(2 * bins * frames);
    for (let c = 0; c < 2; c++) {
      const { real, imag } = specs[c];
      for (let f = 0; f < frames; f++) {
        for (let b = 0; b < bins; b++) {
          const i = f * bins + b;
          mag[c * bins * frames + b * frames + f] = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]);
        }
      }
    }

    const results = await this.session.run({
      [this.session.inputNames[0]]: new this.ort.Tensor('float32', mag, [1, 2, bins, frames]),
    });
    const vocals = results[this.session.outputNames[0]].data as Float32Array;

    // Only the frames that overlap the kept region are masked and resynthesised.
    const [from, to] = keep;
    const firstFrame = Math.max(0, Math.floor((from - N_FFT / 2) / HOP));
    const lastFrame = Math.min(frames - 1, Math.ceil((to + N_FFT / 2) / HOP));
    specs.forEach((spec, c) => {
      for (let f = firstFrame; f <= lastFrame; f++) {
        for (let b = 0; b < bins; b++) {
          const i = f * bins + b;
          const j = c * bins * frames + b * frames + f;
          const gain = Math.min(1, vocals[j] / (mag[j] + 1e-8));
          spec.real[i] *= gain;
          spec.imag[i] *= gain;
        }
      }
    });
    return this.stft.inverse(specs, length, from, to);
  }
}
