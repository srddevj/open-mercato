import test from 'node:test';
import assert from 'node:assert/strict';
import { selectBrowserProvider, launchBrowserProvider, browserProviderMetadata } from './browser-provider.mjs';
import { browserLaunchFailureReport } from './browser-diagnostics.mjs';

test('provider choice defaults explicitly and rejects unsupported values without echoing them', async () => {
  assert.equal(selectBrowserProvider(undefined), 'sparticuz');
  for (const provider of ['sparticuz', 'playwright-managed']) assert.equal(selectBrowserProvider(provider), provider);
  let calls = 0;
  for (const selection of ['', 'secret-provider-DO-NOT-EXPORT', null, {}, true]) {
    assert.throws(() => selectBrowserProvider(selection), /^Error: QA_BROWSER_PROVIDER_UNSUPPORTED$/);
    await assert.rejects(launchBrowserProvider({ selection, browserType: { launch() { calls++; } } }),
      /^Error: QA_BROWSER_PROVIDER_UNSUPPORTED$/);
  }
  assert.equal(calls, 0);
});

test('managed provider uses the injected locked browser identity and no serverless overrides', async () => {
  const actualBrowser = { kind: 'controlled test only' };
  const options = [];
  const serverless = { executablePath() { throw new Error('serverless executable must not be selected'); } };
  const request = { selection: 'playwright-managed', serverless,
    browserType: { async launch(value) { options.push(value); return actualBrowser; } },
    get arguments() { throw new Error('serverless arguments must not be read'); },
  };
  assert.equal(await launchBrowserProvider(request), actualBrowser);
  assert.deepEqual(options, [{ headless: true, timeout: 30000 }]);
});

test('default serverless provider preserves its executable and a copied reviewed argument list', async () => {
  const actualBrowser = {};
  const args = ['--headless', '--synthetic-unit-fixture'];
  let received;
  const returned = await launchBrowserProvider({ browserType: { async launch(value) { received = value; return actualBrowser; } },
    serverless: { async executablePath() { return '/synthetic/unit-browser'; } }, arguments: args });
  assert.equal(returned, actualBrowser);
  assert.deepEqual(received, { args, executablePath: '/synthetic/unit-browser', headless: true, timeout: 30000 });
  received.args.push('changed-copy');
  assert.deepEqual(args, ['--headless', '--synthetic-unit-fixture']);
});

test('both provider branches convert launch failures into the same safe diagnostic contract', async () => {
  for (const selection of ['sparticuz', 'playwright-managed']) {
    let caught;
    await assert.rejects(launchBrowserProvider({ selection,
      browserType: { async launch() { throw new Error('synthetic-secret: error while loading shared libraries'); } },
      serverless: { async executablePath() { return '/synthetic/unit-browser'; } }, arguments: [],
    }), error => { caught = error; return true; });
    assert.deepEqual(browserLaunchFailureReport(caught), { code: 'BROWSER_SHARED_LIBRARY_UNAVAILABLE',
      category: 'missing-library', basis: 'launch-error-pattern', rawDetailsRetained: false });
    assert.equal(caught.message.includes('synthetic-secret'), false);
  }
});

test('provider metadata names executable provenance without exposing an executable path', () => {
  assert.deepEqual(browserProviderMetadata('playwright-managed'), { provider: 'playwright', browserProvider: 'playwright-managed',
    executableSource: 'locked-playwright-managed-cache' });
  assert.deepEqual(browserProviderMetadata(), { provider: 'playwright', browserProvider: 'sparticuz',
    executableSource: 'sparticuz-package-extraction' });
});
