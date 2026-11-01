// Renders the extension icons (public/icon) and the Chrome Web Store images
// (branding/store/<language>) from the sources in branding/. The screenshots show
// the real popup in each language, so build first:  pnpm build && pnpm brand
// Store images are saved as 24-bit PNGs without alpha, as the store asks; that
// conversion uses ffmpeg, like scripts/make-fixtures.mjs.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { chromium } from '@playwright/test';

const ROOT = join(import.meta.dirname, '..');
const EXTENSION = join(ROOT, '.output', 'chrome-mv3');
const ICONS = join(ROOT, 'public', 'icon');
const STORE = join(ROOT, 'branding', 'store');
const LANGUAGES = ['en', 'ar'];
const ORIGIN = 'https://brand.local';
const TYPES = { '.html': 'text/html', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };

if (!existsSync(join(EXTENSION, 'manifest.json'))) {
  console.error('Build the extension first: pnpm build');
  process.exit(1);
}

/** Chrome derives an unpacked extension's id from its path. */
function extensionId(path) {
  const hex = createHash('sha256').update(path).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + Number.parseInt(c, 16))).join('');
}

/** A message from public/_locales, filled in the way chrome.i18n and src/shared/i18n.ts do. */
function message(lang, key, ...values) {
  const entry = JSON.parse(readFileSync(join(ROOT, 'public', '_locales', lang, 'messages.json'), 'utf8'))[key];
  return entry.message.replace(/\$(\w+)\$/g, (_, name) =>
    (entry.placeholders?.[name.toLowerCase()]?.content ?? '').replace(/\$(\d)/g, (_, i) => String(values[i - 1] ?? '')),
  );
}

/** Screenshots the popup in the states the store images show, at 2× for sharp scaling. */
async function capturePopup(lang) {
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    viewport: { width: 340, height: 800 },
    deviceScaleFactor: 2,
    colorScheme: 'light',
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
  });
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId(EXTENSION)}/popup.html`);
  // Pick the language in the extension's settings, as a user would in the popup.
  await page.evaluate((language) => chrome.storage.sync.set({ settings: { language } }), lang);
  await page.reload();
  // Let the popup render, then stop its refresh timer so the states set below stay.
  await page.waitForTimeout(1000);
  const shown = await page.evaluate(() => {
    for (let id = 1; id < 1000; id++) clearInterval(id);
    return document.documentElement.lang;
  });
  if (shown !== lang) throw new Error(`The popup rendered in ${shown}, not ${lang}`);
  const captures = {};
  // The header and the "This tab" card.
  const top = async () => {
    const card = await page.locator('section.card').first().boundingBox();
    return page.screenshot({ clip: { x: 0, y: 0, width: 340, height: card.y + card.height + 10 } });
  };

  await page.evaluate((text) => {
    document.getElementById('tab-status').textContent = text;
  }, message(lang, 'removingAuto', 38));
  captures['popup-auto'] = await top();

  await page.evaluate(
    ([liveOn, stopLive]) => {
      const status = document.getElementById('tab-status');
      status.textContent = liveOn;
      status.classList.add('live');
      const toggle = document.getElementById('live-toggle');
      toggle.textContent = stopLive;
      toggle.classList.add('stop');
    },
    [message(lang, 'liveOn'), message(lang, 'stopLive')],
  );
  captures['popup-live'] = await top();

  captures['popup-settings'] = await page.locator('section.card').nth(1).screenshot();
  await context.close();
  return captures;
}

function toRgb(png, out) {
  const tmp = `${out}.rgba.png`;
  writeFileSync(tmp, png);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', tmp, '-pix_fmt', 'rgb24', out]);
  rmSync(tmp);
}

const captures = {};
for (const lang of LANGUAGES) captures[lang] = await capturePopup(lang);

const browser = await chromium.launch({ channel: 'chromium' });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 1 });
await page.route(`${ORIGIN}/**`, (route) => {
  const url = new URL(route.request().url());
  const path = decodeURIComponent(url.pathname);
  const capture = path.match(/^\/captures\/(.+)\.png$/);
  if (capture) return route.fulfill({ body: captures[url.searchParams.get('lang')][capture[1]], contentType: 'image/png' });
  const file = join(ROOT, path);
  if (!file.startsWith(ROOT) || !existsSync(file)) return route.fulfill({ status: 404 });
  return route.fulfill({ body: readFileSync(file), contentType: TYPES[extname(file)] ?? 'application/octet-stream' });
});

// Extension icons: the simplified mark at 16 and 32 px, the full one above;
// 128 px keeps 16 px of padding, as Chrome asks.
mkdirSync(ICONS, { recursive: true });
await page.goto(`${ORIGIN}/branding/store.html`);
for (const [size, source, inset] of [
  [16, 'logo-small.svg', 0],
  [32, 'logo-small.svg', 0],
  [48, 'logo.svg', 0],
  [96, 'logo.svg', 0],
  [128, 'logo.svg', 16],
]) {
  const png = await page.evaluate(
    async ({ size, source, inset }) => {
      const image = new Image();
      image.src = `/branding/${source}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      canvas.getContext('2d').drawImage(image, inset, inset, size - 2 * inset, size - 2 * inset);
      return canvas.toDataURL('image/png');
    },
    { size, source, inset },
  );
  writeFileSync(join(ICONS, `${size}.png`), Buffer.from(png.split(',')[1], 'base64'));
}

// Store images per language, each at its exact size. The store icon is the 128 px one above.
for (const lang of LANGUAGES) {
  const dir = join(STORE, lang);
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(ICONS, '128.png'), join(dir, 'store-icon-128.png'));
  await page.goto(`${ORIGIN}/branding/store.html?lang=${lang}`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => [...document.images].every((image) => image.complete && image.naturalWidth > 0));
  for (const board of await page.locator('[data-asset]').all()) {
    const name = await board.getAttribute('data-asset');
    toRgb(await board.screenshot(), join(dir, `${name}.png`));
    console.log(`branding/store/${lang}/${name}.png`);
  }
}
await browser.close();
