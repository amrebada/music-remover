import type { ModelId } from './models';

export const MODEL_RATE = 44100;

export type Samples = Float32Array<ArrayBuffer>;
export type Stereo = [Samples, Samples];

export interface Separator {
  readonly id: ModelId;
  /** Longest window (in 44.1 kHz frames) one call accepts. */
  readonly maxWindow: number;
  /** Returns the voice estimate for a 44.1 kHz stereo window of the same length. */
  separateVoice(input: Stereo): Promise<Stereo>;
}

/**
 * Mixes `voice + (1 - strength) × music` for frames [from, to), where music is
 * whatever the model did not keep as voice.
 */
export function mixRegion(input: Stereo, voice: Stereo, strength: number, from: number, to: number): Stereo {
  const keep = 1 - strength;
  return [0, 1].map((c) => {
    const out = new Float32Array(to - from);
    for (let i = from; i < to; i++) out[i - from] = voice[c][i] + keep * (input[c][i] - voice[c][i]);
    return out;
  }) as Stereo;
}

/** Linear-interpolation resampler; good enough for speech-band audio. */
export function resample(input: Samples, fromRate: number, toRate: number): Samples {
  if (fromRate === toRate) return input;
  const outLength = Math.round((input.length * toRate) / fromRate);
  const out = new Float32Array(outLength);
  const step = fromRate / toRate;
  for (let i = 0; i < outLength; i++) {
    const pos = i * step;
    const j = Math.floor(pos);
    const frac = pos - j;
    const a = input[Math.min(j, input.length - 1)];
    const b = input[Math.min(j + 1, input.length - 1)];
    out[i] = a + (b - a) * frac;
  }
  return out;
}
