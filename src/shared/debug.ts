// Test hook, off unless localStorage['music-remover-debug'] = '1' (the page's
// storage for lookahead mode, the extension's own for live mode). Records the
// processed audio next to the untouched input, so end-to-end tests can check
// music removal and timing.

export const DEBUG_REQUEST = 'music-remover-debug';
export const DEBUG_REPLY = 'music-remover-debug-reply';

export function debugEnabled(): boolean {
  try {
    return localStorage.getItem(DEBUG_REQUEST) === '1';
  } catch {
    return false;
  }
}

export class DebugRecorder {
  private readonly chunks: [Float32Array, Float32Array][] = [];
  private frames = 0;
  readonly rate: number;

  constructor(ctx: BaseAudioContext, processed: AudioNode, original: AudioNode, maxSec = 90) {
    this.rate = ctx.sampleRate;
    const merger = ctx.createChannelMerger(2);
    processed.connect(merger, 0, 0);
    original.connect(merger, 0, 1);
    const recorder = ctx.createScriptProcessor(4096, 2, 1);
    recorder.onaudioprocess = (event) => {
      if (this.frames >= maxSec * this.rate) return;
      const input = event.inputBuffer;
      this.chunks.push([input.getChannelData(0).slice(), input.getChannelData(1).slice()]);
      this.frames += input.length;
    };
    const silent = ctx.createGain();
    silent.gain.value = 0;
    merger.connect(recorder).connect(silent).connect(ctx.destination);
  }

  /** [processed, original], both mono. */
  dump(): [Float32Array, Float32Array] {
    const out: [Float32Array, Float32Array] = [new Float32Array(this.frames), new Float32Array(this.frames)];
    let pos = 0;
    for (const [processed, original] of this.chunks) {
      out[0].set(processed, pos);
      out[1].set(original, pos);
      pos += processed.length;
    }
    return out;
  }
}
