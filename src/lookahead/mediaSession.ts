import { MODEL_FOR_QUALITY, MODELS } from '../engine/models';
import { MODEL_RATE } from '../engine/separator';
import type { Settings } from '../shared/settings';
import type { EngineLink } from './engineLink';
import { blockAt, planNextJob } from './planner';
import { type ElementRouter, SyncPlayer } from './syncPlayer';
import type { PcmTimeline } from './timeline';
import { VoiceStore } from './voiceStore';

/** How far ahead of the playhead to clean audio. */
const AHEAD_SEC = 45;
/**
 * Decoded audio kept behind the playhead. Players do not re-append what is still
 * in their buffer, so seeking back needs it; most keep 30–90 s.
 */
const BEHIND_SEC = 90;
const MAX_IN_FLIGHT = 2;
const RETRY_MS = 5000;

/** Cleans one media element's audio ahead of its playhead and plays it in sync. */
export class MediaSession {
  private readonly store = new VoiceStore();
  private readonly player: SyncPlayer;
  /** Block → engine request id. */
  private readonly inFlight = new Map<number, number>();
  /** Bumped when settings change, so results computed with the old ones are dropped. */
  private generation = 0;
  private retryAt = 0;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    readonly element: HTMLMediaElement,
    readonly router: ElementRouter,
    private readonly timeline: PcmTimeline,
    private readonly link: EngineLink,
    private settings: Settings,
  ) {
    this.player = new SyncPlayer(router, this.store);
    element.addEventListener('seeking', this.onSeeking);
    this.timer = setInterval(() => this.pump(), 250);
    this.player.configure(settings.enabled, settings.whenNotReady === 'original');
    this.pump();
  }

  private get model() {
    return MODELS[MODEL_FOR_QUALITY[this.settings.quality]];
  }

  applySettings(settings: Settings) {
    const stale = settings.strength !== this.settings.strength || settings.quality !== this.settings.quality;
    this.settings = settings;
    if (stale) this.invalidate();
    this.player.configure(settings.enabled, settings.whenNotReady === 'original');
    this.pump();
  }

  /** Seconds of cleaned audio ready from the playhead. */
  readyAhead(): number {
    return this.store.readyAhead(this.element.currentTime);
  }

  dispose() {
    clearInterval(this.timer);
    this.element.removeEventListener('seeking', this.onSeeking);
    this.link.cancel([...this.inFlight.values()]);
    this.inFlight.clear();
    this.player.dispose();
  }

  private invalidate() {
    this.link.cancel([...this.inFlight.values()]);
    this.inFlight.clear();
    this.store.clear();
    this.player.reset();
    this.generation++;
  }

  private readonly onSeeking = () => {
    const time = this.element.currentTime;
    const { blockSec } = this.model;
    const first = blockAt(time, blockSec);
    const last = blockAt(time + AHEAD_SEC, blockSec);
    const stale = [...this.inFlight].filter(([block]) => block < first || block > last);
    this.link.cancel(stale.map(([, id]) => id));
    for (const [block] of stale) this.inFlight.delete(block);
    // A block cleaned from mid-way (after an earlier seek) may not cover the new position.
    const current = this.store.get(first);
    if (current && current.start > time + 0.01) this.store.delete(first);
  };

  pump() {
    if (!this.settings.enabled || this.timeline.isEmpty || performance.now() < this.retryAt) return;
    const el = this.element;
    const model = this.model;
    this.store.prune(el.currentTime, BEHIND_SEC);
    this.timeline.dropBefore(el.currentTime - BEHIND_SEC);

    while (this.inFlight.size < MAX_IN_FLIGHT) {
      const job = planNextJob({
        playhead: el.currentTime,
        duration: el.duration,
        blockSec: model.blockSec,
        contextSec: model.contextSec,
        aheadSec: AHEAD_SEC,
        isTaken: (block) => this.store.has(block) || this.inFlight.has(block),
        coveredFrom: (t) => this.timeline.coveredFrom(t),
        coveredUntil: (t) => this.timeline.coveredUntil(t),
      });
      if (!job) return;
      const rate = this.timeline.sampleRate;
      const channels = this.timeline.read(job.windowStart, job.windowEnd, rate);
      if (!channels) return;

      const generation = this.generation;
      const { id, result } = this.link.separate({
        model: model.id,
        sampleRate: rate,
        channels,
        keepFromSec: job.keepStart - job.windowStart,
        keepToSec: job.keepEnd - job.windowStart,
        strength: this.settings.strength,
      });
      this.inFlight.set(job.block, id);
      result
        .then(
          (voice) => {
            if (generation !== this.generation) return;
            this.store.set(job.block, {
              start: job.keepStart,
              end: job.keepStart + voice[0].length / MODEL_RATE,
              rate: MODEL_RATE,
              channels: voice,
            });
            this.player.tick();
          },
          (err: Error) => {
            if (err.message === 'cancelled') return;
            console.warn('[Music Remover] separation failed:', err.message);
            this.retryAt = performance.now() + RETRY_MS;
          },
        )
        .finally(() => {
          if (this.inFlight.get(job.block) === id) this.inFlight.delete(job.block);
          if (generation === this.generation) this.pump();
        });
    }
  }
}
