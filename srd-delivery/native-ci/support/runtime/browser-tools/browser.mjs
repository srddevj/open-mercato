/** Local development browser, using the app's existing Playwright installation. */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import chromium from '@sparticuz/chromium';
import { launchBrowserProvider, browserProviderMetadata, selectBrowserProvider } from './browser-provider.mjs';
export { browserLaunchFailureReport } from './browser-diagnostics.mjs';

const requireFromApp = createRequire(fileURLToPath(new URL('../../srd-ai-ops/package.json', import.meta.url)));
const { chromium: playwright } = requireFromApp('playwright-core');

// Restore browser web-security defaults for real-app exploration. The package's
// serverless defaults relax these; they would invalidate CORS/isolation checks.
const excludedArguments = new Set([
  '--disable-web-security', '--allow-running-insecure-content',
  '--disable-site-isolation-trials', '--single-process', "--headless='shell'",
]);
export const productQaArguments = chromium.args.flatMap((argument) => {
  if (excludedArguments.has(argument)) return [];
  if (argument.startsWith('--disable-features=')) {
    const retained = argument.slice('--disable-features='.length).split(',')
      .filter((feature) => !['IsolateOrigins', 'site-per-process'].includes(feature));
    return retained.length ? ['--disable-features=' + retained.join(',')] : [];
  }
  if (argument.startsWith('--enable-features=')) {
    const retained = argument.slice('--enable-features='.length).split(',')
      .filter((feature) => feature !== 'SharedArrayBuffer');
    return retained.length ? ['--enable-features=' + retained.join(',')] : [];
  }
  return [argument];
});

export async function launchBrowser() {
  return launchBrowserProvider({ selection: process.env.SRD_QA_BROWSER_PROVIDER,
    browserType: playwright, serverless: chromium, arguments: productQaArguments });
}

export async function browserConfiguration() {
  const selection = selectBrowserProvider(process.env.SRD_QA_BROWSER_PROVIDER);
  return {
    ...browserProviderMetadata(selection),
    playwrightVersion: requireFromApp('playwright-core/package.json').version,
    chromiumPackageVersion: selection === 'sparticuz' ? '153.0.0' : null,
    argumentOverrides: selection === 'sparticuz' ? [...productQaArguments] : [],
    headless: true,
    constraints: {
      operatingSystemSandboxMode: selection === 'sparticuz' ? 'serverless-package-defaults' : 'playwright-defaults-unverified',
      customWebSecurityDisablingArgumentsSupplied: false,
      customSiteIsolationDisablingArgumentsSupplied: false,
      nativeBrowserSandboxSecurityAccepted: false,
      crossOriginBehaviorTested: false,
    },
  };
}
