import type { ModelId } from './models';
import type { ModelState, SeparateJob, WorkerEvent, WorkerRequest } from './protocol';
import type { Stereo } from './separator';

export type JobInput = Omit<SeparateJob, 'id'>;

/** Main-thread handle to the inference worker. One instance serves every tab. */
export class EngineClient {
  private readonly worker: Worker;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (out: Stereo) => void; reject: (err: Error) => void }>();
  private readonly states = new Map<ModelId, ModelState>();
  private readonly listeners = new Set<(model: ModelId, state: ModelState) => void>();

  constructor() {
    this.worker = new Worker(new URL('./inference.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<WorkerEvent>) => this.handle(event.data);
  }

  private send(msg: WorkerRequest, transfer: Transferable[] = []) {
    this.worker.postMessage(msg, transfer);
  }

  private handle(event: WorkerEvent) {
    if (event.type === 'model') {
      this.states.set(event.model, event.state);
      for (const listener of this.listeners) listener(event.model, event.state);
      return;
    }
    const pending = this.pending.get(event.id);
    if (!pending) return;
    this.pending.delete(event.id);
    if (event.type === 'result') pending.resolve([event.left, event.right]);
    else pending.reject(new Error(event.message));
  }

  modelState(model: ModelId): ModelState {
    return this.states.get(model) ?? { status: 'idle' };
  }

  isReady(model: ModelId): boolean {
    return this.modelState(model).status === 'ready';
  }

  onModelState(listener: (model: ModelId, state: ModelState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Starts downloading/compiling a model without running anything. */
  preload(model: ModelId) {
    this.send({ type: 'load', model });
  }

  /** Resolves with the kept region at 44.1 kHz. Buffers in `input` are transferred. */
  separate(input: JobInput): { id: number; result: Promise<Stereo> } {
    const id = this.nextId++;
    const result = new Promise<Stereo>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.send({ type: 'separate', job: { ...input, id } }, [input.left.buffer, input.right.buffer]);
    return { id, result };
  }

  cancel(ids: number[]) {
    if (ids.length === 0) return;
    for (const id of ids) {
      this.pending.get(id)?.reject(new Error('cancelled'));
      this.pending.delete(id);
    }
    this.send({ type: 'cancel', ids });
  }
}
