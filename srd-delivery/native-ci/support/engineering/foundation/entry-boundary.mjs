#!/usr/bin/env node
/** Actual built-app public-entry regression. GET only; never submits auth. */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, lstatSync, realpathSync, readdirSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { validateEnvironment } from './bootstrap.mjs';
import { launchBrowser } from '../../runtime/browser-tools/browser.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const app = resolve(root, 'srd-ai-ops');
const report = {
  kind: 'actual-built-app-public-entry-regression', startedAtUtc: new Date().toISOString(),
  status: 'blocked', phaseAccepted: false, securityAccepted: false, productionAccepted: false,
  runtime: 'uninitialized', servicesStartedByRunner: [], loginSubmitted: false,
  businessMutationsAttempted: false, authenticatedCases: 'not-run',
  demoAutologin: 'disabled-for-anonymous-regression', cases: [], screenshots: [],
  limitations: ['Anonymous and malformed-cookie entry boundary only; not native authenticated session, tenant isolation, or production acceptance.',
    'Chromium runs without the OS sandbox in this root container; no browser sandbox or cross-origin security proof.'],
};
let server, serverExit, browser, output;
let stage = 'configuration';

function sourceSnapshot() {
  const walk = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? walk(path) : entry.isFile() ? [path] : [];
  });
  const paths = [...walk(resolve(app, 'src')), ...walk(resolve(app, 'scripts')),
    ...['package.json', 'yarn.lock', 'next.config.ts', 'tsconfig.json'].map((name) => resolve(app, name))]
    .sort((a, b) => relative(app, a) < relative(app, b) ? -1 : relative(app, a) > relative(app, b) ? 1 : 0);
  const digest = createHash('sha256');
  const length = (size) => { const value = Buffer.alloc(8); value.writeBigUInt64BE(BigInt(size)); return value; };
  for (const path of paths) {
    const name = Buffer.from(relative(app, path).split('\\').join('/'));
    const bytes = readFileSync(path);
    digest.update(length(name.length)); digest.update(name); digest.update(length(bytes.length)); digest.update(bytes);
  }
  return { sha256: digest.digest('hex'), fileCount: paths.length,
    note: 'Working source snapshot at run time; BUILD_ID identifies the served build. Matching build provenance must be established by the build log/attestation.' };
}

// Examine response content in memory. Persist boolean observations, never the
// rendered diagnostic/error text, cookie values, credentials, or raw HTML.
function exposure(content) {
  return {
    databaseStatusPanel: /Database Status/.test(content),
    globalAccountCountLabels: /Users:/.test(content) && /Tenants:/.test(content) && /Organizations:/.test(content),
    technicalModuleCatalog: /Active Modules/.test(content),
    rawDatabaseErrorIndicators: /ECONNREFUSED|EAI_AGAIN|ENOTFOUND|SASL|password authentication failed|connect ETIMEDOUT|relation [^\n]{0,100} does not exist|database [^\n]{0,100} does not exist/i.test(content),
  };
}
const exposed = (value) => Object.values(value).some(Boolean);

function visibleMarkupText(html) {
  // Locale dictionaries also contain these labels inside framework scripts.
  // Those dictionary entries are not rendered diagnostic panels. Inspect the
  // actual server-rendered markup, then corroborate with browser innerText.
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]*>/g, ' ');
}

async function freePort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((done) => probe.close(done));
  return port;
}

async function redirectCase(origin, name, path, cookie) {
  const current = { name, entryPath: path.split('?')[0], queryCase: path.includes('?'), chain: [], passed: false };
  let target = new URL(path, origin);
  for (let hop = 0; hop < 5; hop++) {
    const response = await fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(12000),
      headers: { 'accept-language': 'en-US', ...(cookie ? { cookie } : {}) } });
    const content = await response.text();
    const observed = exposure(visibleMarkupText(content));
    const step = { path: target.pathname, status: response.status, exposure: observed };
    current.chain.push(step);
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      const next = new URL(location, target);
      step.sameOriginLocation = next.origin === origin;
      step.destinationPath = step.sameOriginLocation ? next.pathname : 'external-blocked';
      step.destinationHasQuery = Boolean(next.search);
      if (!step.sameOriginLocation || !['/', '/start', '/login'].includes(next.pathname)) break;
      target = next;
      continue;
    }
    current.finalPath = target.pathname;
    current.finalStatus = response.status;
    current.loginFormObserved = /type=["']password["']/.test(content) && /type=["']email["']/.test(content);
    current.passed = current.chain.length === 2 && current.chain[0].status === 307 &&
      current.chain[0].destinationPath === '/login' && !current.chain[0].destinationHasQuery &&
      target.pathname === '/login' && response.status === 200 && current.loginFormObserved &&
      current.chain.every((item) => !exposed(item.exposure));
    break;
  }
  report.cases.push(current);
}

async function browserCase(origin) {
  const current = { name: 'actual-browser-direct-start', passed: false, layouts: [] };
  report.cases.push(current);
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 375, height: 812 }]) {
    const context = await browser.newContext({ viewport, locale: 'en-US', colorScheme: 'light' });
    try {
      await context.route('**/*', (route) => {
        const request = route.request();
        const url = new URL(request.url());
        return url.origin === origin && ['GET', 'HEAD', 'OPTIONS'].includes(request.method()) &&
          !url.pathname.startsWith('/backend') && !url.pathname.startsWith('/api/auth/')
          ? route.continue() : route.abort('blockedbyclient');
      });
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      await page.goto(origin + '/start', { waitUntil: 'domcontentloaded' });
      const body = await page.locator('body').innerText();
      const observed = exposure(body);
      const layout = { viewport, finalPath: new URL(page.url()).pathname, exposure: observed,
        emailInputCount: await page.getByLabel('Email', { exact: true }).count(),
        passwordInputCount: await page.getByLabel('Password', { exact: true }).count(),
        signInButtonCount: await page.getByRole('button', { name: 'Sign in', exact: true }).count(),
      };
      layout.passed = layout.finalPath === '/login' && !exposed(observed) && layout.emailInputCount === 1 &&
        layout.passwordInputCount === 1 && layout.signInButtonCount === 1;
      current.layouts.push(layout);
      if (report.label === 'after' && layout.passed) {
        await page.locator('form[data-auth-ready="1"]').waitFor({ state: 'visible' });
        if (report.expectedAvailability === 'degraded') {
          await page.getByRole('alert').filter({ hasText: 'Some services are temporarily unavailable.' }).waitFor({ state: 'visible' });
        }
        const file = resolve(output, viewport.width === 375 ? 'entry-login-mobile.png' : 'entry-login-desktop.png');
        // Mask only populated credential/text fields; checkbox values are UI state.
        const mask = page.locator('input[type="email"], input[type="password"], input[type="text"]');
        const populated = [];
        for (let index = 0; index < await mask.count(); index++) {
          const field = mask.nth(index);
          if (await field.inputValue()) populated.push(field);
        }
        await page.screenshot({ path: file, fullPage: true, mask: populated });
        report.screenshots.push({ file: relative(root, file).split('\\').join('/'), viewport,
          kind: 'actual-anonymous-entry-redirected-login', healthAccepted: false });
      }
    } finally { await context.close(); }
  }
  current.passed = current.layouts.length === 2 && current.layouts.every((item) => item.passed);
}

async function availabilityCase(origin, viewport, colorScheme, privateHost) {
  const name = 'availability-' + viewport.width + '-' + colorScheme;
  const current = { name, viewport, colorScheme, expected: report.expectedAvailability, passed: false,
    healthRequests: 0, healthResponses: [], maximumConcurrentHealthRequests: 0,
    nativeFeatureCheckPostsBlocked: 0, otherAuthWriteAttemptsBlocked: 0, authPostsSent: 0 };
  report.cases.push(current);
  const context = await browser.newContext({ viewport, locale: 'en-US', colorScheme });
  const active = new Set();
  const isHealth = (request) => new URL(request.url()).pathname === '/api/healthz';
  const warning = 'Some services are temporarily unavailable. You can still try signing in, or check again.';
  try {
    await context.route('**/*', (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname.startsWith('/api/auth/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
        if (url.pathname === '/api/auth/feature-check' && request.method() === 'POST') current.nativeFeatureCheckPostsBlocked++;
        else current.otherAuthWriteAttemptsBlocked++;
      }
      return url.origin === origin && ['GET', 'HEAD', 'OPTIONS'].includes(request.method()) &&
        !url.pathname.startsWith('/backend') && !url.pathname.startsWith('/api/auth/')
        ? route.continue() : route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('request', (request) => {
      if (!isHealth(request)) return;
      current.healthRequests++;
      active.add(request);
      current.maximumConcurrentHealthRequests = Math.max(current.maximumConcurrentHealthRequests, active.size);
    });
    const finish = (request) => { if (isHealth(request)) active.delete(request); };
    page.on('requestfinished', finish);
    page.on('requestfailed', finish);
    page.on('response', (response) => {
      if (isHealth(response.request())) current.healthResponses.push(response.status());
    });
    const initialResponse = page.waitForResponse((response) => isHealth(response.request()));
    initialResponse.catch(() => {}); // Avoid an unhandled rejection if navigation fails first.
    await page.goto(origin + '/login', { waitUntil: 'domcontentloaded' });
    await page.locator('form[data-auth-ready="1"]').waitFor({ state: 'visible' });
    const initial = await initialResponse;
    await initial.finished();
    const initialBody = await initial.json().catch(() => null);
    current.initialResponseState = ['ok', 'degraded'].includes(initialBody?.status) ? initialBody.status : 'unknown';
    current.initialHealthRequestCount = current.healthRequests;
    const signIn = page.getByRole('button', { name: 'Sign in', exact: true });
    current.originalSignInDisabled = await signIn.isDisabled();
    current.initialRealStatusMatches = initial.status() === (report.expectedAvailability === 'degraded' ? 503 : 200) &&
      current.initialResponseState === (report.expectedAvailability === 'degraded' ? 'degraded' : 'ok');
    if (report.expectedAvailability === 'degraded') {
      const alert = page.getByRole('alert').filter({ hasText: warning });
      await alert.waitFor({ state: 'visible' });
      current.genericWarningObserved = (await alert.innerText()).includes(warning);
      current.semanticWarning = await alert.evaluate((element) => element.getAttribute('aria-live') === 'polite' &&
        element.getAttribute('aria-atomic') === 'true' && element.getAttribute('data-status') === 'warning');
      current.warningTextContrast = await alert.evaluate((element, expectedText) => {
        const description = [...element.querySelectorAll('div')].find((node) => node.textContent === expectedText);
        if (!description) return null;
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
        const drawing = canvas.getContext('2d', { willReadFrequently: true });
        if (!drawing) return null;
        const rgba = (color) => { drawing.clearRect(0, 0, 1, 1); drawing.fillStyle = color; drawing.fillRect(0, 0, 1, 1); return [...drawing.getImageData(0, 0, 1, 1).data]; };
        const blend = (front, back) => { const alpha = front[3] / 255; return [0, 1, 2].map((index) => front[index] * alpha + back[index] * (1 - alpha)); };
        const ancestors = []; for (let node = description; node; node = node.parentElement) ancestors.unshift(node);
        let background = [255, 255, 255];
        for (const node of ancestors) background = blend(rgba(getComputedStyle(node).backgroundColor), background);
        const foreground = blend(rgba(getComputedStyle(description).color), background);
        const luminance = (rgb) => rgb.map((value) => value / 255).map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
          .reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index], 0);
        const first = luminance(foreground), second = luminance(background);
        return { ratio: Math.round(((Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)) * 100) / 100,
          foregroundRgb: foreground.map(Math.round), backgroundRgb: background.map(Math.round),
          method: 'Computed CSS colors rasterized to sRGB swatches, with ancestor alpha compositing; this text pair only.' };
      }, warning);
      const email = page.getByLabel('Email', { exact: true });
      const password = page.getByLabel('Password', { exact: true });
      // Synthetic UI-only values stay in browser memory and are never submitted.
      const emailValue = 'srd-ui-regression@srd.invalid';
      const passwordValue = 'SRD_UI_ONLY_NOT_AN_ACCOUNT_PASSWORD';
      await email.fill(emailValue);
      await password.fill(passwordValue);
      await page.evaluate(() => {
        window.__srdEntryRegression = { form: document.querySelector('form[data-auth-ready="1"]'),
          email: document.querySelector('input[type="email"]'), password: document.querySelector('input[type="password"]') };
      });
      const retry = page.getByRole('button', { name: 'Retry availability check', exact: true });
      await email.focus();
      current.keyboardReachedRetry = false;
      for (let index = 0; index < 24; index++) {
        await page.keyboard.press('Shift+Tab');
        if (await retry.evaluate((element) => element === document.activeElement)) { current.keyboardReachedRetry = true; break; }
      }
      if (!current.keyboardReachedRetry) throw new Error();
      current.retryUncoveredAtKeyboardFocus = await retry.evaluate((element) => {
        const bounds = element.getBoundingClientRect(); const x = bounds.left + bounds.width / 2, y = bounds.top + bounds.height / 2;
        const hit = document.elementFromPoint(x, y);
        return x >= 0 && x < innerWidth && y >= 0 && y < innerHeight && Boolean(hit && (hit === element || element.contains(hit)));
      });
      const initialRequests = current.healthRequests;
      const retriedResponse = page.waitForResponse((response) => isHealth(response.request()));
      retriedResponse.catch(() => {});
      await page.keyboard.press('Enter');
      const retried = await retriedResponse;
      await retried.finished();
      const retryBody = await retried.json().catch(() => null);
      current.retryResponseState = ['ok', 'degraded'].includes(retryBody?.status) ? retryBody.status : 'unknown';
      await retry.waitFor({ state: 'visible' });
      await page.waitForFunction(() => {
        const button = [...document.querySelectorAll('button')].find((node) => node.textContent?.trim() === 'Retry availability check');
        return button && !button.disabled;
      });
      current.retryAdditionalRequests = current.healthRequests - initialRequests;
      current.retryRealStatusMatches = retried.status() === 503 && current.retryResponseState === 'degraded';
      current.formAndInputIdentityPreserved = await page.evaluate(() => {
        const original = window.__srdEntryRegression;
        return original?.form === document.querySelector('form[data-auth-ready="1"]') &&
          original?.email === document.querySelector('input[type="email"]') && original?.password === document.querySelector('input[type="password"]');
      });
      current.typedValuesPreserved = (await email.inputValue()) === emailValue && (await password.inputValue()) === passwordValue;
      current.signInDisabledStatePreserved = await signIn.isDisabled() === current.originalSignInDisabled;
      await email.fill(''); await password.fill('');
      await page.evaluate(() => { delete window.__srdEntryRegression; });
    } else {
      // Allow the real healthy result to commit. No outage/recovery is simulated.
      await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
      current.warningAbsentOnFreshHealthyBoot = await page.getByRole('alert').count() === 0;
    }
    const body = await page.locator('body').innerText();
    current.noVisibleTechnicalDiagnostics = !exposed(exposure(body)) &&
      !/SELECT\s+1|postgres(?:ql)?:\/\/|\{"status"\s*:|Infrastructure probe failed/i.test(body) &&
      (!privateHost || !body.includes(privateHost));
    current.totalHealthRequestCountMatches = current.initialHealthRequestCount === 1 && current.healthRequests === (report.expectedAvailability === 'degraded' ? 2 : 1);
    current.passed = current.initialRealStatusMatches && current.noVisibleTechnicalDiagnostics && current.totalHealthRequestCountMatches &&
      current.maximumConcurrentHealthRequests === 1 && current.otherAuthWriteAttemptsBlocked === 0 && current.authPostsSent === 0 &&
      (report.expectedAvailability === 'healthy' ? current.warningAbsentOnFreshHealthyBoot :
        current.genericWarningObserved && current.semanticWarning && current.keyboardReachedRetry && current.retryUncoveredAtKeyboardFocus &&
        current.retryAdditionalRequests === 1 && current.retryRealStatusMatches && current.formAndInputIdentityPreserved &&
        current.typedValuesPreserved && current.signInDisabledStatePreserved && current.warningTextContrast?.ratio >= 4.5);
    if (current.passed) {
      const file = resolve(output, name + '.png');
      await page.screenshot({ path: file, fullPage: true });
      report.screenshots.push({ file: relative(root, file).split('\\').join('/'), viewport, colorScheme,
        kind: 'actual-' + report.expectedAvailability + '-availability-login', inputsClearedBeforeCapture: true });
    }
  } finally { await context.close(); }
}

try {
  const argv = process.argv.slice(2);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    if (!['--env-file', '--label', '--expected-availability', '--runtime'].includes(argv[index]) || values.has(argv[index]) || !argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error();
    values.set(argv[index], argv[index + 1]);
  }
  if (!['before', 'after'].includes(values.get('--label')) || !values.get('--env-file')) throw new Error();
  report.label = values.get('--label');
  if (values.has('--expected-availability') && !['degraded', 'healthy'].includes(values.get('--expected-availability'))) throw new Error();
  if (report.label === 'after' && !values.has('--expected-availability')) throw new Error();
  report.expectedAvailability = values.get('--expected-availability') ?? 'not-tested-before-fix';
  if (values.has('--runtime') && !['uninitialized', 'native-postgres', 'pglite'].includes(values.get('--runtime'))) throw new Error();
  report.runtime = values.get('--runtime') ?? 'uninitialized';
  report.runtimeAttestation = 'Caller-declared; the runner starts no database service and does not prove the database engine.';
  const privatePath = resolve(values.get('--env-file'));
  const metadata = lstatSync(privatePath);
  const underPrivate = relative(realpathSync(resolve(root, 'runtime/.secrets')), realpathSync(privatePath));
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) || isAbsolute(underPrivate) || underPrivate.startsWith('..')) throw new Error();
  const config = validateEnvironment(parseEnv(readFileSync(privatePath, 'utf8')));
  output = resolve(root, 'evidence/2026-10-31/entry-boundary', report.label);
  mkdirSync(output, { recursive: true });
  report.buildId = readFileSync(resolve(app, '.mercato/next/BUILD_ID'), 'utf8').trim();
  report.workingSourceSnapshot = sourceSnapshot();
  const origin = 'http://127.0.0.1:' + await freePort();
  const environment = { ...process.env, ...Object.fromEntries(Object.entries(config).filter(([key]) => !key.startsWith('SRD_'))),
    NODE_ENV: 'production', DEMO_MODE: 'false', OM_INTEGRATION_TEST: 'false',
    QUEUE_STRATEGY: 'local', CACHE_STRATEGY: 'memory', RATE_LIMIT_STRATEGY: 'memory',
    OM_DEV_WITH_MCP: '0', OM_ENABLE_ENTERPRISE_MODULES: 'false', NEXT_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1',
    OM_AUTOLOGIN_EMAIL: '', OM_AUTOLOGIN_PASSWORD: '', OM_AUTOLOGIN_TENANT: '',
  };
  stage = 'app-start';
  server = spawn(process.execPath, [resolve(app, 'node_modules/next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', new URL(origin).port], {
    cwd: app, env: environment, stdio: ['ignore', 'ignore', 'ignore'],
  });
  serverExit = new Promise((done) => server.once('exit', (code, signal) => done({ code, signal })));
  server.once('error', () => {});
  let ready = false;
  for (let attempt = 0; attempt < 35 && !ready; attempt++) {
    if (server.exitCode !== null) throw new Error();
    try { const response = await fetch(origin + '/login', { signal: AbortSignal.timeout(3000) }); await response.arrayBuffer(); ready = response.status === 200; }
    catch { /* Bounded readiness retries. */ }
    if (!ready) await delay(200);
  }
  if (!ready) throw new Error();
  const health = await fetch(origin + '/api/healthz', { signal: AbortSignal.timeout(12000) });
  const healthBody = await health.json().catch(() => ({}));
  report.health = { status: health.status, state: ['ok', 'degraded'].includes(healthBody.status) ? healthBody.status : 'unknown' };
  stage = 'http-entry-regression';
  for (const [name, cookie] of [['anonymous', ''], ['malformed-auth', 'auth_token=invalid-synthetic-token'],
    ['legacy-dismissed', 'start_page_dismissed=1'], ['malformed-auth-legacy-dismissed', 'auth_token=invalid-synthetic-token; start_page_dismissed=1']]) {
    for (const path of ['/', '/start']) await redirectCase(origin, name + (path === '/' ? '-home' : '-start'), path, cookie);
  }
  for (const path of ['/', '/start']) await redirectCase(origin, 'hostile-redirect-query' + (path === '/' ? '-home' : '-start'), path + '?redirect=https://invalid.example&returnTo=//invalid.example', '');
  stage = 'browser-entry-regression';
  browser = await launchBrowser();
  report.browserVersion = browser.version();
  await browserCase(origin);
  if (report.label === 'after') {
    const privateHost = new URL(config.DATABASE_URL).hostname;
    for (const viewport of [{ width: 375, height: 812 }, { width: 1440, height: 1000 }]) {
      for (const colorScheme of ['light', 'dark']) await availabilityCase(origin, viewport, colorScheme, privateHost);
    }
  }
  report.status = report.cases.every((item) => item.passed) ? 'passed-anonymous-entry-regression-only' : 'failed-entry-regression';
} catch {
  report.failedStage = stage;
  report.errorCode = 'PUBLIC_ENTRY_VERIFICATION_BLOCKED';
} finally {
  if (browser) { try { await browser.close(); report.browserClosed = true; } catch { report.browserClosed = false; } }
  if (server) {
    if (server.exitCode === null) server.kill('SIGTERM');
    let stopped = await Promise.race([serverExit, delay(4500).then(() => null)]);
    if (!stopped) { server.kill('SIGKILL'); stopped = await Promise.race([serverExit, delay(2500).then(() => null)]); }
    report.applicationStopped = Boolean(stopped);
  }
  report.endedAtUtc = new Date().toISOString();
  if (output) writeFileSync(resolve(output, 'result.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ status: report.status, failedStage: report.failedStage ?? null,
  cases: report.cases.map(({ name, passed }) => ({ name, passed })), screenshots: report.screenshots.length,
  browserClosed: report.browserClosed, applicationStopped: report.applicationStopped,
  phaseAccepted: false, securityAccepted: false, productionAccepted: false }, null, 2));
process.exitCode = report.status === 'passed-anonymous-entry-regression-only' && report.browserClosed && report.applicationStopped ? 0 : report.status === 'failed-entry-regression' ? 1 : 2;
