import { browser } from 'wxt/browser';
import { isModelCached } from '@/src/engine/modelCache';
import { MODEL_FOR_QUALITY, MODELS } from '@/src/engine/models';
import type { ModelState } from '@/src/engine/protocol';
import { liveDelayMs } from '@/src/live/presets';
import type { RuntimeMessage, TabStatus } from '@/src/shared/messages';
import { getSettings, type Settings, updateSettings } from '@/src/shared/settings';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const tabStatus = $<HTMLParagraphElement>('tab-status');
const liveToggle = $<HTMLButtonElement>('live-toggle');
const liveHint = $<HTMLParagraphElement>('live-hint');
const enabled = $<HTMLInputElement>('enabled');
const strength = $<HTMLInputElement>('strength');
const strengthValue = $<HTMLOutputElement>('strength-value');
const quality = $<HTMLSelectElement>('quality');
const modelStatus = $<HTMLElement>('model-status');
const liveLatency = $<HTMLSelectElement>('liveLatency');
const whenNotReady = $<HTMLSelectElement>('whenNotReady');

let settings: Settings;
let tabId: number | undefined;

function renderTab(status: TabStatus | undefined) {
  const live = !!status?.live;
  liveToggle.textContent = live ? 'Stop live mode' : 'Start live mode';
  liveToggle.classList.toggle('stop', live);
  tabStatus.classList.toggle('live', live);

  if (live) {
    tabStatus.textContent = 'Live mode is on: you hear the cleaned tab audio.';
  } else if (status?.liveError) {
    tabStatus.textContent = `Live mode stopped: ${status.liveError}`;
  } else if (status?.lookahead?.active) {
    const ready = status.lookahead.readySec ?? 0;
    tabStatus.textContent = status.lookahead.waitingForGesture
      ? 'Click the video page once to turn on the cleaned audio.'
      : `Removing music automatically · ${ready} s ready ahead`;
  } else {
    tabStatus.textContent = 'No supported video playing here. Use live mode on any site.';
  }
  liveHint.textContent = `Live mode works on any site and delays the sound by about ${liveDelayMs(settings.liveLatency)} ms.`;
}

async function refreshTab() {
  if (tabId === undefined) return;
  const status = (await browser.runtime.sendMessage({ type: 'status:get', tabId } satisfies RuntimeMessage)) as TabStatus;
  renderTab(status);
}

async function renderModel(state?: ModelState) {
  const info = MODELS[MODEL_FOR_QUALITY[settings.quality]];
  if (state?.status === 'downloading') {
    modelStatus.textContent = `Downloading… ${Math.round((state.loaded / state.total) * 100)}%`;
  } else if (state?.status === 'error') {
    modelStatus.textContent = `Model error: ${state.message}`;
  } else if (state?.status === 'ready') {
    modelStatus.textContent = `Model loaded (${state.backend === 'webgpu' ? 'GPU' : 'CPU'}).`;
  } else {
    modelStatus.textContent = (await isModelCached(info))
      ? 'Model downloaded.'
      : `Downloads ${Math.round(info.bytes / 1e6)} MB the first time it is used.`;
  }
}

function bindSettings() {
  enabled.checked = settings.enabled;
  strength.value = String(Math.round(settings.strength * 100));
  strengthValue.value = `${strength.value}%`;
  quality.value = settings.quality;
  for (const option of liveLatency.options) option.textContent += ` (about ${liveDelayMs(option.value as Settings['liveLatency'])} ms)`;
  liveLatency.value = settings.liveLatency;
  whenNotReady.value = settings.whenNotReady;

  const save = async (patch: Partial<Settings>) => {
    settings = await updateSettings(patch);
  };
  enabled.addEventListener('change', () => save({ enabled: enabled.checked }));
  strength.addEventListener('input', () => {
    strengthValue.value = `${strength.value}%`;
  });
  strength.addEventListener('change', () => save({ strength: Number(strength.value) / 100 }));
  quality.addEventListener('change', async () => {
    await save({ quality: quality.value as Settings['quality'] });
    await renderModel();
  });
  liveLatency.addEventListener('change', async () => {
    await save({ liveLatency: liveLatency.value as Settings['liveLatency'] });
    await refreshTab();
  });
  whenNotReady.addEventListener('change', () => save({ whenNotReady: whenNotReady.value as Settings['whenNotReady'] }));
}

liveToggle.addEventListener('click', async () => {
  if (tabId === undefined) return;
  liveToggle.disabled = true;
  try {
    const status = (await browser.runtime.sendMessage({ type: 'live:toggle', tabId } satisfies RuntimeMessage)) as
      | TabStatus
      | { error: string };
    renderTab('error' in status ? { live: false, liveError: status.error } : status);
  } finally {
    liveToggle.disabled = false;
  }
});

browser.runtime.onMessage.addListener((msg: RuntimeMessage) => {
  if (msg.type === 'engine:model' && msg.model === MODEL_FOR_QUALITY[settings.quality]) void renderModel(msg.state);
});

async function init() {
  settings = await getSettings();
  bindSettings();
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id;
  await Promise.all([refreshTab(), renderModel()]);
  setInterval(refreshTab, 1000);
}

void init();
