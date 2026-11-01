import { browser } from 'wxt/browser';
import type { EngineClient } from '../engine/client';
import { LIVE_MODEL } from '../engine/models';
import type { Stereo } from '../engine/separator';
import type { Settings } from '../shared/settings';
import { DebugRecorder, debugEnabled } from '../shared/debug';
import { FrameBuffer } from './frameBuffer';
import { LIVE_PRESETS } from './presets';

const RATE = 44100;

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
  /** Absolute frame where the next block starts. */
  private nextBlock = 0;
  private nextSeq = 0;
  private nextOutSeq = 0;
  private readonly ready = new Map<number, Stereo | null>();
  private readonly inFlight = new Set<number>();
  private stopped = false;
  /** Set when the extension's debug flag is on; see lookahead/debug.ts. */
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

    this.ctx = new AudioContext({ sampleRate: RATE, latencyHint: 'playback' });
    await this.ctx.audioWorklet.addModule(browser.runtime.getURL('/worklets/live-io.js'));
    this.node = new AudioWorkletNode(this.ctx, 'music-remover-live-io', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
    });
    this.node.port.onmessage = (event: MessageEvent<{ type: string; channels: Stereo }>) => {
      if (event.data.type === 'capture') this.onCapture(event.data.channels);
    };
    this.applyPreset();
    const source = this.ctx.createMediaStreamSource(this.stream);
    source.connect(this.node).connect(this.ctx.destination);
    if (debugEnabled()) this.recorder = new DebugRecorder(this.ctx, this.node, source);
    this.engine.preload(LIVE_MODEL);
  }

  updateSettings(settings: Settings) {
    const latencyChanged = settings.liveLatency !== this.settings.liveLatency;
    this.settings = settings;
    if (latencyChanged) this.applyPreset();
  }

  stop(error?: string) {
    if (this.stopped) return;
    this.stopped = true;
    this.engine.cancel([...this.inFlight]);
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    void this.ctx?.close();
    this.onEnded(error);
  }

  private applyPreset() {
    const p = LIVE_PRESETS[this.settings.liveLatency];
    this.block = Math.round(p.block * RATE);
    this.future = Math.round(p.future * RATE);
    this.past = Math.round(p.past * RATE);
    // Restart the block grid at the newest audio; in-flight blocks still drain in order.
    this.nextBlock = Math.max(this.nextBlock, this.input.end);
    this.node?.port.postMessage({
      type: 'config',
      prebuffer: Math.round(this.block / 2),
      maxQueued: this.block * 3,
    });
  }

  private onCapture(channels: Stereo) {
    if (this.stopped) return;
    this.input.append(channels);
    this.schedule();
  }

  private schedule() {
    const { block, future, past } = this;
    // If the model falls behind, skip blocks (they play as silence) so the delay stays bounded.
    while (this.input.end - (this.nextBlock + block + future) > 3 * block) {
      this.deliver(this.nextSeq++, null);
      this.nextBlock += block;
    }

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
        sampleRate: RATE,
        left,
        right,
        keepFromSec: (blockStart - windowStart) / RATE,
        keepToSec: (blockStart - windowStart + block) / RATE,
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

  /** Sends finished blocks to the audio thread strictly in order. */
  private deliver(seq: number, out: Stereo | null) {
    this.ready.set(seq, out);
    while (this.ready.has(this.nextOutSeq)) {
      const audio = this.ready.get(this.nextOutSeq) ?? [new Float32Array(this.block), new Float32Array(this.block)];
      this.ready.delete(this.nextOutSeq++);
      this.node?.port.postMessage({ type: 'audio', channels: audio }, [audio[0].buffer, audio[1].buffer]);
    }
  }
}
