#!/usr/bin/env node
/** Actual UI exploration on the isolated synthetic development runtime. */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { readFileSync, writeFileSync, mkdirSync, lstatSync, realpathSync, existsSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { validateEnvironment } from './bootstrap.mjs';
import { launchBrowser, browserConfiguration } from '../../runtime/browser-tools/browser.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const app = resolve(root, 'srd-ai-ops');
const evidence = resolve(root, 'evidence/2026-10-31/f1-development');
const screenshotDirectory = resolve(evidence, 'screenshots');
const descriptorPath = resolve(app, '.ai/qa/test-env.json');
const reportPath = resolve(evidence, 'exploration-result.json');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

class ExplorationError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = (code) => { throw new ExplorationError(code); };
const within = (base, path) => {
  const child = relative(base, path);
  return child !== '..' && !child.startsWith('../') && !isAbsolute(child);
};

function readPrivateConfiguration(path) {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 65536 || (metadata.mode & 0o077)) fail('PRIVATE_CONFIGURATION_FILE_REQUIRED');
  if (!within(realpathSync(resolve(root, 'runtime/.secrets')), realpathSync(path))) fail('PRIVATE_CONFIGURATION_OUTSIDE_OWNED_DIRECTORY');
  return validateEnvironment(parseEnv(readFileSync(path, 'utf8')));
}

export function validateBootstrapReport(report, { baselineOnly = false } = {}) {
  if (!report || report.kind !== 'isolated-synthetic-native-bootstrap') fail('ISOLATED_BOOTSTRAP_REPORT_REQUIRED');
  if (baselineOnly) {
    if (report.status !== 'blocked' || report.mode !== 'apply' || report.configurationValidated !== true ||
        typeof report.failedStage !== 'string' || !report.failedStage ||
        typeof report.errorCode !== 'string' || !report.errorCode) fail('FAILED_BOOTSTRAP_REPORT_REQUIRED_FOR_BASELINE');
    return report;
  }
  if (report.status !== 'initialized-not-accepted' ||
      !Array.isArray(report.tenants) || report.tenants.length !== 2 ||
      report.tenants.some((tenant) => !UUID.test(tenant.tenantId) || !UUID.test(tenant.organizationId)) ||
      report.tenants[0].tenantId === report.tenants[1].tenantId) fail('SUCCESSFUL_ISOLATED_BOOTSTRAP_REPORT_REQUIRED');
  return report;
}

function readBootstrapReport(path, options) {
  if (!within(resolve(root, 'evidence'), resolve(path))) fail('BOOTSTRAP_EVIDENCE_OUTSIDE_PROJECT');
  const report = JSON.parse(readFileSync(path, 'utf8'));
  return validateBootstrapReport(report, options);
}

export function parseArguments(argv) {
  let envPath;
  let bootstrapPath = resolve(evidence, 'bootstrap-result.json');
  let baselineOnly = false;
  let runtime = 'pglite';
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (!['--env-file', '--bootstrap-report', '--baseline-only', '--runtime'].includes(flag) || seen.has(flag)) fail('INVALID_ARGUMENTS');
    seen.add(flag);
    if (flag === '--baseline-only') { baselineOnly = true; continue; }
    if (!argv[index + 1] || argv[index + 1].startsWith('--')) fail('INVALID_ARGUMENTS');
    const value = argv[++index];
    if (flag === '--runtime') {
      if (!['pglite', 'native-postgres'].includes(value)) fail('INVALID_RUNTIME');
      runtime = value;
    } else if (flag === '--env-file') envPath = resolve(value);
    else bootstrapPath = resolve(value);
  }
  if (!envPath) fail('PRIVATE_CONFIGURATION_FILE_REQUIRED');
  return { envPath, bootstrapPath, baselineOnly, runtime };
}

function makeSanitizer(config) {
  const sensitiveValues = Object.entries(config)
    .filter(([name, value]) => /PASSWORD|SECRET|KEY|EMAIL|URL/.test(name) && typeof value === 'string' && value.length >= 4)
    .map(([, value]) => value).sort((a, b) => b.length - a.length);
  return (value, limit = 16000) => {
    let text = String(value ?? '');
    for (const secret of sensitiveValues) text = text.split(secret).join('[redacted]');
    return text
      .replace(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
      .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted-token]')
      .replace(/\b(?:authorization|cookie|set-cookie)\s*[:=]\s*[^\r\n]+/gi, '[redacted-header]')
      .replace(/(["']?(?:password|access_token|refresh_token|api_key|secret|token)["']?\s*[:=]\s*)["']?[^\s,"'}]+/gi, '$1[redacted]')
      .replace(/https?:\/\/[^\s<>"']+/gi, (raw) => {
        try { const url = new URL(raw); return url.origin + url.pathname; } catch { return '[redacted-url]'; }
      })
      .slice(0, limit);
  };
}

function safeRoute(raw, sanitize) {
  try {
    const url = new URL(raw);
    return sanitize(url.pathname.replace(/[A-Za-z0-9_-]{48,}/g, '[redacted-id]'), 300);
  } catch { return '[unavailable-route]'; }
}

async function availablePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = address && typeof address !== 'string' ? address.port : null;
  await new Promise((done) => server.close(done));
  if (!port) fail('LOOPBACK_PORT_UNAVAILABLE');
  return port;
}

async function waitForLogin(origin, child, report) {
  const deadline = Date.now() + 35000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) fail('APPLICATION_EXITED_DURING_STARTUP');
    try {
      const response = await fetch(origin + '/login', { signal: AbortSignal.timeout(4000) });
      report.http.push({ route: '/login', status: response.status });
      await response.arrayBuffer();
      if (response.status === 200) return;
    } catch { /* Retry only within the bounded readiness window. */ }
    await delay(200);
  }
  fail('LOGIN_READINESS_TIMEOUT');
}

async function observedControls(page, sanitize) {
  const value = await page.evaluate(() => ({
    title: document.title,
    language: document.documentElement.lang,
    headings: [...document.querySelectorAll('h1,h2')].map((element) => element.textContent?.trim() ?? ''),
    inputs: [...document.querySelectorAll('input')].map((input, index) => ({
      index, type: input.type, id: input.id, name: input.name,
      autocomplete: input.autocomplete,
      labels: [...(input.labels ?? [])].map((label) => label.textContent?.trim() ?? ''),
    })),
    buttons: [...document.querySelectorAll('button')].map((button, index) => ({
      index, type: button.type, text: button.innerText.trim(), ariaLabel: button.getAttribute('aria-label') ?? '',
    })),
    body: document.body.innerText,
  }));
  const clean = (entry) => {
    if (typeof entry === 'string') return sanitize(entry, 16000);
    if (Array.isArray(entry)) return entry.map(clean);
    if (entry && typeof entry === 'object') return Object.fromEntries(Object.entries(entry).map(([key, item]) => [key, clean(item)]));
    return entry;
  };
  return clean(value);
}

async function screenshot(page, name, config, report) {
  const populatedInputs = await page.locator('input').evaluateAll((inputs) => {
    const valueBearingTypes = new Set(['email', 'password', 'text', 'search', 'tel', 'url', 'number', 'date', 'datetime-local']);
    return inputs.flatMap((input, index) => valueBearingTypes.has(input.type) && input.value ? [index] : []);
  });
  const masks = populatedInputs.map((index) => page.locator('input').nth(index));
  for (const name of ['SRD_F1_EMAIL_A', 'SRD_F1_EMAIL_B']) {
    masks.push(page.getByText(config[name], { exact: false }));
  }
  const path = resolve(screenshotDirectory, name + '.png');
  await page.screenshot({ path, fullPage: true, mask: masks });
  report.screenshots.push({ file: relative(root, path).split('\\').join('/'), kind: report.baselineOnly ? 'actual-uninitialized-app-baseline' : 'actual-synthetic-development-app', inputValuesMasked: true });
}

async function inspectRoute(page, origin, route, label, viewport, config, report, sanitize) {
  await page.setViewportSize(viewport);
  const response = await page.goto(origin + route, { waitUntil: 'domcontentloaded', timeout: 25000 });
  let networkIdleReached = true;
  try { await page.waitForLoadState('networkidle', { timeout: 8000 }); } catch { networkIdleReached = false; }
  const observation = await observedControls(page, sanitize);
  const actualRoute = safeRoute(page.url(), sanitize);
  const renderingErrorDetected = /application error|a client-side exception|a server-side exception|internal server error/i.test(observation.body);
  report.pages.push({ requestedRoute: route, actualRoute, viewport, status: response?.status() ?? null, networkIdleReached, renderingErrorDetected, observation });
  await screenshot(page, label, config, report);
  if (actualRoute.startsWith('/login')) fail('AUTHENTICATED_ROUTE_REDIRECTED_TO_LOGIN');
  if (!response || response.status() >= 400 || renderingErrorDetected) fail('AUTHENTICATED_PAGE_FAILED_TO_RENDER');
}

async function stopApplication(child, exited) {
  if (!child) return { started: false, stopped: true };
  if (child.exitCode === null) child.kill('SIGTERM');
  let outcome = await Promise.race([exited, delay(4500).then(() => null)]);
  if (!outcome) {
    child.kill('SIGKILL');
    outcome = await Promise.race([exited, delay(2500).then(() => null)]);
  }
  return { started: true, stopped: Boolean(outcome), exitCode: outcome?.code ?? null, signal: outcome?.signal ?? null };
}

export async function main(argv = process.argv.slice(2)) {
  const report = {
    schemaVersion: 1, kind: 'actual-app-exploration', runId: randomUUID(),
    startedAtUtc: new Date().toISOString(), clientDate: '2026-10-31 Asia/Dhaka',
    status: 'blocked', phaseAccepted: false, productionAccepted: false, nativePostgresSecurityAccepted: false,
    credentialsIncluded: false, inputValuesIncluded: false, rawApplicationLogsRetained: false,
    observedSelectorsBeforeLogin: false, loginPerformed: false,
    http: [], pages: [], screenshots: [], networkErrors: [], consoleErrors: [], pageErrors: [],
  };
  let child;
  let exited;
  let browser;
  let descriptor;
  let stage = 'input';
  try {
    const { envPath, bootstrapPath, baselineOnly, runtime } = parseArguments(argv);
    const config = readPrivateConfiguration(envPath);
    const bootstrap = readBootstrapReport(bootstrapPath, { baselineOnly });
    report.baselineOnly = baselineOnly;
    report.selectedRuntime = runtime;
    report.kind = runtime === 'native-postgres'
      ? 'actual-app-exploration-on-native-postgres-development'
      : 'actual-app-exploration-on-pglite-development';
    report.bootstrapEvidenceStatus = bootstrap.status;
    if (baselineOnly) {
      report.kind = 'actual-uninitialized-app-baseline';
      report.databaseServiceStarted = false;
      report.baselineRequestsBlocked = [];
    }
    const sanitize = makeSanitizer(config);
    mkdirSync(screenshotDirectory, { recursive: true });
    if (existsSync(descriptorPath)) {
      try {
        const previous = JSON.parse(readFileSync(descriptorPath, 'utf8'));
        if (previous.status === 'running' && Number.isInteger(previous.app?.pid)) {
          try { process.kill(previous.app.pid, 0); fail('OTHER_SHARED_TEST_ENVIRONMENT_IS_RUNNING'); }
          catch (error) { if (error instanceof ExplorationError) throw error; }
        }
      } catch (error) { if (error instanceof ExplorationError) throw error; }
    }
    stage = 'application-start';
    const port = await availablePort();
    const origin = 'http://127.0.0.1:' + port;
    const environment = { ...process.env, ...Object.fromEntries(Object.entries(config).filter(([key]) => !key.startsWith('SRD_'))) };
    Object.assign(environment, {
      NODE_ENV: 'production', HOSTNAME: '127.0.0.1', APP_URL: origin, NEXT_PUBLIC_APP_URL: origin,
      TENANT_DATA_ENCRYPTION: 'yes', QUEUE_STRATEGY: 'local', CACHE_STRATEGY: 'memory',
      RATE_LIMIT_STRATEGY: 'memory', DB_POOL_MIN: '1', DB_POOL_MAX: '1',
      OM_DEV_WITH_MCP: '0', OM_DISABLE_EMAIL_DELIVERY: '1',
      OM_ENABLE_ENTERPRISE_MODULES: 'false', OM_ENABLE_ENTERPRISE_MODULES_SSO: 'false',
      OM_ENABLE_ENTERPRISE_MODULES_SECURITY: 'false', OM_ENABLE_ENTERPRISE_MODULES_AGENTS: 'false',
      NEXT_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1',
    });
    child = spawn(process.execPath, [resolve(app, 'node_modules/next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
      cwd: app, env: environment, stdio: ['ignore', 'pipe', 'pipe'],
    });
    exited = new Promise((done) => child.once('exit', (code, signal) => done({ code, signal })));
    let startupError = false;
    child.once('error', () => { startupError = true; });
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});
    descriptor = {
      version: 1, runId: report.runId, status: 'starting', mode: 'dev', baseUrl: origin,
      startedByThisRepo: true, startScript: 'engineering/foundation/explore-app.mjs', stopScript: '',
      app: { startCommand: 'next start --hostname 127.0.0.1 --port <discovered>', port, healthPath: '/api/healthz', pid: child.pid },
      services: baselineOnly ? [] : [{ type: runtime === 'native-postgres' ? 'native-postgres-development' : 'postgres-compatible-pglite-development', host: '127.0.0.1', port: Number(new URL(config.DATABASE_URL).port || 5432), nativePostgresAccepted: false }],
      credentials: [], credentialFixtureFile: 'runtime/.secrets/foundation.env',
      browser: { provider: 'playwright', installed: true, command: 'runtime/browser-tools/browser.mjs', notes: 'Actual installed browser used by the integrated runner.' },
      playwright: { runner: 'playwright', installed: true, config: '.ai/qa/tests/playwright.config.ts', browsers: ['chromium'] },
      testRunner: { name: 'playwright', config: '.ai/qa/tests/playwright.config.ts' }, platform: process.platform,
      startedAt: report.startedAtUtc,
      notes: baselineOnly
        ? 'Uninitialized built-app baseline only. Bootstrap remains blocked; this runner starts no database service, submits no login and visits no authenticated backend. No phase/security/production acceptance. Cleanup is performed in finally.'
        : runtime === 'native-postgres'
          ? 'Native PostgreSQL development exploration selected explicitly by CLI. Database version and security/tenant-isolation/concurrency/recovery acceptance require separate evidence; no phase or production acceptance follows from this explorer. Cleanup is performed in finally by this runner.'
          : 'PGlite serialized development exploration only. Native PostgreSQL, isolation/concurrency/recovery and production gates remain open. App and browser must share the owning process tree. Cleanup is performed in finally by this runner.',
    };
    mkdirSync(dirname(descriptorPath), { recursive: true });
    writeFileSync(descriptorPath, JSON.stringify(descriptor, null, 2) + '\n');
    await waitForLogin(origin, child, report);
    if (startupError) fail('APPLICATION_START_FAILED');
    stage = 'health';
    let health;
    try {
      const response = await fetch(origin + '/api/healthz', { signal: AbortSignal.timeout(12000) });
      const body = await response.json().catch(() => ({}));
      health = { route: '/api/healthz', status: response.status, healthStatus: typeof body.status === 'string' ? sanitize(body.status, 40) : null };
    } catch { health = { route: '/api/healthz', status: null, healthStatus: 'unavailable' }; }
    report.http.push(health);
    descriptor.status = 'running';
    descriptor.healthVerified = health.status === 200 && health.healthStatus === 'ok';
    writeFileSync(descriptorPath, JSON.stringify(descriptor, null, 2) + '\n');
    stage = 'browser-launch';
    browser = await launchBrowser();
    report.browser = { actualVersion: browser.version(), playwrightVersion: (await browserConfiguration()).playwrightVersion };
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    if (baselineOnly) {
      await context.route('**/*', async (route) => {
        const request = route.request();
        const path = safeRoute(request.url(), sanitize);
        if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) || path.startsWith('/backend')) {
          if (report.baselineRequestsBlocked.length < 50) report.baselineRequestsBlocked.push({ method: request.method(), route: path });
          await route.abort('blockedbyclient');
        } else await route.continue();
      });
    }
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    page.on('console', (message) => {
      if (['error', 'warning'].includes(message.type()) && report.consoleErrors.length < 60) report.consoleErrors.push({ type: message.type(), text: sanitize(message.text(), 500) });
    });
    page.on('pageerror', (error) => { if (report.pageErrors.length < 30) report.pageErrors.push({ name: sanitize(error.name, 80), message: sanitize(error.message, 500) }); });
    page.on('requestfailed', (request) => {
      if (report.networkErrors.length < 100) report.networkErrors.push({ kind: 'request-failed', route: safeRoute(request.url(), sanitize), method: request.method() });
    });
    page.on('response', (response) => {
      if (response.status() >= 400 && report.networkErrors.length < 100) report.networkErrors.push({ kind: 'http-error', route: safeRoute(response.url(), sanitize), status: response.status() });
    });
    stage = 'login-observation';
    await page.goto(origin + '/login', { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.locator('input[type="password"]').waitFor({ state: 'visible', timeout: 20000 });
    const login = await observedControls(page, sanitize);
    report.pages.push({ requestedRoute: '/login', actualRoute: safeRoute(page.url(), sanitize), viewport: { width: 1440, height: 1000 }, observation: login });
    await screenshot(page, baselineOnly ? 'uninitialized-login-desktop' : 'login-desktop', config, report);
    if (baselineOnly) {
      await page.setViewportSize({ width: 375, height: 812 });
      report.pages.push({ requestedRoute: '/login', actualRoute: safeRoute(page.url(), sanitize), viewport: { width: 375, height: 812 }, observation: await observedControls(page, sanitize) });
      await screenshot(page, 'uninitialized-login-mobile', config, report);
      report.status = 'captured-uninitialized-app-baseline';
      report.foundationStillBlocked = true;
      return report;
    }
    if (!descriptor.healthVerified) {
      await page.setViewportSize({ width: 375, height: 812 });
      await screenshot(page, 'login-mobile', config, report);
      fail('APPLICATION_HEALTH_DEGRADED_LOGIN_BASELINE_CAPTURED');
    }
    const emailInput = login.inputs.find((input) => input.type === 'email') ?? login.inputs.find((input) => input.autocomplete === 'username');
    const passwordInput = login.inputs.find((input) => input.type === 'password');
    const submitButton = login.buttons.find((button) => button.type === 'submit');
    if (!emailInput || !passwordInput || !submitButton) fail('OBSERVED_LOGIN_CONTROLS_INCOMPLETE');
    report.observedSelectorsBeforeLogin = true;
    const inputLocator = (input) => input.labels[0]
      ? page.getByLabel(input.labels[0], { exact: true }) : page.locator('input').nth(input.index);
    await inputLocator(emailInput).fill(config.SRD_F1_EMAIL_A);
    await inputLocator(passwordInput).fill(config.SRD_F1_PASSWORD_A);
    stage = 'login-submit';
    const submitName = submitButton.ariaLabel || submitButton.text;
    const submit = submitName ? page.getByRole('button', { name: submitName, exact: true }) : page.locator('button').nth(submitButton.index);
    await submit.click();
    try { await page.waitForURL((url) => url.pathname.startsWith('/backend'), { timeout: 25000 }); }
    catch {
      report.loginFailureObservation = await observedControls(page, sanitize);
      await screenshot(page, 'login-result', config, report);
      fail('LOGIN_DID_NOT_REACH_BACKEND');
    }
    report.loginPerformed = true;
    stage = 'authenticated-routes';
    for (const [route, label, viewport] of [
      ['/backend', 'dashboard-desktop', { width: 1440, height: 1000 }],
      ['/backend/customers/people', 'contacts-desktop', { width: 1440, height: 1000 }],
      ['/backend', 'dashboard-mobile', { width: 375, height: 812 }],
      ['/backend/customers/people', 'contacts-mobile', { width: 375, height: 812 }],
    ]) await inspectRoute(page, origin, route, label, viewport, config, report, sanitize);
    report.status = 'explored-development-ui-not-accepted';
  } catch (error) {
    report.failedStage = stage;
    report.errorCode = error instanceof ExplorationError ? error.code : 'APP_EXPLORATION_STEP_FAILED';
  } finally {
    if (browser) {
      try { await browser.close(); report.browserClosed = true; }
      catch { report.browserClosed = false; }
    }
    report.applicationCleanup = await stopApplication(child, exited);
    report.endedAtUtc = new Date().toISOString();
    if (descriptor) {
      try {
        const current = JSON.parse(readFileSync(descriptorPath, 'utf8'));
        if (current.runId === report.runId) writeFileSync(descriptorPath, JSON.stringify({ ...descriptor, status: 'stopped', stoppedAt: report.endedAtUtc }, null, 2) + '\n');
      } catch { report.descriptorCleanupWarning = 'DESCRIPTOR_STOP_STATE_NOT_VERIFIED'; }
    }
    mkdirSync(evidence, { recursive: true });
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await main();
  process.stdout.write(JSON.stringify({ status: report.status, errorCode: report.errorCode ?? null, failedStage: report.failedStage ?? null, loginPerformed: report.loginPerformed, screenshotCount: report.screenshots.length, report: relative(root, reportPath), phaseAccepted: false, productionAccepted: false, applicationStopped: report.applicationCleanup.stopped }, null, 2) + '\n');
  process.exitCode = report.status === 'explored-development-ui-not-accepted' && report.applicationCleanup.stopped && report.browserClosed ? 0 : 2;
}
