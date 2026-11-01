// Opt-in check against the real YouTube site: REAL_SITES=1 pnpm test:e2e
// It depends on the network and on YouTube's player, so it is not part of the default run.
import { expect, test } from '@playwright/test';
import { ANALYSIS_RATE, bestLag, toAnalysisRate } from './analysis';
import { launch } from './helpers';

test.skip(!process.env.REAL_SITES, 'set REAL_SITES=1 to run against youtube.com');

test('cleans a real YouTube video in sync', async () => {
  const context = await launch();
  await context.addInitScript(() => localStorage.setItem('music-remover-debug', '1'));
  const page = await context.newPage();
  await page.goto('https://www.youtube.com/watch?v=jNQXAC9IVRw', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('video', { timeout: 30_000 });
  // Measure with the model loaded, as on every visit after the first.
  const modelStatus = () =>
    page.evaluate(
      () =>
        new Promise<string>((resolve) => {
          addEventListener('message', (e) => {
            if (e.data?.source === 'music-remover-debug-reply') resolve(e.data.model.status);
          });
          postMessage({ source: 'music-remover-debug' }, '*');
        }),
    );
  await expect.poll(modelStatus, { timeout: 120_000 }).toBe('ready');
  await page.locator('#movie_player').click({ timeout: 5000, force: true }).catch(() => {});
  await page.keyboard.press('k');
  await page.waitForTimeout(15_000);

  const dump = await page.evaluate(
    () =>
      new Promise<{ rate: number; processed: number[]; original: number[]; active: boolean }>((resolve) => {
        addEventListener('message', (e) => {
          if (e.data?.source !== 'music-remover-debug-reply') return;
          const thin = (x: Float32Array) => Array.from(x.filter((_, i) => i % 2 === 0));
          resolve({ rate: e.data.rate / 2, processed: thin(e.data.processed), original: thin(e.data.original), active: e.data.state.active });
        });
        postMessage({ source: 'music-remover-debug' }, '*');
      }),
  );
  await context.close();

  expect(dump.active).toBe(true);
  // Until the first cleaned block is ready the output is exactly silent.
  const firstOriginal = dump.original.findIndex((x) => Math.abs(x) > 1e-4);
  const firstSound = dump.processed.findIndex((x, i) => i >= firstOriginal && Math.abs(x) > 1e-6);
  const gapMs = ((firstSound - firstOriginal) / dump.rate) * 1000;
  console.log(`[youtube] silent for ${Math.round(gapMs)} ms after the audio started`);
  expect(gapMs).toBeLessThan(500);
  const processed = toAnalysisRate(Float32Array.from(dump.processed), dump.rate);
  const original = toAnalysisRate(Float32Array.from(dump.original), dump.rate);
  const end = original.length - 2 * ANALYSIS_RATE;
  const reference = original.subarray(end - 4 * ANALYSIS_RATE, end);
  const search = processed.subarray(end - 4.5 * ANALYSIS_RATE, end + 0.5 * ANALYSIS_RATE);
  const syncMs = ((bestLag(search, reference) - 0.5 * ANALYSIS_RATE) / ANALYSIS_RATE) * 1000;
  console.log(`[youtube] sync ${syncMs.toFixed(1)} ms`);
  expect(Math.abs(syncMs)).toBeLessThan(45);
});
