// The popup's language picker: it switches at once, is kept, and goes back.
import { expect, test } from '@playwright/test';
import { extensionId, launch } from './helpers';

test('switches the popup to Arabic and back from its settings', async () => {
  const context = await launch();
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId()}/popup.html`);
  // The test browser runs in English, which "Automatic" follows.
  await expect(page.locator('#language')).toHaveValue('auto');
  await expect(page.locator('h1')).toHaveText('Music Remover');

  await page.selectOption('#language', 'ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('h1')).toHaveText('مزيل الموسيقى');
  await expect(page.locator('#live-toggle')).toHaveText('تشغيل الوضع المباشر');
  await expect(page.locator('#liveLatency option[value="balanced"]')).toHaveText(/^متوازن \(نحو \d+ ملّي ثانية\)$/);

  await page.reload();
  await expect(page.locator('#language')).toHaveValue('ar');
  await expect(page.locator('h1')).toHaveText('مزيل الموسيقى');

  await page.selectOption('#language', 'en');
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await expect(page.locator('#live-toggle')).toHaveText('Start live mode');
  await expect(page.locator('#liveLatency option[value="balanced"]')).toHaveText(/^Balanced \(about \d+ ms\)$/);
  await context.close();
});
