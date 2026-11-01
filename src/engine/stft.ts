// Centred STFT/iSTFT with a periodic Hann window, unscaled like torch.stft.
// Tables are built once per size, and both channels of a stereo signal share
// one complex FFT (left as the real part, right as the imaginary part).

export interface Spectrum {
  /** Frame-major: index = frame * bins + bin. */
  real: Float32Array<ArrayBuffer>;
  imag: Float32Array<ArrayBuffer>;
  frames: number;
  bins: number;
}

class ComplexFft {
  private readonly rev: Uint32Array;
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;

  constructor(readonly n: number) {
    const bits = Math.log2(n);
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0, x = i; b < bits; b++, x >>= 1) r = (r << 1) | (x & 1);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let k = 0; k < n / 2; k++) {
      this.cos[k] = Math.cos((2 * Math.PI * k) / n);
      this.sin[k] = -Math.sin((2 * Math.PI * k) / n);
    }
  }

  /** In-place forward FFT (inverse = conjugate in and out, then divide by n). */
  transform(re: Float64Array, im: Float64Array) {
    const { n, rev, cos, sin } = this;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const a = start + j;
          const b = a + half;
          const tr = re[b] * cos[k] - im[b] * sin[k];
          const ti = re[b] * sin[k] + im[b] * cos[k];
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
  }
}

export class Stft {
  readonly bins: number;
  private readonly fft: ComplexFft;
  private readonly window: Float64Array;
  private readonly re: Float64Array;
  private readonly im: Float64Array;

  constructor(
    readonly nFft: number,
    readonly hop: number,
  ) {
    this.bins = nFft / 2 + 1;
    this.fft = new ComplexFft(nFft);
    this.window = new Float64Array(nFft);
    for (let i = 0; i < nFft; i++) this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / nFft);
    this.re = new Float64Array(nFft);
    this.im = new Float64Array(nFft);
  }

  /** Number of frames for a signal of `length` samples (centre padding included). */
  frameCount(length: number): number {
    return Math.floor(length / this.hop) + 1;
  }

  /** Frame f is centred on sample f·hop; the signal is reflect-padded at both ends. */
  forward(left: Float32Array, right: Float32Array): [Spectrum, Spectrum] {
    const { nFft, hop, bins, window, re, im } = this;
    const frames = this.frameCount(left.length);
    const specs = [0, 1].map(() => ({
      real: new Float32Array(frames * bins),
      imag: new Float32Array(frames * bins),
      frames,
      bins,
    })) as [Spectrum, Spectrum];
    const [l, r] = specs;
    const half = nFft / 2;
    const last = left.length - 1;
    for (let f = 0; f < frames; f++) {
      const start = f * hop - half;
      for (let i = 0; i < nFft; i++) {
        let j = start + i;
        if (j < 0) j = -j;
        else if (j > last) j = 2 * last - j;
        re[i] = left[j] * window[i];
        im[i] = right[j] * window[i];
      }
      this.fft.transform(re, im);
      // Z = L + iR, so L[k] = (Z[k] + conj Z[n-k]) / 2 and R[k] = (Z[k] - conj Z[n-k]) / 2i.
      const base = f * bins;
      for (let k = 0; k < bins; k++) {
        const m = (nFft - k) & (nFft - 1);
        l.real[base + k] = (re[k] + re[m]) / 2;
        l.imag[base + k] = (im[k] - im[m]) / 2;
        r.real[base + k] = (im[k] + im[m]) / 2;
        r.imag[base + k] = (re[m] - re[k]) / 2;
      }
    }
    return specs;
  }

  /**
   * Overlap-adds frames back into a stereo signal of `length` samples, but only
   * resynthesises frames that touch [from, to); samples outside are left at 0.
   */
  inverse(
    [l, r]: [Spectrum, Spectrum],
    length: number,
    from = 0,
    to = length,
  ): [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>] {
    const { nFft, hop, bins, window, re, im } = this;
    const half = nFft / 2;
    const left = new Float32Array(length);
    const right = new Float32Array(length);
    const norm = new Float32Array(length);
    const firstFrame = Math.max(0, Math.floor((from - half) / hop));
    const lastFrame = Math.min(l.frames - 1, Math.ceil((to + half) / hop));
    for (let f = firstFrame; f <= lastFrame; f++) {
      const base = f * bins;
      // Z = L + iR has real part left and imaginary part right after the inverse.
      // The inverse runs as conj(FFT(conj Z)) / n, so build conj Z directly.
      for (let k = 0; k < bins; k++) {
        re[k] = l.real[base + k] - r.imag[base + k];
        im[k] = -(l.imag[base + k] + r.real[base + k]);
      }
      for (let k = bins; k < nFft; k++) {
        // Bins above Nyquist come from the Hermitian halves of L and R.
        const m = base + nFft - k;
        re[k] = l.real[m] + r.imag[m];
        im[k] = l.imag[m] - r.real[m];
      }
      this.fft.transform(re, im);
      const start = f * hop - half;
      for (let i = 0; i < nFft; i++) {
        const j = start + i;
        if (j < 0 || j >= length) continue;
        left[j] += (re[i] / nFft) * window[i];
        right[j] -= (im[i] / nFft) * window[i];
        norm[j] += window[i] * window[i];
      }
    }
    for (let i = from; i < to; i++) {
      if (norm[i] > 1e-8) {
        left[i] /= norm[i];
        right[i] /= norm[i];
      }
    }
    return [left, right];
  }
}
