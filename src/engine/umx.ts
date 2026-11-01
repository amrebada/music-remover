import { istft, reflectPad, stft } from 'demucs-web';
import type * as Ort from 'onnxruntime-web';
import type { Separator, Stereo } from './separator';

const N_FFT = 4096;
const HOP = 1024;
const BINS = N_FFT / 2 + 1;
// demucs-web's STFT is scaled by 1/sqrt(N); Open-Unmix was trained on torch.stft's unscaled one.
const MAG_SCALE = Math.sqrt(N_FFT);

/** Open-Unmix HQ vocals: predicts a vocal magnitude that we turn into a ratio mask. */
export class UmxSeparator implements Separator {
  readonly id = 'umx-vocals' as const;
  readonly maxWindow = Infinity;

  constructor(
    private readonly ort: typeof Ort,
    private readonly session: Ort.InferenceSession,
  ) {}

  async separateVoice(input: Stereo): Promise<Stereo> {
    const length = input[0].length;
    // Centred STFT with reflect padding, like torch.stft(center=True).
    const specs = input.map((x) => stft(reflectPad(x, N_FFT / 2, N_FFT / 2), N_FFT, HOP));
    const frames = specs[0].numFrames;

    const mag = new Float32Array(2 * BINS * frames);
    for (let c = 0; c < 2; c++) {
      const { real, imag } = specs[c];
      for (let f = 0; f < frames; f++) {
        for (let b = 0; b < BINS; b++) {
          const i = f * BINS + b;
          mag[c * BINS * frames + b * frames + f] = Math.hypot(real[i], imag[i]) * MAG_SCALE;
        }
      }
    }

    const results = await this.session.run({
      [this.session.inputNames[0]]: new this.ort.Tensor('float32', mag, [1, 2, BINS, frames]),
    });
    const vocals = results[this.session.outputNames[0]].data as Float32Array;

    return specs.map(({ real, imag }, c) => {
      const maskedReal = new Float32Array(real.length);
      const maskedImag = new Float32Array(imag.length);
      for (let f = 0; f < frames; f++) {
        for (let b = 0; b < BINS; b++) {
          const i = f * BINS + b;
          const j = c * BINS * frames + b * frames + f;
          const gain = Math.min(1, vocals[j] / (mag[j] + 1e-8));
          maskedReal[i] = real[i] * gain;
          maskedImag[i] = imag[i] * gain;
        }
      }
      const out = istft(maskedReal, maskedImag, frames, BINS, N_FFT, HOP, length + N_FFT);
      return out.slice(N_FFT / 2, N_FFT / 2 + length);
    }) as Stereo;
  }
}
