import type { Stereo } from '../engine/separator';

/** Gaps shorter than this between chunks count as contiguous (decoder rounding). */
const GAP = 0.01;

interface Chunk {
  start: number;
  end: number;
  rate: number;
  channels: Stereo;
}

/** Decoded PCM keyed by media time (seconds), as appended by the player. */
export class PcmTimeline {
  private chunks: Chunk[] = [];

  get sampleRate(): number {
    return this.chunks.at(-1)?.rate ?? 44100;
  }

  get isEmpty(): boolean {
    return this.chunks.length === 0;
  }

  add(start: number, rate: number, channels: Stereo) {
    const end = start + channels[0].length / rate;
    // Re-appended media (quality switch, seek back) replaces what was there.
    this.chunks = this.chunks.filter((c) => c.start < start - GAP || c.start >= end - GAP);
    let i = this.chunks.length;
    while (i > 0 && this.chunks[i - 1].start > start) i--;
    this.chunks.splice(i, 0, { start, end, rate, channels });
  }

  /** Forgets everything overlapping [from, to). */
  remove(from: number, to: number) {
    this.chunks = this.chunks.filter((c) => c.end <= from || c.start >= to);
  }

  dropBefore(time: number) {
    this.chunks = this.chunks.filter((c) => c.end >= time);
  }

  clear() {
    this.chunks = [];
  }

  /** Drops the earliest chunks until at most `maxSec` of audio is held. */
  limit(maxSec: number) {
    let total = this.chunks.reduce((sum, c) => sum + (c.end - c.start), 0);
    while (total > maxSec && this.chunks.length > 0) {
      const first = this.chunks.shift()!;
      total -= first.end - first.start;
    }
  }

  private indexAt(time: number): number {
    return this.chunks.findIndex((c) => c.start <= time + GAP && c.end > time);
  }

  /** End of the contiguous data that contains `time`, or `time` if there is none. */
  coveredUntil(time: number): number {
    let i = this.indexAt(time);
    if (i < 0) return time;
    let end = this.chunks[i].end;
    while (++i < this.chunks.length && this.chunks[i].start <= end + GAP) end = Math.max(end, this.chunks[i].end);
    return end;
  }

  /** Start of the contiguous data that contains `time`, or `time` if there is none. */
  coveredFrom(time: number): number {
    let i = this.indexAt(time);
    if (i < 0) return time;
    let start = this.chunks[i].start;
    while (--i >= 0 && this.chunks[i].end >= start - GAP) start = Math.min(start, this.chunks[i].start);
    return start;
  }

  /** Copies [from, to) at `rate`, or returns null if part of it has not been decoded. */
  read(from: number, to: number, rate = this.sampleRate): Stereo | null {
    if (this.coveredFrom(from) > from + GAP || this.coveredUntil(from) < to - GAP) return null;
    const length = Math.round((to - from) * rate);
    const out: Stereo = [new Float32Array(length), new Float32Array(length)];
    for (const c of this.chunks) {
      if (c.end <= from || c.start >= to) continue;
      const first = Math.max(0, Math.ceil((c.start - from) * rate));
      const last = Math.min(length, Math.ceil((c.end - from) * rate));
      const step = c.rate / rate;
      const srcOffset = (from - c.start) * c.rate;
      const srcLength = c.channels[0].length;
      for (let ch = 0; ch < 2; ch++) {
        const src = c.channels[ch];
        const dst = out[ch];
        for (let i = first; i < last; i++) {
          const j = Math.min(srcLength - 1, Math.max(0, Math.round(srcOffset + i * step)));
          dst[i] = src[j];
        }
      }
    }
    return out;
  }
}
