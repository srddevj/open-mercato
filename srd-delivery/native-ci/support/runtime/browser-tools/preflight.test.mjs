import test from 'node:test';
import assert from 'node:assert/strict';
import { runBrowserPreflight } from './preflight.mjs';
import { withBrowserLaunchDiagnostics } from './browser-diagnostics.mjs';

const configuration = async () => ({ browserProvider: 'playwright-managed', executableSource: 'locked-playwright-managed-cache' });

test('controlled ready probe observes numeric version and closes without claiming actual runtime evidence', async () => {
  let closed = 0;
  const result = await runBrowserPreflight({ configuration,
    launch: async () => ({ version: () => '153.0.7876.0', async close() { closed++; } }),
  });
  assert.deepEqual(result, { kind: 'controlled-browser-preflight-unit-fixture', status: 'ready',
    browserProvider: 'playwright-managed', executableSource: 'locked-playwright-managed-cache',
    browserVersion: '153.0.7876.0', browserClosed: true, productionAccepted: false });
  assert.equal(closed, 1);
});

test('preflight preserves only safe fixed launch diagnostic and cannot report ready after launch failure', async () => {
  const result = await runBrowserPreflight({ configuration, launch: () => withBrowserLaunchDiagnostics(async () => {
    throw new Error('/private/synthetic-secret: error while loading shared libraries');
  }) });
  assert.equal(result.status, 'blocked');
  assert.equal(result.failedStage, 'launch');
  assert.equal(result.browserClosed, false);
  assert.equal(result.browserLaunchFailure.category, 'missing-library');
  assert.equal(JSON.stringify(result).includes('synthetic-secret'), false);
});

test('preflight rejects unknown configuration before launching and never echoes it', async () => {
  let launched = 0;
  const result = await runBrowserPreflight({ configuration: async () => ({ browserProvider: 'synthetic-secret', executableSource: 'synthetic-secret' }),
    launch: async () => { launched++; },
  });
  assert.equal(launched, 0);
  assert.equal(result.status, 'blocked');
  assert.equal(result.errorCode, 'BROWSER_PREFLIGHT_CONFIGURATION_INVALID');
  assert.equal(JSON.stringify(result).includes('synthetic-secret'), false);
});

test('unexpected version and close failures retain no raw errors and cannot report ready', async () => {
  let closed = 0;
  const invalid = await runBrowserPreflight({ configuration,
    launch: async () => ({ version: () => 'synthetic-secret-in-version', async close() { closed++; } }),
  });
  assert.equal(closed, 1);
  assert.equal(invalid.errorCode, 'BROWSER_PREFLIGHT_VERSION_INVALID');
  assert.equal(invalid.status, 'blocked');
  assert.equal(invalid.browserClosed, true);
  assert.equal(JSON.stringify(invalid).includes('synthetic-secret'), false);
  const failedClose = await runBrowserPreflight({ configuration,
    launch: async () => ({ version: () => '153.0.7876.0', async close() { throw new Error('synthetic-secret-close-error'); } }),
  });
  assert.equal(failedClose.status, 'blocked');
  assert.equal(failedClose.errorCode, 'BROWSER_PREFLIGHT_CLOSE_FAILED');
  assert.equal(failedClose.browserClosed, false);
  assert.equal(JSON.stringify(failedClose).includes('synthetic-secret'), false);
});

test('configuration getter failure is a fixed error without launch or sensitive serialization', async () => {
  const result = await runBrowserPreflight({ configuration: async () => Object.defineProperty({}, 'browserProvider', {
    get() { throw new Error('synthetic-secret-config-error'); },
  }), launch: async () => assert.fail('must not launch') });
  assert.equal(result.status, 'blocked');
  assert.equal(result.errorCode, 'BROWSER_PREFLIGHT_STEP_FAILED');
  assert.equal(result.failedStage, 'configuration');
  assert.equal(JSON.stringify(result).includes('synthetic-secret'), false);
});

test('configuration properties are snapshotted once before allowed metadata is reported', async () => {
  let reads = 0;
  const result = await runBrowserPreflight({ configuration: async () => ({
    get browserProvider() { return ++reads === 1 ? 'playwright-managed' : 'synthetic-secret-later-value'; },
    executableSource: 'locked-playwright-managed-cache',
  }), launch: async () => ({ version: () => '153.0.7876.0', async close() {} }) });
  assert.equal(reads, 1);
  assert.equal(result.status, 'ready');
  assert.equal(result.browserProvider, 'playwright-managed');
  assert.equal(JSON.stringify(result).includes('synthetic-secret'), false);
});
