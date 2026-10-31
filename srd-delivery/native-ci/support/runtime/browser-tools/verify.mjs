/** This inline-page smoke is browser evidence, never product feature evidence. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { launchBrowser, browserConfiguration, browserLaunchFailureReport } from './browser.mjs';

const artifacts = new URL('./artifacts/', import.meta.url);
await mkdir(artifacts, { recursive: true });
let browser;
let stage = 'browser-launch';
const result = {
  checkedAtUtc: new Date().toISOString(),
  kind: 'inline-page-browser-runtime-smoke-not-product-acceptance',
  status: 'failed',
  browserClosed: false,
};
try {
  browser = await launchBrowser();
  stage = 'inline-page-smoke';
  const context = await browser.newContext({ viewport: { width: 1100, height: 700 } });
  const page = await context.newPage();
  await page.setContent('<!doctype html><html lang="en"><meta charset="utf-8"><title>Browser runtime check</title><body style="font:24px sans-serif;padding:48px;background:#f8fafc;color:#0f172a"><h1>Browser runtime verification</h1><p>This is an inline browser test, not the product UI.</p><button>Verification control</button></body></html>');
  assert.equal(await page.title(), 'Browser runtime check');
  assert.equal(await page.getByRole('heading', { name: 'Browser runtime verification' }).count(), 1);
  await page.getByRole('button', { name: 'Verification control' }).focus();
  assert.equal(await page.getByRole('button', { name: 'Verification control' }).evaluate((element) => element === document.activeElement), true);
  await page.screenshot({ path: fileURLToPath(new URL('browser-smoke.png', artifacts)), fullPage: true });
  result.configuration = await browserConfiguration();
  result.actualBrowserVersion = browser.version();
  result.screenshot = 'artifacts/browser-smoke.png';
  result.status = 'passed';
} catch (error) {
  result.failedStage = stage;
  result.errorType = stage === 'browser-launch' ? 'BrowserLaunchError' : 'BrowserSmokeError';
  if (stage === 'browser-launch') result.browserLaunchFailure = browserLaunchFailureReport(error);
  process.exitCode = 1;
} finally {
  if (browser) {
    try { await browser.close(); result.browserClosed = true; }
    catch {
      result.status = 'failed'; result.browserClosed = false;
      result.errorType = 'BrowserCloseError'; result.errorCode = 'BROWSER_SMOKE_CLOSE_FAILED';
      process.exitCode = 1;
    }
  }
  result.finishedAtUtc = new Date().toISOString();
  await writeFile(new URL('./verification-result.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ status: result.status, actualBrowserVersion: result.actualBrowserVersion ?? null, screenshot: result.screenshot ?? null, browserClosed: result.browserClosed, errorType: result.errorType ?? null }, null, 2) + '\n');
}
