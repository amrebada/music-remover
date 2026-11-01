import type { Stereo } from '../engine/separator';

export interface VoiceBlock {
  start: number;
  end: number;
  rate: number;
  channels: Stereo;
}

/** Cleaned audio per grid block, ready to be scheduled against the video. */
export class VoiceStore {
  private readonly blocks = new Map<number, VoiceBlock>();

  set(block: number, voice: VoiceBlock) {
    this.blocks.set(block, voice);
  }

  get(block: number): VoiceBlock | undefined {
    return this.blocks.get(block);
  }

  has(block: number): boolean {
    return this.blocks.has(block);
  }

  delete(block: number) {
    this.blocks.delete(block);
  }

  clear() {
    this.blocks.clear();
  }

  entries(): IterableIterator<[number, VoiceBlock]> {
    return this.blocks.entries();
  }

  /** The block playing at `time`, if it is ready. */
  at(time: number): VoiceBlock | undefined {
    for (const block of this.blocks.values()) if (block.start <= time && block.end > time) return block;
    return undefined;
  }

  /** Seconds of contiguous cleaned audio from `time`. */
  readyAhead(time: number): number {
    let end = time;
    for (;;) {
      const block = this.at(end + 1e-3);
      if (!block) return end - time;
      end = block.end;
    }
  }

  /** Drops blocks that ended long before the playhead. */
  prune(time: number, keepBehindSec = 30) {
    for (const [key, block] of this.blocks) if (block.end < time - keepBehindSec) this.blocks.delete(key);
  }
}
