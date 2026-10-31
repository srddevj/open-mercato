# Local browser capture runtime

Development-only support for the owned synthetic SRD DEV application. This directory does not change application dependencies, pages or business behavior.

The standard Playwright browser download failed because the CDN archive was invalid/truncated. This alternative uses the maintained npm package `@sparticuz/chromium` pinned to `153.0.0`, including its packaged Chromium binary. The app's already-installed `playwright-core` is reused through its own dependency resolution. Registry engine metadata allows Node `^22.17.0 || >=24.0.0`; the project runtime is Node 24.

Source and documented Playwright integration: https://github.com/Sparticuz/chromium#usage-with-playwright . Package integrity and transitive versions are retained in `package-lock.json` after installation.

Install and verify:

```sh
cd runtime/browser-tools
npm ci --ignore-scripts --no-audit --no-fund
node verify.mjs
```

`verify.mjs` exercises a simple inline HTML page, verifies its title, heading and keyboard focus, saves `artifacts/browser-smoke.png`, and closes the browser in `finally`. `verification-result.json` records the observed browser version, launch configuration and outcome. That image is only a browser-runtime test and must never be delivered as the application's UI or a business-feature acceptance screenshot.

Real-app QA can import the shared launch helper:

```js
import { launchBrowser } from './runtime/browser-tools/browser.mjs';

const browser = await launchBrowser();
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  // Read the real base URL from the current shared test-environment descriptor.
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  // Explore and assert actual visible controls before screenshotting a real result.
  await page.screenshot({ path: screenshotPath, fullPage: true });
} finally {
  await browser.close();
}
```

For the default provider, the executable is decompressed into the package's temporary path at launch. `browserConfiguration()` reports fixed provider/executable provenance and the explicit argument overrides; it no longer exports the machine's executable path. The helper adapts the official Playwright example using the packaged executable and `headless: true`. For actual-app QA it removes the package defaults that disable web security, allow insecure content, disable site isolation, force single-process rendering, or explicitly enable SharedArrayBuffer. It also removes the redundant package headless argument so Playwright owns headless launch.

The root container still requires no-sandbox/disable-setuid-sandbox arguments. No native browser-sandbox security claim is supported. Removing disabling flags restores defaults; it does not independently prove cross-origin isolation or CORS behavior, which needs its own tests.

This browser version may differ from Playwright's bundled preferred version. A successful inline test proves basic browser/capture availability only; real-app interactions, layout, accessibility and every affected user journey must still be verified. No product functionality or production readiness follows from this runtime check.

## Observed verification

The installed package is exactly `153.0.0`, with registry integrity recorded in the lockfile. Two consecutive warm verification runs passed using actual Chromium `153.0.8010.0` with existing Playwright `1.64.1`; the inline screenshot was visually inspected and the browser closed successfully. The initial cold attempt returned a generic launch error; an immediate launch diagnostic and both repeated runs succeeded. Cold-start reliability is therefore not certified by these results. Consumers should retain real launch failures and diagnose them rather than assume that the warm check proves every host configuration.

For this managed executor, start the application and browser under the same orchestrating process tree. Separate command invocations can have isolated network/PID namespaces despite sharing files, so a server started by another invocation may be unreachable from the browser.

## Explicit provider and launch preflight

`SRD_QA_BROWSER_PROVIDER` selects the engineering browser runtime only. It does not select a database engine or enable any product/provider functionality.

| Value | Executable selection | Launch overrides |
| --- | --- | --- |
| Omitted or `sparticuz` | Existing pinned `@sparticuz/chromium` package | Reviewed serverless argument list, extracted executable, headless, 30-second launch timeout |
| `playwright-managed` | Browser previously installed by the app's locked Playwright version | Headless and 30-second launch timeout only; no serverless executable/arguments |

Unknown values fail before any browser launch and are never echoed into reports. The managed browser and its OS dependencies must already be installed through the reviewed host setup. This helper downloads no browser or package, upgrades no dependency and provisions no service.

Run a small launch/version/close check before database/bootstrap/build work:

```sh
SRD_QA_BROWSER_PROVIDER=playwright-managed node runtime/browser-tools/preflight.mjs
```

The CLI exits 0 only for an actual successful launch with a bounded numeric browser version and successful close; it exits 2 when blocked. Reports contain fixed provider/executable provenance, readiness/cleanup and safe failure fields, never raw stderr, credentials, environment, argv or executable paths. Injected unit fixtures are labelled `controlled-browser-preflight-unit-fixture` and cannot supply actual runtime evidence. Every report retains `productionAccepted: false`. Native callers must require the actual-runtime kind, the intended provider, `status: ready` and `browserClosed: true`.

Shared launch errors are wrapped without a raw cause. `browserLaunchFailureReport(error)` emits only fixed categories/codes for shared-library, executable, permission, sandbox, timeout or other signatures. `basis: launch-error-pattern` means the error text matched that category; it is not independent proof of the missing package or underlying host cause. Unrecognized or forged errors contribute only the fixed unknown category. Actual-app runners distinguish launch, configuration and subsequent UI stages, preserving empty case/screenshot lists when launch fails.

The approved native test on 31 October initialized PostgreSQL and built the app but stopped before the first browser case. Its generic historical report does not reveal the exact Chromium launch cause. The new diagnostics/provider/preflight have controlled unit coverage; a managed-browser Ubuntu recovery is still unverified and needs a separately authorized execution. Earlier warm local serverless results remain limited to that local environment.

Focused offline tests:

```sh
node --test runtime/browser-tools/browser-diagnostics.test.mjs runtime/browser-tools/browser-provider.test.mjs runtime/browser-tools/preflight.test.mjs
```
