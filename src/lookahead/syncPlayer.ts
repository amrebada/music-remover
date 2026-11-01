import type { VoiceBlock, VoiceStore } from './voiceStore';

/** Re-anchor when the cleaned audio drifts this far from the video. */
const MAX_DRIFT_SEC = 0.06;
/** Schedule cleaned audio this far ahead of the playhead. */
const HORIZON_SEC = 3;
const TICK_MS = 200;
/** HTMLMediaElement.HAVE_FUTURE_DATA */
const HAVE_FUTURE_DATA = 3;

/**
 * Routes a media element through Web Audio once, so its own sound can be turned
 * down without touching the site's volume or mute controls. The routing cannot be
 * undone, so it is only created when music removal is on for that element.
 */
export class ElementRouter {
  readonly ctx = new AudioContext({ latencyHint: 'playback' });
  readonly source: MediaElementAudioSourceNode;
  readonly original = this.ctx.createGain();
  readonly voice = this.ctx.createGain();
  /** Everything the user hears from this element. */
  readonly output = this.ctx.createGain();
  private originalTarget = 1;

  constructor(readonly element: HTMLMediaElement) {
    this.source = this.ctx.createMediaElementSource(element);
    this.source.connect(this.original).connect(this.output);
    this.voice.connect(this.output);
    this.output.connect(this.ctx.destination);
    // The element's volume and mute apply to its own output, so mirror them on ours.
    const syncVolume = () => {
      this.voice.gain.value = element.muted ? 0 : element.volume;
    };
    element.addEventListener('volumechange', syncVolume);
    syncVolume();
  }

  get running(): boolean {
    return this.ctx.state === 'running';
  }

  setOriginal(audible: boolean) {
    const target = audible ? 1 : 0;
    if (this.originalTarget === target) return;
    this.originalTarget = target;
    this.original.gain.setTargetAtTime(target, this.ctx.currentTime, 0.01);
  }
}

interface Anchor {
  ctxTime: number;
  mediaTime: number;
  rate: number;
}

/** Plays cleaned blocks in step with the element's clock, muting the original. */
export class SyncPlayer {
  private anchor: Anchor | null = null;
  private readonly scheduled = new Map<number, AudioBufferSourceNode>();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly stopEvents = ['pause', 'seeking', 'waiting', 'ratechange', 'emptied', 'ended'];
  private readonly startEvents = ['playing', 'seeked'];
  private enabled = true;
  private passOriginal = false;

  constructor(
    private readonly router: ElementRouter,
    private readonly store: VoiceStore,
  ) {
    const el = router.element;
    for (const type of this.stopEvents) el.addEventListener(type, this.reset);
    for (const type of this.startEvents) el.addEventListener(type, this.tick);
    this.timer = setInterval(this.tick, TICK_MS);
  }

  /** `passOriginal`: play the original where no cleaned audio is ready yet. */
  configure(enabled: boolean, passOriginal: boolean) {
    this.enabled = enabled;
    this.passOriginal = passOriginal;
    if (!enabled) this.reset();
    this.tick();
  }

  dispose() {
    clearInterval(this.timer);
    const el = this.router.element;
    for (const type of this.stopEvents) el.removeEventListener(type, this.reset);
    for (const type of this.startEvents) el.removeEventListener(type, this.tick);
    this.reset();
    this.router.setOriginal(true);
  }

  /** Stops everything scheduled; the next tick re-anchors. Also call after the store changes. */
  readonly reset = () => {
    for (const node of this.scheduled.values()) node.stop();
    this.scheduled.clear();
    this.anchor = null;
  };

  readonly tick = () => {
    const el = this.router.element;
    if (!this.enabled) {
      this.router.setOriginal(true);
      return;
    }
    const playing = !el.paused && !el.seeking && !el.ended && el.readyState >= HAVE_FUTURE_DATA;
    this.router.setOriginal(this.passOriginal && !this.store.at(el.currentTime));
    if (!playing || !this.router.running) {
      if (this.anchor) this.reset();
      return;
    }

    const now = this.router.ctx.currentTime;
    if (this.anchor) {
      const expected = this.anchor.mediaTime + (now - this.anchor.ctxTime) * this.anchor.rate;
      if (Math.abs(el.currentTime - expected) > MAX_DRIFT_SEC || this.anchor.rate !== el.playbackRate) this.reset();
    }
    this.anchor ??= { ctxTime: now, mediaTime: el.currentTime, rate: el.playbackRate };

    const mediaNow = this.anchor.mediaTime + (now - this.anchor.ctxTime) * this.anchor.rate;
    for (const [key, block] of this.store.entries()) {
      if (this.scheduled.has(key) || block.end <= mediaNow || block.start > mediaNow + HORIZON_SEC) continue;
      this.schedule(key, block, now);
    }
  };

  private schedule(key: number, block: VoiceBlock, now: number) {
    const anchor = this.anchor!;
    const ctx = this.router.ctx;
    const buffer = ctx.createBuffer(2, block.channels[0].length, block.rate);
    buffer.copyToChannel(block.channels[0], 0);
    buffer.copyToChannel(block.channels[1], 1);

    const node = ctx.createBufferSource();
    node.buffer = buffer;
    // Pitch shifts at rates other than 1×; a time-stretcher would fix that.
    node.playbackRate.value = anchor.rate;
    node.connect(this.router.voice);

    const when = anchor.ctxTime + (block.start - anchor.mediaTime) / anchor.rate;
    if (when >= now) {
      node.start(when);
    } else {
      const offset = (now - when) * anchor.rate;
      if (offset >= buffer.duration) return;
      node.start(now, offset);
    }
    node.onended = () => {
      if (this.scheduled.get(key) === node) this.scheduled.delete(key);
    };
    this.scheduled.set(key, node);
  }
}
