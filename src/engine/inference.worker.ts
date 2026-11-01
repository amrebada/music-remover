import * as ort from 'onnxruntime-web/webgpu';
import { DemucsSeparator } from './demucs';
import { loadModelBytes } from './modelCache';
import { type ModelId, MODELS } from './models';
import type { ModelState, SeparateJob, WorkerEvent, WorkerRequest } from './protocol';
import { MODEL_RATE, mixRegion, resample, type Separator, type Stereo } from './separator';
import { UmxSeparator } from './umx';

// ORT's pthread workers re-run the bundle they come from, which would re-run this
// file too. One thread is fast enough for Open-Unmix, and HTDemucs runs on the GPU.
ort.env.wasm.numThreads = 1;

const separators = new Map<ModelId, Promise<Separator>>();
const queue: SeparateJob[] = [];
let running = false;

function post(event: WorkerEvent, transfer: Transferable[] = []) {
  self.postMessage(event, { transfer });
}

function postModel(model: ModelId, state: ModelState) {
  post({ type: 'model', model, state });
}

async function createSeparator(id: ModelId): Promise<Separator> {
  const info = MODELS[id];
  let lastReport = 0;
  const bytes = await loadModelBytes(info, (loaded, total) => {
    const now = performance.now();
    if (now - lastReport > 250) {
      lastReport = now;
      postModel(id, { status: 'downloading', loaded, total });
    }
  });
  postModel(id, { status: 'loading' });

  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  const hasGpu = !!gpu && (await gpu.requestAdapter()) !== null;
  const providers = info.providers.filter((p) => p !== 'webgpu' || hasGpu);
  const session = await ort.InferenceSession.create(bytes, {
    executionProviders: providers,
    // HTDemucs breaks with ORT's full graph fusion; demucs-web uses 'basic' as well.
    graphOptimizationLevel: id === 'htdemucs' ? 'basic' : 'all',
  });
  const separator = id === 'htdemucs' ? new DemucsSeparator(ort, session) : new UmxSeparator(ort, session);
  // The first run allocates ORT's buffers; do it now so live mode's first block is not late.
  if (id === 'umx-vocals') await separator.separateVoice([new Float32Array(MODEL_RATE), new Float32Array(MODEL_RATE)]);
  postModel(id, { status: 'ready', backend: providers[0] });
  return separator;
}

function getSeparator(id: ModelId): Promise<Separator> {
  let separator = separators.get(id);
  if (!separator) {
    separator = createSeparator(id);
    separators.set(id, separator);
    separator.catch((err: unknown) => {
      separators.delete(id);
      postModel(id, { status: 'error', message: err instanceof Error ? err.message : String(err) });
    });
  }
  return separator;
}

async function run(job: SeparateJob) {
  const separator = await getSeparator(job.model);
  const input: Stereo = [resample(job.left, job.sampleRate, MODEL_RATE), resample(job.right, job.sampleRate, MODEL_RATE)];
  if (input[0].length > separator.maxWindow) throw new Error('Window longer than the model accepts');
  const from = Math.max(0, Math.round(job.keepFromSec * MODEL_RATE));
  const to = Math.min(input[0].length, Math.round(job.keepToSec * MODEL_RATE));
  const voice = await separator.separateVoice(input, [from, to]);
  const [left, right] = mixRegion(input, voice, job.strength, from, to);
  post({ type: 'result', id: job.id, left, right }, [left.buffer, right.buffer]);
}

async function pump() {
  if (running) return;
  running = true;
  while (queue.length > 0) {
    queue.sort((a, b) => a.priority - b.priority || a.id - b.id);
    const job = queue.shift()!;
    try {
      await run(job);
    } catch (err) {
      post({ type: 'error', id: job.id, message: err instanceof Error ? err.message : String(err) });
    }
  }
  running = false;
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'separate':
      queue.push(msg.job);
      void pump();
      break;
    case 'load':
      getSeparator(msg.model).catch(() => {});
      break;
    case 'cancel': {
      const ids = new Set(msg.ids);
      for (let i = queue.length - 1; i >= 0; i--) if (ids.has(queue[i].id)) queue.splice(i, 1);
      break;
    }
  }
};
