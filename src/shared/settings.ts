import { browser } from 'wxt/browser';

export type Quality = 'fast' | 'high';
export type LiveLatency = 'low' | 'balanced' | 'clean';
export type WhenNotReady = 'mute' | 'original';
/** `auto` follows Chrome's display language. */
export type LanguageSetting = 'auto' | 'en' | 'ar';

export interface Settings {
  /** Remove music automatically on supported sites (lookahead mode). */
  enabled: boolean;
  /** 0..1, how much of the music to remove. */
  strength: number;
  /** Model for lookahead mode. Live mode always uses the fast model. */
  quality: Quality;
  liveLatency: LiveLatency;
  /** What to play while cleaned audio is not ready yet. */
  whenNotReady: WhenNotReady;
  /** Language of the popup and the messages over videos. */
  language: LanguageSetting;
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  strength: 1,
  quality: 'fast',
  liveLatency: 'balanced',
  whenNotReady: 'mute',
  language: 'auto',
};

const KEY = 'settings';

function withDefaults(value: unknown): Settings {
  return { ...DEFAULT_SETTINGS, ...(value as Partial<Settings> | undefined) };
}

export async function getSettings(): Promise<Settings> {
  const stored = await browser.storage.sync.get(KEY);
  return withDefaults(stored[KEY]);
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await browser.storage.sync.set({ [KEY]: next });
  return next;
}

export function watchSettings(callback: (settings: Settings) => void): () => void {
  const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area === 'sync' && changes[KEY]) callback(withDefaults(changes[KEY].newValue));
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}
