import { browser } from 'wxt/browser';
import type { EngineClient } from '../engine/client';
import { LIVE_MODEL } from '../engine/models';
import type { Stereo } from '../engine/separator';
import type { Settings } from '../shared/settings';
import { DebugRecorder, debugEnabled } from '../shared/debug';
import { FrameBuffer } from './frameBuffer';
import { LIVE_CAPTURE_BATCH, LIVE_CUSHION, LIVE_PRESETS, LIVE_RATE } from './presets';

/** From the audio worklet: times playback ran dry, frames dropped to cut spare delay, and the current cushion. */
export interface LiveStats {
  underruns: number;
  dropped: number;
  cushion: number;
}

/** Blocks skipped within SKIP_WINDOW_MS before the block size doubles. */
const SKIPS_BEFORE_GROWING = 4;
const SKIP_WINDOW_MS = 5000;
const MAX_SCALE = 4;

/**
 * Captures one tab's audio, cleans it block by block and plays the result.
 * Chrome stops playing a captured tab itself, so only the cleaned audio is heard.
 */
export class LiveSession {
  private ctx?: AudioContext;
  private stream?: MediaStream;
  private node?: AudioWorkletNode;
  private readonly input = new FrameBuffer();
  private block = 0;
  private future = 0;
  private past = 0;
  /**
   * Block size multiplier. Each block pays for its past context again, so on a
   * machine too slow for the preset, longer blocks trade some delay for keeping up.
   */
  private scale = 1;
  private skips: number[] = [];
  /** Absolute frame where the next block starts. */
  private nextBlock = 0;
  private nextSeq = 0;
  private nextOutSeq = 0;
  private readonly ready = new Map<number, Stereo>();
  private readonly inFlight = new Set<number>();
  private stopped = false;
  private skipped = 0;
  private statsWaiter?: (stats: LiveStats) => void;
  /** Set when the extension's debug flag is on; see shared/debug.ts. */
  recorder?: DebugRecorder;

  constructor(
    readonly tabId: number,
    private readonly engine: EngineClient,
    private settings: Settings,
    private readonly onEnded: (error?: string) => void,
  ) {}

  async start(streamId: string) {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } } as MediaTrackConstraints,
      video: false,
    });
    this.stream.getAudioTracks()[0]?.addEventListener('ended', () => this.stop('Tab capture ended'));

    this.ctx = new AudioContext({ sampleRate: LIVE_RATE, latencyHint: 'interactive' });
    await this.ctx.audioWorklet.addModule(browser.runtime.getURL('/worklets/live-io.js'));
    this.node = new AudioWorkletNode(this.ctx, 'music-remover-live-io', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
      processorOptions: { batch: LIVE_CAPTURE_BATCH },
    });
    this.node.port.onmessage = (event: MessageEvent<{ type: string; channels: Stereo } & LiveStats>) => {
      if (event.data.type === 'capture') this.onCapture(event.data.channels);
      else if (event.data.type === 'stats') this.statsWaiter?.(event.data);
    };
    // Start from silent history, so the first blocks take as long to clean as the
    // rest; otherwise they come back early and set a delay later blocks cannot meet.
    const { past } = LIVE_PRESETS[this.settings.liveLatency];
    this.input.append([new Float32Array(past), new Float32Array(past)]);
    this.applyPreset();
    const source = this.ctx.createMediaStreamSource(this.stream);
    source.connect(this.node).connect(this.ctx.destination);
    if (debugEnabled()) this.recorder = new DebugRecorder(this.ctx, this.node, source);
    this.engine.preload(LIVE_MODEL);
  }

  updateSettings(settings: Settings) {
    const latencyChanged = settings.liveLatency !== this.settings.liveLatency;
    this.settings = settings;
    if (latencyChanged) {
      this.scale = 1;
      this.applyPreset();
    }
  }

  stop(error?: string) {
    if (this.stopped) return;
    this.stopped = true;
    this.engine.cancel([...this.inFlight]);
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    void this.ctx?.close();
    this.onEnded(error);
  }

  /** Playback health, for debugging and tests. */
  stats(): Promise<LiveStats & { skipped: number; blockFrames: number }> {
    return new Promise((resolve) => {
      this.statsWaiter = (stats) => resolve({ ...stats, skipped: this.skipped, blockFrames: this.block });
      this.node?.port.postMessage({ type: 'stats' });
    });
  }

  private applyPreset() {
    const p = LIVE_PRESETS[this.settings.liveLatency];
    this.block = p.block * this.scale;
    this.future = p.future;
    this.past = p.past;
    this.skips = [];
    // Restart the block grid at the newest audio; in-flight blocks still drain in order.
    this.nextBlock = Math.max(this.nextBlock, this.input.end);
    this.node?.port.postMessage({ type: 'config', cushion: LIVE_CUSHION });
  }

  private onCapture(channels: Stereo) {
    if (this.stopped) return;
    this.input.append(channels);
    this.schedule();
  }

  private schedule(): void {
    // If the model falls behind, skip blocks (they play as silence) so the delay stays bounded.
    while (this.input.end - (this.nextBlock + this.block + this.future) > 3 * this.block) {
      this.deliver(this.nextSeq++, null);
      this.nextBlock += this.block;
      if (this.noteSkip()) {
        this.schedule();
        return;
      }
    }

    const { block, future, past } = this;
    while (this.inFlight.size < 2 && this.input.end >= this.nextBlock + block + future) {
      const seq = this.nextSeq++;
      const blockStart = this.nextBlock;
      this.nextBlock += block;

      if (!this.engine.isReady(LIVE_MODEL)) {
        // The model is still downloading: play silence or the original, per the setting.
        this.deliver(seq, this.settings.whenNotReady === 'original' ? this.input.slice(blockStart, blockStart + block) : null);
        continue;
      }

      const windowStart = Math.max(this.input.start, blockStart - past);
      const [left, right] = this.input.slice(windowStart, blockStart + block + future);
      const { id, result } = this.engine.separate({
        model: LIVE_MODEL,
        priority: 0,
        sampleRate: LIVE_RATE,
        left,
        right,
        keepFromSec: (blockStart - windowStart) / LIVE_RATE,
        keepToSec: (blockStart - windowStart + block) / LIVE_RATE,
        strength: this.settings.strength,
      });
      this.inFlight.add(id);
      result
        .then(
          (out) => this.deliver(seq, out),
          () => this.deliver(seq, null),
        )
        .finally(() => {
          this.inFlight.delete(id);
          this.schedule();
        });
    }

    this.input.trim(this.nextBlock - past);
  }

  /** Records a skipped block; returns true when it made the blocks longer. */
  private noteSkip(): boolean {
    this.skipped++;
    const now = performance.now();
    this.skips = this.skips.filter((t) => now - t < SKIP_WINDOW_MS);
    this.skips.push(now);
    if (this.skips.length < SKIPS_BEFORE_GROWING || this.scale >= MAX_SCALE) return false;
    this.scale *= 2;
    console.warn(`[music-remover] live mode is falling behind; using ${this.scale}× longer blocks`);
    this.applyPreset();
    return true;
  }

  /** Sends finished blocks to the audio thread strictly in order. */
  private deliver(seq: number, out: Stereo | null) {
    this.ready.set(seq, out ?? [new Float32Array(this.block), new Float32Array(this.block)]);
    while (this.ready.has(this.nextOutSeq)) {
      const audio = this.ready.get(this.nextOutSeq)!;
      this.ready.delete(this.nextOutSeq++);
      this.node?.port.postMessage({ type: 'audio', channels: audio }, [audio[0].buffer, audio[1].buffer]);
    }
  }
}
