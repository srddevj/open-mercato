#!/usr/bin/env node
/** Real built-app regression for notice overlap; no login or business writes. */
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
  kind: 'actual-built-app-notice-layout-regression', startedAtUtc: new Date().toISOString(),
  status: 'blocked', phaseAccepted: false, productionAccepted: false,
  loginSubmitted: false, businessMutationsAttempted: false, cases: [], screenshots: [],
};
let server;
let serverExit;
let browser;
let output;
let stage = 'configuration';

function currentSourceRevision() {
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
  return { sourceRevision: digest.digest('hex'), fileCount: paths.length, algorithm: 'sha256 length-prefixed relative path and bytes for src/, scripts/, package.json, yarn.lock, next.config.ts, tsconfig.json' };
}

async function freePort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((done) => probe.close(done));
  return port;
}

async function visibilityAtCenter(locator) {
  return locator.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const x = bounds.left + bounds.width / 2;
    const y = bounds.top + bounds.height / 2;
    const inViewport = x >= 0 && x < innerWidth && y >= 0 && y < innerHeight;
    const hit = inViewport ? document.elementFromPoint(x, y) : null;
    return {
      inViewport, uncovered: Boolean(hit && (element === hit || element.contains(hit))),
      bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
    };
  });
}

async function capture(page, name) {
  const path = resolve(output, name + '.png');
  await page.screenshot({ path, fullPage: true });
  report.screenshots.push({ file: relative(root, path).split('\\').join('/'), kind: 'actual-login-ui-regression' });
}

async function freshLogin(viewport, colorScheme, origin) {
  const context = await browser.newContext({ viewport, colorScheme, locale: 'en-US' });
  await context.route('**/*', (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    return ['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && !path.startsWith('/backend')
      ? route.continue() : route.abort('blockedbyclient');
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  await page.goto(origin + '/login', { waitUntil: 'domcontentloaded' });
  await page.locator('form[data-auth-ready="1"]').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Accept cookies', exact: true }).waitFor({ state: 'visible' });
  return { context, page };
}

async function keyboardCase(name, viewport, colorScheme, origin) {
  const { context, page } = await freshLogin(viewport, colorScheme, origin);
  const current = { name, viewport, colorScheme, keyboardReachedSignIn: false, keyboardReachedRecovery: false };
  try {
    await capture(page, name);
    const signIn = page.getByRole('button', { name: 'Sign in', exact: true });
    const recovery = page.getByRole('link', { name: 'Forgot password?', exact: true });
    const accept = page.getByRole('button', { name: 'Accept cookies', exact: true });
    current.notice = await accept.evaluate((button) => {
      const notice = button.closest('.pointer-events-auto');
      const bounds = notice?.getBoundingClientRect();
      return bounds ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } : null;
    });
    await page.getByLabel('Email', { exact: true }).focus();
    for (let index = 0; index < 14; index++) {
      await page.keyboard.press('Tab');
      if (await signIn.evaluate((element) => element === document.activeElement)) {
        current.keyboardReachedSignIn = true;
        current.signIn = await visibilityAtCenter(signIn);
      }
      if (await recovery.evaluate((element) => element === document.activeElement)) {
        current.keyboardReachedRecovery = true;
        current.recovery = await visibilityAtCenter(recovery);
      }
      if (current.keyboardReachedSignIn && current.keyboardReachedRecovery) break;
    }
    current.passed = Boolean(current.keyboardReachedSignIn && current.keyboardReachedRecovery &&
      current.signIn?.inViewport && current.signIn?.uncovered && current.recovery?.inViewport && current.recovery?.uncovered);
    await capture(page, name + '-keyboard-focus');
  } finally {
    report.cases.push(current);
    await context.close();
  }
}

async function acknowledgementCase(name, buttonName, expectedCookie, origin) {
  const { context, page } = await freshLogin({ width: 375, height: 812 }, 'light', origin);
  const current = { name };
  try {
    await page.getByRole('button', { name: buttonName, exact: true }).click();
    current.noticeDismissed = await page.getByRole('button', { name: 'Accept cookies', exact: true }).count() === 0;
    current.preferencePreserved = (await context.cookies()).some((cookie) => cookie.name === 'om_cookie_notice_ack' && cookie.value === expectedCookie);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('form[data-auth-ready="1"]').waitFor({ state: 'visible' });
    current.staysDismissedAfterReload = await page.getByRole('button', { name: 'Accept cookies', exact: true }).count() === 0;
    current.passed = current.noticeDismissed && current.preferencePreserved && current.staysDismissedAfterReload;
  } finally {
    report.cases.push(current);
    await context.close();
  }
}

try {
  const argv = process.argv.slice(2);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    if (!['--env-file', '--label'].includes(argv[index]) || values.has(argv[index]) || !argv[index + 1]) throw new Error();
    values.set(argv[index], argv[index + 1]);
  }
  if (!['before', 'after'].includes(values.get('--label')) || !values.get('--env-file')) throw new Error();
  report.label = values.get('--label');
  const privatePath = resolve(values.get('--env-file'));
  const metadata = lstatSync(privatePath);
  const underPrivate = relative(realpathSync(resolve(root, 'runtime/.secrets')), realpathSync(privatePath));
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) || isAbsolute(underPrivate) || underPrivate.startsWith('..')) throw new Error();
  const config = validateEnvironment(parseEnv(readFileSync(privatePath, 'utf8')));
  output = resolve(root, 'evidence/2026-10-31/notice-overlap', report.label);
  mkdirSync(output, { recursive: true });
  report.buildId = readFileSync(resolve(app, '.mercato/next/BUILD_ID'), 'utf8').trim();
  report.source = currentSourceRevision();
  const port = await freePort();
  const origin = 'http://127.0.0.1:' + port;
  const environment = { ...process.env, ...Object.fromEntries(Object.entries(config).filter(([key]) => !key.startsWith('SRD_'))),
    NODE_ENV: 'production', DEMO_MODE: 'false', OM_INTEGRATION_TEST: 'false',
    QUEUE_STRATEGY: 'local', CACHE_STRATEGY: 'memory', RATE_LIMIT_STRATEGY: 'memory',
    OM_DEV_WITH_MCP: '0', OM_ENABLE_ENTERPRISE_MODULES: 'false', NEXT_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1',
  };
  stage = 'app-start';
  server = spawn(process.execPath, [resolve(app, 'node_modules/next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: app, env: environment, stdio: ['ignore', 'ignore', 'ignore'],
  });
  serverExit = new Promise((done) => server.once('exit', (code, signal) => done({ code, signal })));
  server.once('error', () => {});
  let ready = false;
  for (let attempt = 0; attempt < 35 && !ready; attempt++) {
    if (server.exitCode !== null) throw new Error();
    try {
      const response = await fetch(origin + '/login', { signal: AbortSignal.timeout(3000) });
      await response.arrayBuffer();
      ready = response.status === 200;
    } catch { /* Bounded readiness retries only. */ }
    if (!ready) await delay(200);
  }
  if (!ready) throw new Error();
  const healthResponse = await fetch(origin + '/api/healthz', { signal: AbortSignal.timeout(12000) });
  const healthBody = await healthResponse.json().catch(() => ({}));
  report.health = { status: healthResponse.status, state: healthBody.status === 'ok' ? 'ok' : healthBody.status === 'degraded' ? 'degraded' : 'unknown' };
  stage = 'browser-regression';
  browser = await launchBrowser();
  report.browserVersion = browser.version();
  await keyboardCase('mobile-light', { width: 375, height: 812 }, 'light', origin);
  await keyboardCase('desktop-light', { width: 1440, height: 1000 }, 'light', origin);
  await keyboardCase('mobile-dark', { width: 375, height: 812 }, 'dark', origin);
  await keyboardCase('short-mobile-light', { width: 375, height: 480 }, 'light', origin);
  await acknowledgementCase('dismiss-cookie-notice-persists', 'Dismiss', 'dismissed', origin);
  await acknowledgementCase('accept-cookie-notice-persists', 'Accept cookies', 'ack', origin);
  report.status = report.cases.every((current) => current.passed) ? 'passed-ui-regression-only' : 'failed-ui-regression';
} catch {
  report.failedStage = stage;
  report.errorCode = 'NOTICE_UI_VERIFICATION_BLOCKED';
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
console.log(JSON.stringify({ status: report.status, failedStage: report.failedStage ?? null, cases: report.cases.map((current) => ({ name: current.name, passed: current.passed })), screenshots: report.screenshots.length, browserClosed: report.browserClosed, applicationStopped: report.applicationStopped, phaseAccepted: false }, null, 2));
process.exitCode = report.status === 'passed-ui-regression-only' && report.browserClosed && report.applicationStopped ? 0 : report.status === 'failed-ui-regression' ? 1 : 2;
