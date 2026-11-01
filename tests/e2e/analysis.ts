// Helpers to compare what the browser played against the fixture stems.
import { fft, ifft } from 'demucs-web';

export const ANALYSIS_RATE = 8000;

/** Box-filter then linearly resample to ANALYSIS_RATE. */
export function toAnalysisRate(x: Float32Array, rate: number): Float32Array<ArrayBuffer> {
  const box = Math.max(1, Math.round(rate / ANALYSIS_RATE));
  const smooth = new Float32Array(x.length);
  let acc = 0;
  for (let i = 0; i < x.length; i++) {
    acc += x[i] - (i >= box ? x[i - box] : 0);
    smooth[i] = acc / box;
  }
  const out = new Float32Array(Math.floor((x.length * ANALYSIS_RATE) / rate));
  const step = rate / ANALYSIS_RATE;
  for (let i = 0; i < out.length; i++) out[i] = smooth[Math.min(x.length - 1, Math.round(i * step))];
  return out;
}

/** Lag (in samples) at which `x` best matches `ref`, i.e. x[i + lag] ≈ ref[i]. */
export function bestLag(x: Float32Array, ref: Float32Array): number {
  let n = 1;
  while (n < x.length + ref.length) n *= 2;
  const pad = (a: Float32Array) => {
    const out = new Float32Array(n);
    out.set(a);
    return out;
  };
  const [xr, xi, rr, ri] = [0, 0, 0, 0].map(() => new Float32Array(n));
  fft(xr, xi, pad(x), n);
  fft(rr, ri, pad(ref), n);
  // X · conj(R)
  const cr = new Float32Array(n);
  const ci = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    cr[k] = xr[k] * rr[k] + xi[k] * ri[k];
    ci[k] = xi[k] * rr[k] - xr[k] * ri[k];
  }
  const [outR, outI] = [new Float32Array(n), new Float32Array(n)];
  ifft(outR, outI, cr, ci, n);
  let best = 0;
  for (let k = 1; k < x.length; k++) if (outR[k] > outR[best]) best = k;
  return best;
}

/** Least-squares coefficients for y ≈ a·s + b·m. */
export function fitTwo(y: Float32Array, s: Float32Array, m: Float32Array): { a: number; b: number } {
  let ss = 0;
  let mm = 0;
  let sm = 0;
  let ys = 0;
  let ym = 0;
  for (let i = 0; i < y.length; i++) {
    ss += s[i] * s[i];
    mm += m[i] * m[i];
    sm += s[i] * m[i];
    ys += y[i] * s[i];
    ym += y[i] * m[i];
  }
  const det = ss * mm - sm * sm;
  return { a: (ys * mm - ym * sm) / det, b: (ym * ss - ys * sm) / det };
}
