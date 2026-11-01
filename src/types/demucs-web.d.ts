declare module 'demucs-web' {
  export const CONSTANTS: {
    SAMPLE_RATE: number;
    FFT_SIZE: number;
    HOP_SIZE: number;
    TRAINING_SAMPLES: number;
    MODEL_SPEC_BINS: number;
    MODEL_SPEC_FRAMES: number;
  };

  export interface Spectrogram {
    real: Float32Array<ArrayBuffer>;
    imag: Float32Array<ArrayBuffer>;
    numFrames: number;
    numBins: number;
  }

  /** In-place radix-2 FFT of a real signal; n must be a power of two. */
  export function fft(realOut: Float32Array, imagOut: Float32Array, realIn: Float32Array, n: number): void;
  /** Inverse FFT, scaled by 1/n. */
  export function ifft(realOut: Float32Array, imagOut: Float32Array, realIn: Float32Array, imagIn: Float32Array, n: number): void;

  /** Frame-major STFT with a periodic Hann window, scaled by 1/sqrt(fftSize). No centring. */
  export function stft(signal: Float32Array<ArrayBuffer>, fftSize: number, hopSize: number): Spectrogram;
  export function istft(
    real: Float32Array<ArrayBuffer>,
    imag: Float32Array<ArrayBuffer>,
    numFrames: number,
    numBins: number,
    fftSize: number,
    hopSize: number,
    length?: number,
  ): Float32Array<ArrayBuffer>;
  export function reflectPad(signal: Float32Array<ArrayBuffer>, padLeft: number, padRight: number): Float32Array<ArrayBuffer>;

  export interface TrackSpec {
    leftReal: Float32Array;
    leftImag: Float32Array;
    rightReal: Float32Array;
    rightImag: Float32Array;
  }

  export function prepareModelInput(
    left: Float32Array<ArrayBuffer>,
    right: Float32Array<ArrayBuffer>,
  ): { waveform: Float32Array<ArrayBuffer>; magSpec: Float32Array<ArrayBuffer>; numBins: number; numFrames: number };
  export function standaloneIspec(spec: TrackSpec, targetLength: number): { left: Float32Array<ArrayBuffer>; right: Float32Array<ArrayBuffer> };
}
