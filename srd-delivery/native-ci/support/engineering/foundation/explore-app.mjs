#!/usr/bin/env node
/** Actual UI exploration on the isolated synthetic development runtime. */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { readFileSync, writeFileSync, mkdirSync, lstatSync, realpathSync, existsSync, openSync, closeSync, constants } from 'node:fs';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { validateEnvironment } from './bootstrap.mjs';
import { runAcceptance, createNativeInspector, validateBootstrap, reserveEvidence, writeReservedEvidence } from './acceptance.mjs';
import { launchBrowser, browserConfiguration, browserLaunchFailureReport } from '../../runtime/browser-tools/browser.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const app = resolve(root, 'srd-ai-ops');
const evidence = resolve(root, 'evidence/2026-10-31/f1-development');
const screenshotDirectory = resolve(evidence, 'screenshots');
const descriptorPath = resolve(app, '.ai/qa/test-env.json');
const reportPath = resolve(evidence, 'exploration-result.json');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

class ExplorationError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = (code) => { throw new ExplorationError(code); };
const within = (base, path) => {
  const child = relative(base, path);
  return child !== '..' && !child.startsWith('../') && !isAbsolute(child);
};

export function assertOwnedFile(path, base, { createParents = false, maximumBytes = 2_000_000 } = {}) {
  path = resolve(path);
  base = resolve(base);
  if (!within(root, base) || !within(base, path) || path === base) fail('OWNED_ARTIFACT_PATH_REQUIRED');
  let directory = root;
  for (const part of relative(root, dirname(path)).split('/').filter(Boolean)) {
    directory = resolve(directory, part);
    if (!existsSync(directory) && createParents) mkdirSync(directory, { mode: 0o700 });
    const metadata = lstatSync(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail('OWNED_ARTIFACT_PATH_REQUIRED');
  }
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > maximumBytes) fail('OWNED_ARTIFACT_FILE_REQUIRED');
    return metadata;
  } catch (error) {
    if (error?.code === 'ENOENT' && createParents) return null;
    throw error;
  }
}

function writeOwnedJson(path, base, value) {
  assertOwnedFile(path, base, { createParents: true });
  const descriptor = openSync(path, constants.O_CREAT | constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(descriptor, JSON.stringify(value, null, 2) + '\n'); }
  finally { closeSync(descriptor); }
}

export function readPrivateConfiguration(path) {
  const metadata = assertOwnedFile(path, resolve(root, 'runtime/.secrets'), { maximumBytes: 65536 });
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

export function readBootstrapReport(path, options) {
  assertOwnedFile(path, resolve(root, 'evidence'));
  const report = JSON.parse(readFileSync(path, 'utf8'));
  return validateBootstrapReport(report, options);
}

export function parseArguments(argv) {
  let envPath;
  let bootstrapPath = resolve(evidence, 'bootstrap-result.json');
  let baselineOnly = false;
  let runtime = 'pglite';
  let verifyNativeApi = false;
  let sourceRevision;
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (!['--env-file', '--bootstrap-report', '--baseline-only', '--runtime', '--verify-native-api', '--source-revision'].includes(flag) || seen.has(flag)) fail('INVALID_ARGUMENTS');
    seen.add(flag);
    if (flag === '--baseline-only') { baselineOnly = true; continue; }
    if (flag === '--verify-native-api') { verifyNativeApi = true; continue; }
    if (!argv[index + 1] || argv[index + 1].startsWith('--')) fail('INVALID_ARGUMENTS');
    const value = argv[++index];
    if (flag === '--runtime') {
      if (!['pglite', 'native-postgres'].includes(value)) fail('INVALID_RUNTIME');
      runtime = value;
    } else if (flag === '--source-revision') sourceRevision = value;
    else if (flag === '--env-file') envPath = resolve(value);
    else bootstrapPath = resolve(value);
  }
  if (!envPath) fail('PRIVATE_CONFIGURATION_FILE_REQUIRED');
  if (sourceRevision !== undefined && !REVISION.test(sourceRevision)) fail('EXACT_SOURCE_REVISION_REQUIRED');
  if (verifyNativeApi && (baselineOnly || runtime !== 'native-postgres')) fail('NATIVE_API_REQUIRES_AUTHENTICATED_NATIVE_RUNTIME');
  if (verifyNativeApi && !sourceRevision) fail('NATIVE_API_SOURCE_REVISION_REQUIRED');
  return { envPath, bootstrapPath, baselineOnly, runtime, verifyNativeApi, sourceRevision };
}

export function assertNativeApiPrerequisites(options, report) {
  if (!options.verifyNativeApi || options.baselineOnly || options.runtime !== 'native-postgres' || !REVISION.test(options.sourceRevision ?? '')) fail('NATIVE_API_REQUIRES_AUTHENTICATED_NATIVE_RUNTIME');
  if (!UUID.test(report.runId ?? '') || report.baselineOnly !== false || report.selectedRuntime !== 'native-postgres' ||
      report.loginPerformed !== true || report.observedSelectorsBeforeLogin !== true ||
      !report.http?.some((entry) => entry.route === '/api/healthz' && entry.status === 200 && entry.healthStatus === 'ok')) fail('NATIVE_API_REQUIRES_OBSERVED_AUTHENTICATED_UI');
  for (const [route, label, width, height] of [
    ['/backend', 'dashboard-desktop', 1440, 1000], ['/backend/customers/people', 'contacts-desktop', 1440, 1000],
    ['/backend', 'dashboard-mobile', 375, 812], ['/backend/customers/people', 'contacts-mobile', 375, 812],
  ]) {
    const observed = report.pages?.some((page) => page.requestedRoute === route && page.actualRoute === route &&
      page.status >= 200 && page.status < 400 && page.renderingErrorDetected === false && page.observation &&
      page.viewport?.width === width && page.viewport?.height === height);
    const captured = report.screenshots?.some((shot) => shot.file === relative(root, resolve(screenshotDirectory, label + '.png')).split('\\').join('/') &&
      shot.kind === 'actual-synthetic-development-app' && shot.inputValuesMasked === true);
    if (!observed || !captured) fail('NATIVE_API_REQUIRES_OBSERVED_AUTHENTICATED_UI');
  }
}

export function nativeApiSubsetPassed(report, sourceRevision) {
  return report?.kind === 'native-foundation-api-acceptance-candidate' && report.status === 'passed-native-api-foundation-subset' &&
    report.executionKind === 'native-api-and-database' && report.sourceRevision === sourceRevision &&
    report.apiPersistenceAndTenantSubsetAccepted === true && report.phaseAccepted === false && report.productionAccepted === false &&
    report.backgroundJobsAccepted === false && report.databaseLeastPrivilegeAccepted === false &&
    report.credentialsIncluded === false && report.rawBodiesRetained === false &&
    report.database?.kind === 'native-postgres17-direct-read' && Number.isInteger(report.database.serverVersionNumber) &&
    report.database.serverVersionNumber >= 170000 && report.database.serverVersionNumber < 180000 &&
    report.cleanup?.contactsRemaining === 0 && report.cleanup?.sessionsRevoked === 2 && report.cleanup?.databaseClosed === true &&
    !report.cleanup?.errorCode && !report.cleanup?.sessionError;
}

function nativeApiEvidence(report, options, exploration, config, actualRunner) {
  const sanitize = makeSanitizer(config);
  const code = (value) => typeof value === 'string' && /^[A-Z0-9_]{1,100}$/.test(value) ? sanitize(value, 100) : null;
  const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const timestamp = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ? value : null;
  const passed = actualRunner && nativeApiSubsetPassed(report, options.sourceRevision);
  const knownStatuses = ['failed', 'blocked', 'failed-cleanup', 'passed-native-api-foundation-subset', 'passed-harness-simulation'];
  let status = knownStatuses.includes(report?.status) ? report.status : 'blocked';
  if (!actualRunner && status === 'passed-native-api-foundation-subset') status = 'passed-harness-simulation';
  else if (actualRunner && status === 'passed-native-api-foundation-subset' && !passed) status = 'failed-incomplete-acceptance';
  return {
    schemaVersion: 1, kind: 'native-foundation-api-acceptance-candidate',
    runId: UUID.test(report?.runId ?? '') ? report.runId : null, explorationRunId: exploration.runId,
    startedAtUtc: timestamp(report?.startedAtUtc), endedAtUtc: timestamp(report?.endedAtUtc),
    sourceRevision: options.sourceRevision, status,
    executionKind: actualRunner ? report?.executionKind === 'native-api-and-database' ? 'native-api-and-database' : 'unverified' : 'harness-unit-simulation',
    phaseAccepted: false, productionAccepted: false, backgroundJobsAccepted: false, databaseLeastPrivilegeAccepted: false,
    exportRestoreAccepted: false, apiPersistenceAndTenantSubsetAccepted: passed,
    credentialsIncluded: false, rawBodiesRetained: false,
    database: report?.database?.kind === 'native-postgres17-direct-read' && Number.isInteger(report.database.serverVersionNumber) &&
      report.database.serverVersionNumber >= 170000 && report.database.serverVersionNumber < 180000
      ? { kind: 'native-postgres17-direct-read', serverVersionNumber: report.database.serverVersionNumber } : null,
    errorCode: code(report?.errorCode), failedStage: typeof report?.failedStage === 'string' ? sanitize(report.failedStage, 100) : null,
    cases: Array.isArray(report?.cases) ? report.cases.slice(0, 100).map((entry) => ({
      id: typeof entry.id === 'string' ? sanitize(entry.id, 100) : null, status: entry.status === 'passed' ? 'passed' : 'failed', code: code(entry.code),
    })) : [],
    requests: Array.isArray(report?.requests) ? report.requests.slice(0, 500).map((entry) => ({
      actor: ['A', 'B', 'anonymous'].includes(entry.actor) ? entry.actor : 'anonymous',
      method: ['GET', 'POST', 'PUT', 'DELETE'].includes(entry.method) ? entry.method : 'unavailable',
      route: typeof entry.route === 'string' ? sanitize(entry.route.split('?')[0], 200) : null, status: count(entry.status),
    })) : [],
    cleanup: { contactsRemoved: count(report?.cleanup?.contactsRemoved), contactsRemaining: count(report?.cleanup?.contactsRemaining),
      sessionsRevoked: count(report?.cleanup?.sessionsRevoked), databaseClosed: report?.cleanup?.databaseClosed === true,
      errorCode: code(report?.cleanup?.errorCode), sessionError: code(report?.cleanup?.sessionError) },
  };
}

export async function verifyNativeApiAfterUi({ options, exploration, config, bootstrap, origin }, operations = {}) {
  assertNativeApiPrerequisites(options, exploration);
  validateBootstrap(bootstrap);
  const path = resolve(evidence, 'native-api-acceptance-' + exploration.runId + '.json');
  const createInspector = operations.createInspector ?? createNativeInspector;
  const run = operations.run ?? runAcceptance;
  const actualRunner = createInspector === createNativeInspector && run === runAcceptance;
  const summary = { requested: true, executed: false, status: 'blocked', report: null, passed: false,
    executionKind: actualRunner ? 'native-api-stage' : 'harness-unit-simulation',
    phaseAccepted: false, productionAccepted: false, backgroundJobsAccepted: false, exportRestoreAccepted: false };
  let descriptor;
  let inspector;
  let apiReport;
  try {
    descriptor = reserveEvidence(path);
    summary.report = relative(root, path).split('\\').join('/');
    writeReservedEvidence(descriptor, { kind: 'native-foundation-api-acceptance-candidate', status: 'starting', sourceRevision: options.sourceRevision,
      phaseAccepted: false, productionAccepted: false, backgroundJobsAccepted: false, exportRestoreAccepted: false });
    inspector = createInspector(config);
    summary.executed = true;
    apiReport = await run({ config, bootstrap, baseUrl: origin, sourceRevision: options.sourceRevision, inspector });
    // Retain the reviewed structured evidence fields only; unknown properties and raw bodies never cross this boundary.
    const saved = nativeApiEvidence(apiReport, options, exploration, config, summary.executionKind === 'native-api-stage');
    writeReservedEvidence(descriptor, saved);
    summary.status = saved.status;
    summary.passed = summary.executionKind === 'native-api-stage' && nativeApiSubsetPassed(apiReport, options.sourceRevision);
    if (!summary.passed) summary.errorCode = 'NATIVE_API_ACCEPTANCE_INCOMPLETE';
  } catch {
    summary.status = 'blocked';
    summary.errorCode = 'NATIVE_API_ACCEPTANCE_OPERATION_FAILED';
    if (descriptor !== undefined) {
      try { writeReservedEvidence(descriptor, { kind: 'native-foundation-api-acceptance-candidate', status: 'blocked',
        sourceRevision: options.sourceRevision, errorCode: summary.errorCode, phaseAccepted: false, productionAccepted: false,
        backgroundJobsAccepted: false, exportRestoreAccepted: false, credentialsIncluded: false, rawBodiesRetained: false }); } catch { summary.report = null; }
    }
  } finally {
    if (inspector && apiReport?.cleanup?.databaseClosed !== true) {
      try { await inspector.close(); } catch { summary.passed = false; summary.errorCode = 'NATIVE_API_DATABASE_CLEANUP_FAILED'; }
    }
    if (descriptor !== undefined) { try { closeSync(descriptor); } catch { summary.passed = false; summary.errorCode = 'NATIVE_API_EVIDENCE_CLEANUP_FAILED'; } }
  }
  return summary;
}

export function explorationPassed(report) {
  return report.status === 'explored-development-ui-not-accepted' && report.applicationCleanup?.stopped === true && report.browserClosed === true &&
    report.evidenceWritten === true && (!report.loginAttempted || report.uiSessionCleanup?.revoked === true || report.uiSessionCleanup?.sessionFound === false && !report.loginPerformed) &&
    (!report.nativeApiVerification?.requested || report.nativeApiVerification.passed === true);
}

export async function revokeObservedUiSession(context, origin) {
  const summary = { attempted: true, sessionFound: false, revoked: false, credentialsIncluded: false };
  try {
    const url = new URL(origin);
    if (url.origin !== origin || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port) fail('OWNED_LOOPBACK_APP_REQUIRED');
    const token = (await context.cookies(origin)).find((cookie) => cookie.name === 'auth_token')?.value;
    if (!token) return summary;
    summary.sessionFound = true;
    const headers = { authorization: 'Bearer ' + token, cookie: 'auth_token=' + encodeURIComponent(token) };
    const logout = await context.request.post(origin + '/api/auth/logout', { headers, maxRedirects: 0, timeout: 12000 });
    summary.logoutStatus = logout.status();
    if (![302, 303, 307, 308].includes(summary.logoutStatus)) fail('UI_SESSION_LOGOUT_FAILED');
    const protectedResponse = await context.request.get(origin + '/api/customers/people?page=1&pageSize=1', { headers, maxRedirects: 0, timeout: 12000 });
    summary.reusedTokenStatus = protectedResponse.status();
    summary.revoked = summary.reusedTokenStatus === 401;
    if (!summary.revoked) summary.errorCode = 'UI_SESSION_REVOCATION_NOT_VERIFIED';
  } catch { summary.errorCode = 'UI_SESSION_REVOCATION_NOT_VERIFIED'; }
  return summary;
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
  assertOwnedFile(path, screenshotDirectory, { createParents: true, maximumBytes: 30_000_000 });
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
    backgroundJobsAccepted: false, exportRestoreAccepted: false,
    credentialsIncluded: false, inputValuesIncluded: false, rawApplicationLogsRetained: false,
    observedSelectorsBeforeLogin: false, loginPerformed: false, loginAttempted: false,
    nativeApiVerification: { requested: false, executed: false, status: 'not-requested', passed: false },
    http: [], pages: [], screenshots: [], networkErrors: [], consoleErrors: [], pageErrors: [],
  };
  let child;
  let exited;
  let browser;
  let context;
  let origin;
  let descriptor;
  let stage = 'input';
  try {
    const options = parseArguments(argv);
    const { envPath, bootstrapPath, baselineOnly, runtime, verifyNativeApi, sourceRevision } = options;
    const config = readPrivateConfiguration(envPath);
    const bootstrap = readBootstrapReport(bootstrapPath, { baselineOnly });
    if (verifyNativeApi) validateBootstrap(bootstrap);
    report.baselineOnly = baselineOnly;
    report.selectedRuntime = runtime;
    report.sourceRevision = sourceRevision ?? null;
    report.nativeApiVerification = { requested: verifyNativeApi, executed: false, status: verifyNativeApi ? 'waiting-for-observed-ui' : 'not-requested', passed: false };
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
    assertOwnedFile(resolve(screenshotDirectory, 'preflight.png'), screenshotDirectory, { createParents: true });
    assertOwnedFile(reportPath, evidence, { createParents: true });
    assertOwnedFile(descriptorPath, dirname(descriptorPath), { createParents: true });
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
    origin = 'http://127.0.0.1:' + port;
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
      credentials: [], credentialFixtureFile: relative(root, envPath).split('\\').join('/'),
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
    writeOwnedJson(descriptorPath, dirname(descriptorPath), descriptor);
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
    writeOwnedJson(descriptorPath, dirname(descriptorPath), descriptor);
    stage = 'browser-launch';
    browser = await launchBrowser();
    stage = 'browser-configuration';
    const browserConfig = await browserConfiguration();
    report.browser = { actualVersion: browser.version(), playwrightVersion: browserConfig.playwrightVersion,
      provider: browserConfig.provider, browserProvider: browserConfig.browserProvider, executableSource: browserConfig.executableSource };
    stage = 'browser-context';
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
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
    report.loginAttempted = true;
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
    if (verifyNativeApi) {
      stage = 'native-api-acceptance';
      report.nativeApiVerification = await verifyNativeApiAfterUi({ options, exploration: report, config, bootstrap, origin });
      if (!report.nativeApiVerification.passed) fail('NATIVE_API_ACCEPTANCE_FAILED');
    }
    report.status = 'explored-development-ui-not-accepted';
  } catch (error) {
    report.failedStage = stage;
    report.errorCode = error instanceof ExplorationError ? error.code : 'APP_EXPLORATION_STEP_FAILED';
    if (stage === 'browser-launch') report.browserLaunchFailure = browserLaunchFailureReport(error);
  } finally {
    if (report.loginAttempted && context && origin) report.uiSessionCleanup = await revokeObservedUiSession(context, origin);
    if (browser) {
      try { await browser.close(); report.browserClosed = true; }
      catch { report.browserClosed = false; }
    }
    report.applicationCleanup = await stopApplication(child, exited);
    report.endedAtUtc = new Date().toISOString();
    if (descriptor) {
      try {
        assertOwnedFile(descriptorPath, dirname(descriptorPath));
        const current = JSON.parse(readFileSync(descriptorPath, 'utf8'));
        if (current.runId === report.runId) writeOwnedJson(descriptorPath, dirname(descriptorPath), { ...descriptor, status: 'stopped', stoppedAt: report.endedAtUtc });
      } catch { report.descriptorCleanupWarning = 'DESCRIPTOR_STOP_STATE_NOT_VERIFIED'; }
    }
    try { report.evidenceWritten = true; writeOwnedJson(reportPath, evidence, report); }
    catch { report.evidenceWritten = false; report.status = 'blocked'; report.reportWriteError = 'EXPLORATION_REPORT_WRITE_FAILED'; }
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await main();
  process.stdout.write(JSON.stringify({ status: report.status, errorCode: report.errorCode ?? null, failedStage: report.failedStage ?? null, loginPerformed: report.loginPerformed, screenshotCount: report.screenshots.length, report: report.evidenceWritten ? relative(root, reportPath) : null,
    nativeApiVerification: report.nativeApiVerification, phaseAccepted: false, productionAccepted: false, applicationStopped: report.applicationCleanup.stopped }, null, 2) + '\n');
  process.exitCode = explorationPassed(report) ? 0 : 2;
}
