import { browser } from 'wxt/browser';
import { MODEL_FOR_QUALITY, type ModelId } from '../engine/models';
import type { ModelState } from '../engine/protocol';
import type { LookaheadState, RuntimeMessage } from '../shared/messages';
import { DEFAULT_SETTINGS, getSettings, type Settings, watchSettings } from '../shared/settings';
import { StreamDecoder } from './decoder';
import { DEBUG_REPLY, DEBUG_REQUEST, DebugRecorder, debugEnabled } from '../shared/debug';
import { type AudioTrackInfo, demux } from './demux';
import { EngineLink } from './engineLink';
import { FragmentAssembler } from './fragments';
import { MediaSession } from './mediaSession';
import { StatusChip } from './statusChip';
import { ElementRouter } from './syncPlayer';
import { TAP_SOURCE, type TapEnvelope, type TapMessage } from './tapProtocol';
import { PcmTimeline } from './timeline';

/** Most decoded audio kept per MediaSource; decoded stereo is about 21 MB per minute. */
const MAX_TIMELINE_SEC = 240;

interface SourceState {
  id: number;
  url?: string;
  timeline: PcmTimeline;
  /** null until an init segment has been parsed. */
  supported: boolean | null;
}

interface BufferState {
  source: SourceState;
  assembler: FragmentAssembler;
  decoder: StreamDecoder;
  init?: ArrayBuffer;
  track?: AudioTrackInfo | null;
  /** Appends are processed strictly in order. */
  queue: Promise<void>;
}

/**
 * Isolated-world side of lookahead mode: receives the audio segments the tap
 * copies, decodes them, and runs a MediaSession for each element that plays them.
 */
export class LookaheadController {
  private readonly sources = new Map<number, SourceState>();
  private readonly buffers = new Map<number, BufferState>();
  private readonly routers = new WeakMap<HTMLMediaElement, ElementRouter>();
  private readonly sessions = new Map<HTMLMediaElement, { session: MediaSession; source: SourceState }>();
  private readonly link = new EngineLink((model, state) => this.onModelState(model, state));
  private readonly chip = new StatusChip();
  private settings: Settings = DEFAULT_SETTINGS;
  private modelState: ModelState = { status: 'idle' };
  private lastReport = '';
  private lastState: LookaheadState = { active: false };
  private readonly recorders = new Map<HTMLMediaElement, DebugRecorder>();

  async start() {
    window.addEventListener('message', this.onTapMessage);
    window.addEventListener('message', this.onDebugRequest);
    // Media events do not bubble, so listen in the capture phase.
    document.addEventListener('loadstart', this.onLoadStart, true);
    for (const type of ['pointerdown', 'keydown']) window.addEventListener(type, this.resumeAudio, true);

    this.settings = await getSettings();
    watchSettings((settings) => this.applySettings(settings));
    setInterval(() => this.refreshStatus(), 500);
  }

  private applySettings(settings: Settings) {
    this.settings = settings;
    for (const { session } of this.sessions.values()) session.applySettings(settings);
    if (settings.enabled) this.bindAll();
  }

  private readonly onTapMessage = (event: MessageEvent) => {
    if (event.source !== window || (event.data as TapEnvelope | undefined)?.source !== TAP_SOURCE) return;
    const msg = (event.data as TapEnvelope).msg;
    switch (msg.kind) {
      case 'ms-url':
        this.source(msg.msId).url = msg.url;
        this.bindAll();
        break;
      case 'ms-end':
        for (const buffer of this.buffers.values()) {
          if (buffer.source.id === msg.msId) buffer.queue = buffer.queue.then(() => buffer.decoder.flush());
        }
        break;
      case 'sb-add':
        this.buffers.set(msg.sbId, this.createBuffer(this.source(msg.msId)));
        break;
      case 'append': {
        const buffer = this.buffers.get(msg.sbId);
        if (buffer) buffer.queue = buffer.queue.then(() => this.processAppend(buffer, msg)).catch((err: unknown) => console.warn('[Music Remover]', err));
        break;
      }
      case 'remove':
        this.buffers.get(msg.sbId)?.source.timeline.remove(msg.start, msg.end);
        break;
      case 'abort':
        this.buffers.get(msg.sbId)?.assembler.reset();
        break;
      case 'sb-type':
        // A codec change arrives with a new init segment, handled in processAppend.
        break;
    }
  };

  private source(id: number): SourceState {
    let source = this.sources.get(id);
    if (!source) {
      source = { id, timeline: new PcmTimeline(), supported: null };
      this.sources.set(id, source);
    }
    return source;
  }

  private createBuffer(source: SourceState): BufferState {
    const decoder = new StreamDecoder(
      (start, rate, channels) => source.timeline.add(start, rate, channels),
      (err) => console.warn('[Music Remover] decode error:', err.message),
    );
    return { source, assembler: new FragmentAssembler(), decoder, queue: Promise.resolve() };
  }

  private async processAppend(buffer: BufferState, msg: Extract<TapMessage, { kind: 'append' }>) {
    const { init, fragments } = buffer.assembler.push(msg.bytes);
    if (init) {
      buffer.init = init;
      buffer.track = demux(init).track;
      const supported = !!buffer.track && (await buffer.decoder.configure(buffer.track));
      buffer.source.supported = supported;
      if (supported) this.bindAll();
      else this.unbindSource(buffer.source);
    }
    if (!buffer.init || !buffer.track || !buffer.source.supported || !this.settings.enabled) return;
    for (const fragment of fragments) {
      buffer.decoder.decode(demux(buffer.init, fragment).samples, msg.timestampOffset);
    }
    // Sessions drop audio behind the playhead; this bounds memory when none is attached.
    buffer.source.timeline.limit(MAX_TIMELINE_SEC);
  }

  private readonly onLoadStart = (event: Event) => {
    if (event.target instanceof HTMLMediaElement) this.bind(event.target);
  };

  private bindAll() {
    for (const el of document.querySelectorAll<HTMLMediaElement>('video, audio')) this.bind(el);
  }

  private bind(el: HTMLMediaElement) {
    const src = el.currentSrc || el.src;
    const source = src ? [...this.sources.values()].find((s) => s.url === src) : undefined;
    const current = this.sessions.get(el);
    if (current?.source === source) return;
    if (current) {
      current.session.dispose();
      this.sessions.delete(el);
    }
    // Only route elements we can actually clean: routing is permanent, and an
    // element whose audio we cannot process should keep playing normally.
    if (!source || source.supported !== true || !this.settings.enabled) return;

    let router = this.routers.get(el);
    if (!router) {
      try {
        router = new ElementRouter(el);
      } catch (err) {
        console.warn('[Music Remover] cannot route this element:', err);
        return;
      }
      this.routers.set(el, router);
      if (debugEnabled()) this.recorders.set(el, new DebugRecorder(router.ctx, router.output, router.source));
    }
    void router.ctx.resume().catch(() => {});
    const session = new MediaSession(el, router, source.timeline, this.link, this.settings);
    this.sessions.set(el, { session, source });
  }

  private unbindSource(source: SourceState) {
    for (const [el, entry] of this.sessions) {
      if (entry.source !== source) continue;
      entry.session.dispose();
      this.sessions.delete(el);
    }
  }

  private readonly onDebugRequest = (event: MessageEvent) => {
    if (event.source !== window || (event.data as { source?: string } | undefined)?.source !== DEBUG_REQUEST) return;
    if (!debugEnabled()) return;
    const recorder = this.recorders.values().next().value;
    const [processed, original] = recorder?.dump() ?? [new Float32Array(0), new Float32Array(0)];
    window.postMessage(
      { source: DEBUG_REPLY, rate: recorder?.rate ?? 0, processed, original, state: this.lastState, model: this.modelState },
      '*',
      [processed.buffer, original.buffer],
    );
  };

  private readonly resumeAudio = () => {
    for (const { session } of this.sessions.values()) {
      if (!session.router.running) void session.router.ctx.resume().catch(() => {});
    }
  };

  private onModelState(model: ModelId, state: ModelState) {
    if (model === MODEL_FOR_QUALITY[this.settings.quality]) this.modelState = state;
  }

  /** Updates the on-video chip and reports this tab's state for the badge. */
  private refreshStatus() {
    let main: { el: HTMLMediaElement; session: MediaSession } | undefined;
    for (const [el, { session }] of this.sessions) {
      if (!el.isConnected) continue;
      if (!main || (!el.paused && main.el.paused)) main = { el, session };
    }

    const state: LookaheadState = { active: !!main && this.settings.enabled };
    if (main && this.settings.enabled) {
      const { el, session } = main;
      const ready = session.readyAhead();
      state.readySec = Math.round(ready);
      state.waitingForGesture = !session.router.running;
      if (!session.router.running) {
        this.chip.show(el, 'Music Remover: click to turn on cleaned audio', this.resumeAudio);
      } else if (this.modelState.status === 'downloading') {
        const pct = Math.round((this.modelState.loaded / this.modelState.total) * 100);
        this.chip.show(el, `Music Remover: downloading model ${pct}%`);
      } else if (this.modelState.status === 'error') {
        this.chip.show(el, `Music Remover: ${this.modelState.message}`);
      } else if (!el.paused && ready < 0.05) {
        this.chip.show(el, 'Music Remover: removing music…');
      } else {
        this.chip.hide();
      }
    } else {
      this.chip.hide();
    }

    this.lastState = state;
    const report = JSON.stringify(state);
    // Embedded players report from their frame; the top frame reports even when idle.
    if (report !== this.lastReport && (window === window.top || state.active)) {
      this.lastReport = report;
      browser.runtime.sendMessage({ type: 'lookahead:state', state } satisfies RuntimeMessage).catch(() => {});
    }
  }
}
