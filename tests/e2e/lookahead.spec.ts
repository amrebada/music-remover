// Loads the built extension in Chromium, plays the fixture through MediaSource on a
// page served as www.youtube.com, and checks what the page actually sounded like.
// Run `pnpm fixtures` and `pnpm build` first.
import { join } from 'node:path';
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { readWav } from '../../scripts/wav.mjs';
import { DEFAULT_SETTINGS, type Quality } from '../../src/shared/settings';
import { ANALYSIS_RATE, bestLag, fitTwo, toAnalysisRate } from './analysis';
import { controlPage, launch as launchExtension, ROOT, setSettings } from './helpers';

async function launch(quality: Quality): Promise<BrowserContext> {
  const context = await launchExtension();
  const control = await controlPage(context);
  await setSettings(control, { ...DEFAULT_SETTINGS, quality });
  await control.close();
  await context.route('https://www.youtube.com/**', (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/mr-test') return route.fulfill({ path: join(ROOT, 'tests/e2e/player.html'), contentType: 'text/html' });
    if (pathname.startsWith('/fixtures/')) return route.fulfill({ path: join(ROOT, pathname), contentType: 'video/mp4' });
    return route.fulfill({ status: 404 });
  });
  await context.addInitScript(() => localStorage.setItem('music-remover-debug', '1'));
  return context;
}

function debugState(page: Page): Promise<{ model: { status: string; backend?: string } }> {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        addEventListener('message', (event) => {
          if (event.data?.source === 'music-remover-debug-reply') resolve({ model: event.data.model });
        });
        postMessage({ source: 'music-remover-debug' }, '*');
      }),
  );
}

interface Dump {
  rate: number;
  processed: number[];
  original: number[];
  state: { active: boolean; readySec?: number };
}

const stems = {
  mix: readWav(join(ROOT, 'fixtures/mix.wav'))[0],
  speech: readWav(join(ROOT, 'fixtures/speech.wav'))[0],
  music: readWav(join(ROOT, 'fixtures/music.wav'))[0],
};

const cases: { mode: string; quality: Quality }[] = [
  { mode: 'split', quality: 'fast' },
  { mode: 'muxed', quality: 'fast' },
  { mode: 'split', quality: 'high' },
];

for (const { mode, quality } of cases) {
  test(`removes the music in sync (${mode} SourceBuffers, ${quality} model)`, async () => {
    const context = await launch(quality);
    const page = await context.newPage();
    page.on('console', (msg) => {
      if (msg.text().includes('Music Remover')) console.log(`[page] ${msg.text()}`);
    });
    await page.goto(`https://www.youtube.com/mr-test?mode=${mode}`);
    await page.waitForFunction(() => (window as unknown as { mediaReady?: boolean }).mediaReady, null, { timeout: 30_000 });
    // The first run downloads the model; measure steady-state behaviour, not the download.
    await expect.poll(() => debugState(page).then((s) => s.model.status), { timeout: 180_000 }).toBe('ready');
    console.log(`[${mode}/${quality}] model backend: ${(await debugState(page)).model.backend}`);
    await page.click('#play');
    await page.waitForFunction(() => document.querySelector('video')!.ended, null, { timeout: 90_000 });

    const dump = await page.evaluate(
      () =>
        new Promise<Dump>((resolve) => {
          addEventListener('message', (event) => {
            const data = event.data;
            if (data?.source !== 'music-remover-debug-reply') return;
            // Thin out to keep the transfer small; analysis runs at 8 kHz anyway.
            const thin = (x: Float32Array) => Array.from(x.filter((_, i) => i % 2 === 0));
            resolve({ rate: data.rate / 2, processed: thin(data.processed), original: thin(data.original), state: data.state });
          });
          postMessage({ source: 'music-remover-debug' }, '*');
        }),
    );
    await context.close();

    expect(dump.processed.length).toBeGreaterThan(dump.rate * 15);
    const processed = toAnalysisRate(Float32Array.from(dump.processed), dump.rate);
    const original = toAnalysisRate(Float32Array.from(dump.original), dump.rate);
    const [mix, speech, music] = [stems.mix, stems.speech, stems.music].map((x) => toAnalysisRate(x, 44100));

    // Where the media started in the recording, from the untouched element audio.
    const start = bestLag(original, mix);
    // Where the speech sits in what the user heard.
    const voiceStart = bestLag(processed, speech);
    const syncErrorMs = ((voiceStart - start) / ANALYSIS_RATE) * 1000;
    console.log(`[${mode}/${quality}] sync error ${syncErrorMs.toFixed(1)} ms`);
    expect(Math.abs(syncErrorMs)).toBeLessThan(45);

    // Fit both against the stems over 2..18 s of media.
    const from = 2 * ANALYSIS_RATE;
    const to = 18 * ANALYSIS_RATE;
    const window = (x: Float32Array, offset: number) => x.subarray(offset + from, offset + to);
    // Fit at the voice's own alignment: a few ms of offset flips the sign of 100–300 Hz speech.
    const heard = fitTwo(window(processed, voiceStart), window(speech, 0), window(music, 0));
    const untouched = fitTwo(window(original, start), window(speech, 0), window(music, 0));
    const ratio = heard.b / heard.a;
    console.log(`[${mode}/${quality}] music/speech weight: original ${(untouched.b / untouched.a).toFixed(2)}, heard ${ratio.toFixed(2)}`);
    expect(untouched.b / untouched.a).toBeGreaterThan(0.8);
    expect(ratio).toBeLessThan(0.3);
    expect(heard.a).toBeGreaterThan(0.5);
  });
}
