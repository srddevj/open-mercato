#!/usr/bin/env node
/** Browser runtime readiness only; never app, UI journey or production acceptance. */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, browserConfiguration, browserLaunchFailureReport } from './browser.mjs';

const executableSources = {
  'sparticuz': 'sparticuz-package-extraction',
  'playwright-managed': 'locked-playwright-managed-cache',
};

export async function runBrowserPreflight({ launch = launchBrowser, configuration = browserConfiguration } = {}) {
  const result = {
    kind: launch === launchBrowser && configuration === browserConfiguration
      ? 'actual-browser-runtime-preflight' : 'controlled-browser-preflight-unit-fixture',
    status: 'blocked', browserProvider: null, browserVersion: null, browserClosed: false,
    productionAccepted: false,
  };
  let browser;
  let stage = 'configuration';
  try {
    const config = await configuration();
    const provider = config?.browserProvider;
    const source = config?.executableSource;
    if (typeof provider !== 'string' || !Object.hasOwn(executableSources, provider) ||
        source !== executableSources[provider]) {
      result.failedStage = 'configuration';
      result.errorCode = 'BROWSER_PREFLIGHT_CONFIGURATION_INVALID';
      return result;
    }
    result.browserProvider = provider;
    result.executableSource = source;
    stage = 'launch';
    browser = await launch();
    stage = 'version';
    const version = browser.version();
    if (typeof version !== 'string' || !/^\d{1,4}(?:\.\d{1,8}){1,3}$/.test(version)) {
      result.failedStage = 'version';
      result.errorCode = 'BROWSER_PREFLIGHT_VERSION_INVALID';
      return result;
    }
    result.browserVersion = version;
    result.status = 'ready';
  } catch (error) {
    result.failedStage = stage;
    result.errorCode = stage === 'launch' ? 'BROWSER_PREFLIGHT_LAUNCH_FAILED' : 'BROWSER_PREFLIGHT_STEP_FAILED';
    if (stage === 'launch') result.browserLaunchFailure = browserLaunchFailureReport(error);
  } finally {
    if (browser) {
      try { await browser.close(); result.browserClosed = true; }
      catch {
        result.status = 'blocked'; result.failedStage = 'close'; result.errorCode = 'BROWSER_PREFLIGHT_CLOSE_FAILED';
      }
    }
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runBrowserPreflight();
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exitCode = result.kind === 'actual-browser-runtime-preflight' && result.status === 'ready' && result.browserClosed ? 0 : 2;
}
