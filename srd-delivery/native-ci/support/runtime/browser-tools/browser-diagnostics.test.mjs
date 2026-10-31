import test from 'node:test';
import assert from 'node:assert/strict';
import { withBrowserLaunchDiagnostics, browserLaunchFailureReport } from './browser-diagnostics.mjs';

async function failure(error) {
  let caught;
  await assert.rejects(withBrowserLaunchDiagnostics(async () => { throw error; }), (value) => {
    caught = value;
    return true;
  });
  return caught;
}

test('successful launch returns the actual browser without replacing it', async () => {
  const actualBrowser = { version: () => 'synthetic unit fixture only' };
  assert.equal(await withBrowserLaunchDiagnostics(async () => actualBrowser), actualBrowser);
});

test('launch signatures produce fixed categories without claiming a verified OS cause', async (context) => {
  const cases = [
    [new Error('/private/browser: error while loading shared libraries: arbitrary-secret.so: cannot open shared object file'), 'missing-library', 'BROWSER_SHARED_LIBRARY_UNAVAILABLE'],
    [Object.assign(new Error('spawn /private/secret-browser ENOENT'), { code: 'ENOENT' }), 'executable', 'BROWSER_EXECUTABLE_UNAVAILABLE'],
    [Object.assign(new Error('/private/path: permission denied'), { code: 'EACCES' }), 'permission', 'BROWSER_EXECUTION_PERMISSION_DENIED'],
    [new Error('No usable sandbox! arbitrary-secret-argv'), 'sandbox', 'BROWSER_SANDBOX_LAUNCH_BLOCKED'],
    [Object.assign(new Error('arbitrary-secret timeout context'), { name: 'TimeoutError' }), 'timeout', 'BROWSER_LAUNCH_TIMED_OUT'],
    [new Error('unrecognized error with arbitrary-secret'), 'other', 'BROWSER_LAUNCH_FAILED'],
  ];
  for (const [error, category, code] of cases) await context.test(category, async () => {
    const value = browserLaunchFailureReport(await failure(error));
    assert.deepEqual(value, { code, category, basis: 'launch-error-pattern', rawDetailsRetained: false });
    assert.equal(JSON.stringify(value).includes('arbitrary-secret'), false);
  });
});

test('wrapped errors do not retain raw error messages, causes, output or credentials', async () => {
  const secret = 'synthetic-password-DO-NOT-EXPORT';
  const original = Object.assign(new Error('/private/' + secret + ': error while loading shared libraries: ' + secret), {
    name: secret, code: secret, stdout: secret, stderr: secret, env: { PASSWORD: secret },
    cause: new Error(secret), diagnostic: { code: secret },
  });
  const wrapped = await failure(original);
  assert.equal(wrapped.message, 'BROWSER_SHARED_LIBRARY_UNAVAILABLE');
  assert.equal(wrapped.name, 'BrowserLaunchError');
  assert.equal(Object.hasOwn(wrapped, 'cause'), false);
  assert.equal(JSON.stringify(wrapped).includes(secret), false);
  assert.equal(JSON.stringify(browserLaunchFailureReport(wrapped)).includes(secret), false);
  wrapped.code = secret; wrapped.diagnostic = original; wrapped.message = secret;
  assert.equal(JSON.stringify(browserLaunchFailureReport(wrapped)).includes(secret), false);
});

test('foreign or forged error diagnostics contribute only the fixed unknown result', () => {
  const secret = 'synthetic-cookie-DO-NOT-EXPORT';
  for (const value of [undefined, null, secret, new Error(secret), { name: 'BrowserLaunchError', code: secret, diagnostic: { category: secret } }]) {
    assert.deepEqual(browserLaunchFailureReport(value), { code: 'BROWSER_LAUNCH_FAILED', category: 'other',
      basis: 'launch-error-pattern', rawDetailsRetained: false });
  }
});

test('classification bounds message reads and handles hostile property getters', async () => {
  const beyondLimit = new Error('x'.repeat(12000) + ' error while loading shared libraries');
  assert.equal(browserLaunchFailureReport(await failure(beyondLimit)).category, 'other');
  const hostile = Object.defineProperties({}, Object.fromEntries(['name', 'message', 'code'].map((key) => [key, {
    get() { throw new Error('synthetic-secret-getter'); },
  }])));
  assert.equal(browserLaunchFailureReport(await failure(hostile)).category, 'other');
  const hostileProxy = new Proxy({}, { get() { throw new Error('synthetic-secret-proxy'); } });
  assert.equal(browserLaunchFailureReport(await failure(hostileProxy)).category, 'other');
});

test('specific shared-library and sandbox signatures take priority over generic codes', async () => {
  const library = Object.assign(new Error('error while loading shared libraries'), { code: 'ENOENT' });
  const sandbox = Object.assign(new Error('No usable sandbox; operation not permitted'), { code: 'EPERM' });
  assert.equal(browserLaunchFailureReport(await failure(library)).category, 'missing-library');
  assert.equal(browserLaunchFailureReport(await failure(sandbox)).category, 'sandbox');
});
