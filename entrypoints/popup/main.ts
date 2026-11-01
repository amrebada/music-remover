import { browser } from 'wxt/browser';
import { isModelCached } from '@/src/engine/modelCache';
import { MODEL_FOR_QUALITY, MODELS } from '@/src/engine/models';
import type { ModelState } from '@/src/engine/protocol';
import { liveDelayMs } from '@/src/live/presets';
import { localizePage, setLanguage, t } from '@/src/shared/i18n';
import type { RuntimeMessage, TabStatus } from '@/src/shared/messages';
import { getSettings, type Settings, updateSettings } from '@/src/shared/settings';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
// Chrome's language until the settings load; most of the time that is also the choice.
localizePage();

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
const language = $<HTMLSelectElement>('language');

let settings: Settings;
let tabId: number | undefined;
/** Last states shown, to redraw them in another language. */
let lastStatus: TabStatus | undefined;
let lastModelState: ModelState | undefined;

function renderTab(status: TabStatus | undefined) {
  lastStatus = status;
  const live = !!status?.live;
  liveToggle.textContent = live ? t('stopLive') : t('startLive');
  liveToggle.classList.toggle('stop', live);
  tabStatus.classList.toggle('live', live);

  if (live) {
    tabStatus.textContent = t('liveOn');
  } else if (status?.liveError) {
    tabStatus.textContent = t('liveStopped', status.liveError);
  } else if (status?.lookahead?.active) {
    tabStatus.textContent = status.lookahead.waitingForGesture ? t('clickToEnable') : t('removingAuto', status.lookahead.readySec ?? 0);
  } else {
    tabStatus.textContent = t('noVideo');
  }
  liveHint.textContent = t('liveHint', liveDelayMs(settings.liveLatency));
}

async function refreshTab() {
  if (tabId === undefined) return;
  const status = (await browser.runtime.sendMessage({ type: 'status:get', tabId } satisfies RuntimeMessage)) as TabStatus;
  renderTab(status);
}

async function renderModel(state?: ModelState) {
  lastModelState = state;
  const info = MODELS[MODEL_FOR_QUALITY[settings.quality]];
  if (state?.status === 'downloading') {
    modelStatus.textContent = t('modelDownloading', Math.round((state.loaded / state.total) * 100));
  } else if (state?.status === 'error') {
    modelStatus.textContent = t('modelError', state.message);
  } else if (state?.status === 'ready') {
    modelStatus.textContent = state.backend === 'webgpu' ? t('modelLoadedGpu') : t('modelLoadedCpu');
  } else {
    modelStatus.textContent = (await isModelCached(info)) ? t('modelDownloaded') : t('modelWillDownload', Math.round(info.bytes / 1e6));
  }
}

/** Fills every text in the current language. */
function renderTexts() {
  localizePage();
  for (const option of liveLatency.options) option.textContent = t('latencyOption', option.textContent!, liveDelayMs(option.value as Settings['liveLatency']));
  renderTab(lastStatus);
  void renderModel(lastModelState);
}

function bindSettings() {
  enabled.checked = settings.enabled;
  strength.value = String(Math.round(settings.strength * 100));
  strengthValue.value = `${strength.value}%`;
  quality.value = settings.quality;
  liveLatency.value = settings.liveLatency;
  whenNotReady.value = settings.whenNotReady;
  language.value = settings.language;

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
  language.addEventListener('change', async () => {
    await save({ language: language.value as Settings['language'] });
    setLanguage(settings.language);
    renderTexts();
  });
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
  setLanguage(settings.language);
  bindSettings();
  renderTexts();
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id;
  await refreshTab();
  setInterval(refreshTab, 1000);
}

void init();
