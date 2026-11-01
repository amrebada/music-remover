import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { type BrowserContext, chromium, type Page } from '@playwright/test';
import { MODELS } from '../../src/engine/models';

// Available inside extension pages, where page.evaluate callbacks run.
declare const chrome: {
  runtime: { sendMessage(message: object): Promise<unknown> };
  storage: { sync: { set(items: object): Promise<void> } };
};

export const ROOT = join(import.meta.dirname, '..', '..');
/** The built extension; set EXTENSION_DIR to test another copy, such as the unzipped store package. */
export const EXTENSION = process.env.EXTENSION_DIR ?? join(ROOT, '.output', 'chrome-mv3');

/** Chrome derives an unpacked extension's id from its path. */
export function extensionId(path = EXTENSION): string {
  const hex = createHash('sha256').update(path).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + Number.parseInt(c, 16))).join('');
}

/**
 * `unmuted`: Playwright mutes audio by default, and a muted tab captures as
 * silence, so live-mode tests need it off (the clip may then be audible).
 */
export async function launch({ args = [], unmuted = false }: { args?: string[]; unmuted?: boolean } = {}): Promise<BrowserContext> {
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    ignoreDefaultArgs: unmuted ? ['--mute-audio'] : [],
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`, ...args],
  });
  // Serve models from fixtures/models when present instead of downloading them each run.
  for (const model of Object.values(MODELS)) {
    const local = join(ROOT, 'fixtures/models', `${model.id}.onnx`);
    await context.route(model.url, (route) => route.fulfill({ path: local }).catch(() => route.continue()));
  }
  return context;
}

/** Opens an extension page to drive the extension from (the popup, which every package has). */
export async function controlPage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId()}/popup.html`);
  return page;
}

/** Sends a runtime message from an extension page and returns the reply. */
export function send<T>(page: Page, message: object): Promise<T> {
  return page.evaluate((msg) => chrome.runtime.sendMessage(msg), message) as Promise<T>;
}

export function setSettings(page: Page, settings: object): Promise<void> {
  return page.evaluate((s) => chrome.storage.sync.set({ settings: s }), settings);
}
