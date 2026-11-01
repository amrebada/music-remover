/** Scale-invariant signal-to-distortion ratio of `estimate` against `reference`, in dB. */
export function siSdr(estimate: Float32Array, reference: Float32Array): number {
  const n = Math.min(estimate.length, reference.length);
  let dot = 0;
  let refEnergy = 0;
  for (let i = 0; i < n; i++) {
    dot += estimate[i] * reference[i];
    refEnergy += reference[i] * reference[i];
  }
  const scale = dot / refEnergy;
  let target = 0;
  let noise = 0;
  for (let i = 0; i < n; i++) {
    const t = scale * reference[i];
    target += t * t;
    noise += (estimate[i] - t) ** 2;
  }
  return 10 * Math.log10(target / noise);
}
