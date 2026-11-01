import type { Stereo } from '../engine/separator';

/** Growable stereo buffer addressed by absolute frame index. */
export class FrameBuffer {
  private data: Stereo;
  /** Absolute frame index of data[*][0]. */
  private base = 0;
  /** First absolute frame still kept. */
  private first = 0;
  private last = 0;

  constructor(initialFrames = 44100 * 8) {
    this.data = [new Float32Array(initialFrames), new Float32Array(initialFrames)];
  }

  get start(): number {
    return this.first;
  }

  get end(): number {
    return this.last;
  }

  append(channels: Stereo) {
    const n = channels[0].length;
    if (this.last + n - this.base > this.data[0].length) {
      const live = this.last - this.first;
      const size = Math.max(this.data[0].length, (live + n) * 2);
      const next: Stereo = [new Float32Array(size), new Float32Array(size)];
      for (let c = 0; c < 2; c++) next[c].set(this.data[c].subarray(this.first - this.base, this.last - this.base));
      this.data = next;
      this.base = this.first;
    }
    for (let c = 0; c < 2; c++) this.data[c].set(channels[c], this.last - this.base);
    this.last += n;
  }

  /** Copies frames [from, to); frames outside the kept range read as silence. */
  slice(from: number, to: number): Stereo {
    return [0, 1].map((c) => {
      const out = new Float32Array(to - from);
      const a = Math.max(from, this.first);
      const b = Math.min(to, this.last);
      if (b > a) out.set(this.data[c].subarray(a - this.base, b - this.base), a - from);
      return out;
    }) as Stereo;
  }

  /** Forgets frames before `frame`. */
  trim(frame: number) {
    this.first = Math.min(Math.max(this.first, frame), this.last);
  }
}
