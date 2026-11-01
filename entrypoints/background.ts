import { browser, type Browser } from 'wxt/browser';
import type { LookaheadState, RuntimeMessage, TabStatus } from '@/src/shared/messages';
import { getSettings, watchSettings } from '@/src/shared/settings';

const OFFSCREEN_URL = '/offscreen.html';

// The service worker can be stopped at any time, so per-tab state lives in session storage.
interface TabRecord {
  live?: boolean;
  liveError?: string;
  lookahead?: LookaheadState;
}

async function getTab(tabId: number): Promise<TabRecord> {
  const key = `tab:${tabId}`;
  return ((await browser.storage.session.get(key))[key] as TabRecord | undefined) ?? {};
}

async function setTab(tabId: number, patch: Partial<TabRecord>) {
  const next = { ...(await getTab(tabId)), ...patch };
  await browser.storage.session.set({ [`tab:${tabId}`]: next });
  await updateBadge(tabId, next);
}

async function updateBadge(tabId: number, record: TabRecord) {
  const text = record.live ? 'LIVE' : record.lookahead?.active ? 'ON' : '';
  await browser.action.setBadgeText({ tabId, text }).catch(() => {});
  await browser.action.setBadgeBackgroundColor({ tabId, color: record.live ? '#c2410c' : '#15803d' }).catch(() => {});
}

let creatingOffscreen: Promise<void> | undefined;

async function ensureOffscreen() {
  const contexts = await browser.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT' as Browser.runtime.ContextType],
    documentUrls: [browser.runtime.getURL(OFFSCREEN_URL)],
  });
  if (contexts.length > 0) return;
  creatingOffscreen ??= browser.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      reasons: ['USER_MEDIA', 'WORKERS'] as Browser.offscreen.Reason[],
      justification: 'Runs the on-device music removal model and live tab audio processing.',
    })
    .finally(() => {
      creatingOffscreen = undefined;
    });
  await creatingOffscreen;
}

async function hasOffscreen(): Promise<boolean> {
  const contexts = await browser.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT' as Browser.runtime.ContextType],
  });
  return contexts.length > 0;
}

async function toggleLive(tabId: number): Promise<TabStatus> {
  const record = await getTab(tabId);
  if (record.live) {
    if (await hasOffscreen()) {
      await browser.runtime.sendMessage({ type: 'live:stop', target: 'offscreen', tabId } satisfies RuntimeMessage);
    }
    await setTab(tabId, { live: false, liveError: undefined });
    return { live: false };
  }

  // Must be requested right before use: the id expires after a few seconds.
  const streamId = await browser.tabCapture.getMediaStreamId({ targetTabId: tabId });
  await ensureOffscreen();
  const response = (await browser.runtime.sendMessage({
    type: 'live:start',
    target: 'offscreen',
    tabId,
    streamId,
    settings: await getSettings(),
  } satisfies RuntimeMessage)) as { ok?: boolean; error?: string } | undefined;

  if (response?.error) {
    await setTab(tabId, { live: false, liveError: response.error });
    return { live: false, liveError: response.error };
  }
  await setTab(tabId, { live: true, liveError: undefined });
  return { live: true };
}

async function handle(msg: RuntimeMessage, sender: Browser.runtime.MessageSender): Promise<unknown> {
  switch (msg.type) {
    case 'live:toggle':
      return toggleLive(msg.tabId);
    case 'status:get': {
      const record = await getTab(msg.tabId);
      return { live: !!record.live, liveError: record.liveError, lookahead: record.lookahead } satisfies TabStatus;
    }
    case 'offscreen:ensure':
      await ensureOffscreen();
      return { ok: true };
    case 'lookahead:state':
      if (sender.tab?.id !== undefined) await setTab(sender.tab.id, { lookahead: msg.state });
      return { ok: true };
    case 'live:ended':
      await setTab(msg.tabId, { live: false, liveError: msg.error });
      return { ok: true };
    default:
      return undefined;
  }
}

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((msg: RuntimeMessage, sender, sendResponse) => {
    // Messages addressed to the offscreen document, or broadcast for the popup, are not ours.
    if ('target' in msg || msg.type === 'engine:model') return;
    handle(msg, sender).then(sendResponse, (err: unknown) =>
      sendResponse({ error: err instanceof Error ? err.message : String(err) }),
    );
    return true;
  });

  browser.commands.onCommand.addListener((command, tab) => {
    if (command === 'toggle-live' && tab?.id !== undefined) void toggleLive(tab.id);
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    void getTab(tabId).then(async (record) => {
      if (record.live && (await hasOffscreen())) {
        await browser.runtime.sendMessage({ type: 'live:stop', target: 'offscreen', tabId } satisfies RuntimeMessage);
      }
      await browser.storage.session.remove(`tab:${tabId}`);
    });
  });

  watchSettings((settings) => {
    void hasOffscreen().then((exists) => {
      if (exists) {
        browser.runtime
          .sendMessage({ type: 'live:settings', target: 'offscreen', settings } satisfies RuntimeMessage)
          .catch(() => {});
      }
    });
  });
});
