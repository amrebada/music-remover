// The offscreen document hosts the model for every tab: live sessions run here, and
// content scripts send lookahead windows here over a port.
import { browser, type Browser } from 'wxt/browser';
import { EngineClient } from '@/src/engine/client';
import type { ModelId } from '@/src/engine/models';
import type { ModelState } from '@/src/engine/protocol';
import { LiveSession } from '@/src/live/liveSession';
import { type PortRequest, type PortResponse, type RuntimeMessage, SEPARATE_PORT } from '@/src/shared/messages';
import { decodePcm, encodePcm } from '@/src/shared/pcm';
import type { Settings } from '@/src/shared/settings';

const engine = new EngineClient();
// Live mode gets its own worker, so a long lookahead job never holds up a live block.
const liveEngine = new EngineClient();
const sessions = new Map<number, LiveSession>();
const ports = new Set<Browser.runtime.Port>();

engine.onModelState((model, state) => {
  browser.runtime.sendMessage({ type: 'engine:model', model, state } satisfies RuntimeMessage).catch(() => {});
  for (const port of ports) port.postMessage({ type: 'model', model, state } satisfies PortResponse);
});

async function startLive(tabId: number, streamId: string, settings: Settings) {
  sessions.get(tabId)?.stop();
  const session = new LiveSession(tabId, liveEngine, settings, (error) => {
    sessions.delete(tabId);
    browser.runtime.sendMessage({ type: 'live:ended', tabId, error } satisfies RuntimeMessage).catch(() => {});
  });
  sessions.set(tabId, session);
  try {
    await session.start(streamId);
  } catch (err) {
    session.stop(err instanceof Error ? err.message : String(err));
    throw err;
  }
}

browser.runtime.onMessage.addListener((msg: RuntimeMessage, _sender, sendResponse) => {
  if (!('target' in msg) || msg.target !== 'offscreen') return;
  switch (msg.type) {
    case 'live:start':
      startLive(msg.tabId, msg.streamId, msg.settings).then(
        () => sendResponse({ ok: true }),
        (err: unknown) => sendResponse({ error: err instanceof Error ? err.message : String(err) }),
      );
      return true;
    case 'live:stop':
      sessions.get(msg.tabId)?.stop();
      sendResponse({ ok: true });
      return;
    case 'live:settings':
      for (const session of sessions.values()) session.updateSettings(msg.settings);
      sendResponse({ ok: true });
      return;
    case 'engine:preload':
      (msg.live ? liveEngine : engine).preload(msg.model);
      sendResponse({ ok: true });
      return;
    case 'live:debug-dump': {
      const session = sessions.get(msg.tabId);
      const recorder = session?.recorder;
      if (!session || !recorder) {
        sendResponse(null);
        return;
      }
      // Messages are JSON, so thin the recording to a quarter of the rate first.
      const thin = (x: Float32Array) => Array.from(x.filter((_, i) => i % 4 === 0));
      const [processed, original] = recorder.dump();
      void session.stats().then((stats) => sendResponse({ rate: recorder.rate / 4, processed: thin(processed), original: thin(original), stats }));
      return true;
    }
    case 'engine:states': {
      const states: Partial<Record<ModelId, ModelState>> = {};
      for (const model of ['umx-vocals', 'htdemucs'] as const) states[model] = (msg.live ? liveEngine : engine).modelState(model);
      sendResponse(states);
      return;
    }
  }
});

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== SEPARATE_PORT) return;
  ports.add(port);
  // Port-local request id → engine job id, so a closing tab cancels its queued work.
  const jobs = new Map<number, number>();

  port.onMessage.addListener((msg: PortRequest) => {
    if (msg.type === 'cancel') {
      engine.cancel(msg.ids.flatMap((id) => jobs.get(id) ?? []));
      for (const id of msg.ids) jobs.delete(id);
      return;
    }
    const [left, right] = decodePcm(msg.pcm, 2);
    const { id, result } = engine.separate({
      model: msg.model,
      priority: 1,
      sampleRate: msg.sampleRate,
      left,
      right,
      keepFromSec: msg.keepFromSec,
      keepToSec: msg.keepToSec,
      strength: msg.strength,
    });
    jobs.set(msg.id, id);
    result
      .then(
        (out): PortResponse => ({ type: 'result', id: msg.id, pcm: encodePcm(out) }),
        (err: unknown): PortResponse => ({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) }),
      )
      .then((response) => {
        jobs.delete(msg.id);
        if (ports.has(port)) port.postMessage(response);
      });
  });

  port.onDisconnect.addListener(() => {
    ports.delete(port);
    engine.cancel([...jobs.values()]);
  });
});
