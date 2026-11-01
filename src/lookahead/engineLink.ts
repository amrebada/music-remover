import { browser, type Browser } from 'wxt/browser';
import type { ModelId } from '../engine/models';
import type { ModelState } from '../engine/protocol';
import type { Stereo } from '../engine/separator';
import { type PortRequest, type PortResponse, type RuntimeMessage, SEPARATE_PORT } from '../shared/messages';
import { decodePcm, encodePcm } from '../shared/pcm';

export interface LinkRequest {
  model: ModelId;
  sampleRate: number;
  channels: Stereo;
  keepFromSec: number;
  keepToSec: number;
  strength: number;
}

/** Content-script side of the port to the offscreen engine. Reconnects as needed. */
export class EngineLink {
  private port?: Browser.runtime.Port;
  private connecting?: Promise<Browser.runtime.Port>;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (out: Stereo) => void; reject: (err: Error) => void }>();
  readonly modelStates = new Map<ModelId, ModelState>();

  constructor(private readonly onModelState: (model: ModelId, state: ModelState) => void) {}

  private connect(): Promise<Browser.runtime.Port> {
    if (this.port) return Promise.resolve(this.port);
    this.connecting ??= (async () => {
      await browser.runtime.sendMessage({ type: 'offscreen:ensure' } satisfies RuntimeMessage);
      const port = browser.runtime.connect({ name: SEPARATE_PORT });
      port.onMessage.addListener((msg: PortResponse) => this.handle(msg));
      port.onDisconnect.addListener(() => {
        if (this.port === port) this.port = undefined;
        for (const { reject } of this.pending.values()) reject(new Error('Engine disconnected'));
        this.pending.clear();
      });
      this.port = port;
      return port;
    })().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private handle(msg: PortResponse) {
    if (msg.type === 'model') {
      this.modelStates.set(msg.model, msg.state);
      this.onModelState(msg.model, msg.state);
      return;
    }
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    if (msg.type === 'result') pending.resolve(decodePcm(msg.pcm, 2) as Stereo);
    else pending.reject(new Error(msg.message));
  }

  /** Resolves with the kept region as 44.1 kHz stereo. */
  separate(req: LinkRequest): { id: number; result: Promise<Stereo> } {
    const id = this.nextId++;
    const result = new Promise<Stereo>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.connect().then(
        (port) =>
          port.postMessage({
            type: 'separate',
            id,
            model: req.model,
            sampleRate: req.sampleRate,
            pcm: encodePcm(req.channels),
            keepFromSec: req.keepFromSec,
            keepToSec: req.keepToSec,
            strength: req.strength,
          } satisfies PortRequest),
        (err: unknown) => {
          this.pending.delete(id);
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });
    return { id, result };
  }

  cancel(ids: number[]) {
    if (ids.length === 0) return;
    for (const id of ids) {
      this.pending.get(id)?.reject(new Error('cancelled'));
      this.pending.delete(id);
    }
    this.port?.postMessage({ type: 'cancel', ids } satisfies PortRequest);
  }
}
