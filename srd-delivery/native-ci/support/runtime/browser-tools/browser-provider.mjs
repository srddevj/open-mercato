import { withBrowserLaunchDiagnostics } from './browser-diagnostics.mjs';

/** Explicit development-only selection; an unknown value never launches a browser. */
export function selectBrowserProvider(value) {
  if (value === undefined) return 'sparticuz';
  if (value === 'sparticuz' || value === 'playwright-managed') return value;
  throw new Error('QA_BROWSER_PROVIDER_UNSUPPORTED');
}

/** Injected dependencies support unit checks; they cannot establish runtime acceptance. */
export async function launchBrowserProvider(request) {
  const provider = selectBrowserProvider(request.selection);
  return withBrowserLaunchDiagnostics(async () => {
    if (provider === 'playwright-managed') {
      // Use the executable installed by the existing locked Playwright version.
      // No serverless executable path or argument overrides reach this branch.
      return request.browserType.launch({ headless: true, timeout: 30000 });
    }
    return request.browserType.launch({
      args: [...request.arguments], executablePath: await request.serverless.executablePath(),
      headless: true, timeout: 30000,
    });
  });
}

export function browserProviderMetadata(selection) {
  const browserProvider = selectBrowserProvider(selection);
  return {
    provider: 'playwright', browserProvider,
    executableSource: browserProvider === 'playwright-managed' ? 'locked-playwright-managed-cache' : 'sparticuz-package-extraction',
  };
}
