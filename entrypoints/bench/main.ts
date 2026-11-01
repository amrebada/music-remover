// Dev page: runs each model over a whole file the way lookahead mode does
// (blocks plus context) and reports speed and separation quality.
import { EngineClient } from '@/src/engine/client';
import { type ModelId, MODELS } from '@/src/engine/models';
import { MODEL_RATE, type Stereo } from '@/src/engine/separator';
import { siSdr } from '@/src/engine/metrics';

const engine = new EngineClient();
const log = document.getElementById('log')!;
const results = document.getElementById('results')!;
const say = (text: string) => {
  log.textContent += `${text}\n`;
};

engine.onModelState((model, state) => {
  if (state.status === 'downloading') return;
  say(`${model}: ${state.status}${'backend' in state ? ` (${state.backend})` : ''}${'message' in state ? ` ${state.message}` : ''}`);
});

async function decode(file: File): Promise<Stereo> {
  const ctx = new OfflineAudioContext(2, 1, MODEL_RATE);
  const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
  const left = buffer.getChannelData(0);
  return [left.slice(), (buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left).slice()];
}

async function separateFile(model: ModelId, mix: Stereo): Promise<Stereo> {
  const { blockSec, contextSec } = MODELS[model];
  const total = mix[0].length;
  const block = Math.round(blockSec * MODEL_RATE);
  const context = Math.round(contextSec * MODEL_RATE);
  const out: Stereo = [new Float32Array(total), new Float32Array(total)];
  for (let start = 0; start < total; start += block) {
    const end = Math.min(start + block, total);
    const windowStart = Math.max(0, start - context);
    const windowEnd = Math.min(total, end + context);
    const { result } = engine.separate({
      model,
      priority: 1,
      sampleRate: MODEL_RATE,
      left: mix[0].slice(windowStart, windowEnd),
      right: mix[1].slice(windowStart, windowEnd),
      keepFromSec: (start - windowStart) / MODEL_RATE,
      keepToSec: (end - windowStart) / MODEL_RATE,
      strength: 1,
    });
    const [left, right] = await result;
    out[0].set(left, start);
    out[1].set(right, start);
  }
  return out;
}

function play(audio: Stereo) {
  const ctx = new AudioContext();
  const buffer = ctx.createBuffer(2, audio[0].length, MODEL_RATE);
  buffer.copyToChannel(audio[0], 0);
  buffer.copyToChannel(audio[1], 1);
  const node = ctx.createBufferSource();
  node.buffer = buffer;
  node.connect(ctx.destination);
  node.start();
  return () => void ctx.close();
}

function listenCell(mix: Stereo, voice: Stereo) {
  const cell = document.createElement('td');
  let stop: (() => void) | undefined;
  for (const [label, audio] of [['mix', mix], ['voice', voice]] as const) {
    const button = document.createElement('button');
    button.textContent = label;
    button.onclick = () => {
      stop?.();
      stop = play(audio);
    };
    cell.append(button, ' ');
  }
  return cell;
}

document.getElementById('run')!.addEventListener('click', async () => {
  const mixFile = (document.getElementById('mix') as HTMLInputElement).files?.[0];
  const refFile = (document.getElementById('ref') as HTMLInputElement).files?.[0];
  if (!mixFile) return say('Pick a mix file first.');
  const mix = await decode(mixFile);
  const ref = refFile ? await decode(refFile) : undefined;
  const seconds = mix[0].length / MODEL_RATE;
  say(`Loaded ${seconds.toFixed(1)} s of audio.`);

  for (const model of Object.keys(MODELS) as ModelId[]) {
    engine.preload(model);
    // Warm up so download and compile time stay out of the timing.
    await separateFile(model, [mix[0].slice(0, MODEL_RATE * 2), mix[1].slice(0, MODEL_RATE * 2)]);
    const t0 = performance.now();
    const voice = await separateFile(model, mix);
    const rtf = (performance.now() - t0) / 1000 / seconds;
    const state = engine.modelState(model);

    const row = document.createElement('tr');
    const quality = ref ? `${siSdr(mix[0], ref[0]).toFixed(1)} → ${siSdr(voice[0], ref[0]).toFixed(1)} dB` : '—';
    for (const text of [model, state.status === 'ready' ? state.backend : state.status, rtf.toFixed(3), quality]) {
      const cell = document.createElement('td');
      cell.textContent = text;
      row.append(cell);
    }
    row.append(listenCell(mix, voice));
    results.append(row);
    say(`${model}: RTF ${rtf.toFixed(3)}`);
  }
});
