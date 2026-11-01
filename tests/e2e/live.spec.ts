// Live mode end to end: captures a real tab playing the fixture and checks what
// the offscreen document played back. Chrome only lets tabCapture run without a
// toolbar click for allowlisted extension ids, which is what Chrome's own tests use.
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { readWav } from '../../scripts/wav.mjs';
import { LIVE_PRESETS } from '../../src/live/presets';
import { ANALYSIS_RATE, bestLag, fitTwo, toAnalysisRate } from './analysis';
import { controlPage, extensionId, launch, ROOT, send } from './helpers';

// Available inside extension pages, where page.evaluate callbacks run.
declare const chrome: { tabs: { query(query: object): Promise<{ id?: number }[]> } };

test('live mode cleans a captured tab with the expected delay', async () => {
  const context = await launch({ args: [`--allowlisted-extension-id=${extensionId()}`], unmuted: true });
  await context.route('https://example.com/**', (route) =>
    route.request().url().endsWith('.wav')
      ? route.fulfill({ path: join(ROOT, 'fixtures/mix.wav'), contentType: 'audio/wav' })
      : route.fulfill({ contentType: 'text/html', body: '<audio id="a" src="/mix.wav" loop></audio><button onclick="a.play()">play</button>' }),
  );

  // An extension page to drive the extension from, sharing the offscreen document's storage.
  const control = await controlPage(context);
  await control.evaluate(() => localStorage.setItem('music-remover-debug', '1'));
  await send(control, { type: 'offscreen:ensure' });
  await send(control, { type: 'engine:preload', target: 'offscreen', model: 'umx-vocals' });
  await expect
    .poll(() => send<Record<string, { status: string }>>(control, { type: 'engine:states', target: 'offscreen' }).then((s) => s['umx-vocals'].status), {
      timeout: 120_000,
    })
    .toBe('ready');

  const tab = await context.newPage();
  await tab.goto('https://example.com/');
  await tab.bringToFront();
  // Without the tabs permission URLs are hidden, so take the newest tab.
  const tabId = await control.evaluate(async () => (await chrome.tabs.query({})).at(-1)!.id!);
  const status = await send<{ live: boolean; liveError?: string }>(control, { type: 'live:toggle', tabId });
  expect(status).toEqual({ live: true });
  // Start playback after capture so the recording holds the fixture's first pass from its start.
  await tab.click('button');

  await tab.waitForTimeout(26_000);
  const dump = await send<{ rate: number; processed: number[]; original: number[] }>(control, {
    type: 'live:debug-dump',
    target: 'offscreen',
    tabId,
  });
  await send(control, { type: 'live:toggle', tabId });
  await context.close();

  const processed = toAnalysisRate(Float32Array.from(dump.processed), dump.rate);
  const original = toAnalysisRate(Float32Array.from(dump.original), dump.rate);
  const [mix, speech, music] = ['mix', 'speech', 'music'].map((name) => toAnalysisRate(readWav(join(ROOT, `fixtures/${name}.wav`))[0], 44100));
  const second = (x: Float32Array, from: number, seconds = 2) => x.subarray(from * ANALYSIS_RATE, (from + seconds) * ANALYSIS_RATE);
  const median = (xs: number[]) => xs.toSorted((a, b) => a - b)[Math.floor(xs.length / 2)];

  // The tab loops the fixture; align on its first pass.
  const start = bestLag(original, second(mix, 0, 8));
  const delay = (bestLag(processed, second(speech, 0, 8)) - start) / ANALYSIS_RATE;
  const preset = LIVE_PRESETS.balanced;
  expect(delay).toBeGreaterThan(preset.block + preset.future - 0.05);
  expect(delay).toBeLessThan(preset.block * 2 + preset.future + 0.5);

  // The captured tab's clock drifts slightly from the file's, so fit in 2 s pieces,
  // each at its own alignment, and judge the medians.
  const heard: { a: number; ratio: number }[] = [];
  const untouched: number[] = [];
  for (let at = 2; at < 18; at += 2) {
    const offset = start + at * ANALYSIS_RATE;
    const lag = bestLag(processed.subarray(offset, offset + 6 * ANALYSIS_RATE), second(speech, at));
    const fit = fitTwo(processed.subarray(offset + lag, offset + lag + 2 * ANALYSIS_RATE), second(speech, at), second(music, at));
    heard.push({ a: fit.a, ratio: fit.b / fit.a });
    const orig = fitTwo(original.subarray(offset, offset + 2 * ANALYSIS_RATE), second(speech, at), second(music, at));
    untouched.push(orig.b / orig.a);
  }
  const ratio = median(heard.map((h) => h.ratio));
  console.log(`[live] delay ${delay.toFixed(2)} s, music/speech weight: original ${median(untouched).toFixed(2)}, heard ${ratio.toFixed(2)}`);
  expect(median(untouched)).toBeGreaterThan(0.8);
  expect(ratio).toBeLessThan(0.3);
  expect(median(heard.map((h) => h.a))).toBeGreaterThan(0.6);
});
