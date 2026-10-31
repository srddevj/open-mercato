/** Fixed launch-error signatures only; never serialize the underlying error. */
const classified = new WeakMap();
const unknown = Object.freeze({ code: 'BROWSER_LAUNCH_FAILED', category: 'other',
  basis: 'launch-error-pattern', rawDetailsRetained: false });

function stringProperty(value, key) {
  try {
    const current = value?.[key];
    return typeof current === 'string' ? current.slice(0, 12000) : '';
  } catch { return ''; }
}

function classify(error) {
  const message = stringProperty(error, 'message');
  const code = stringProperty(error, 'code');
  const name = stringProperty(error, 'name');
  let category = 'other';
  let diagnosticCode = 'BROWSER_LAUNCH_FAILED';
  if (/error while loading shared libraries|error loading shared librar|cannot open shared object file|host system is missing dependencies/i.test(message)) {
    category = 'missing-library'; diagnosticCode = 'BROWSER_SHARED_LIBRARY_UNAVAILABLE';
  } else if (/no usable sandbox|running as root without --no-sandbox|failed to (?:move to new|create).*namespace|suid sandbox|setuid sandbox|zygote_host_impl.*sandbox/i.test(message)) {
    category = 'sandbox'; diagnosticCode = 'BROWSER_SANDBOX_LAUNCH_BLOCKED';
  } else if (['EACCES', 'EPERM'].includes(code) || /permission denied|operation not permitted/i.test(message)) {
    category = 'permission'; diagnosticCode = 'BROWSER_EXECUTION_PERMISSION_DENIED';
  } else if (code === 'ENOENT' || /executable doesn.t exist|executable (?:was )?not found|failed to launch.*enoent/i.test(message)) {
    category = 'executable'; diagnosticCode = 'BROWSER_EXECUTABLE_UNAVAILABLE';
  } else if (name === 'TimeoutError' || ['ETIMEDOUT', 'ERR_TIMEOUT'].includes(code) || /timeout \d+\s?ms exceeded|browser.*launch.*timed out/i.test(message)) {
    category = 'timeout'; diagnosticCode = 'BROWSER_LAUNCH_TIMED_OUT';
  }
  return Object.freeze({ code: diagnosticCode, category,
    basis: 'launch-error-pattern', rawDetailsRetained: false });
}

class BrowserLaunchError extends Error {
  constructor(error) {
    const diagnostic = classify(error);
    super(diagnostic.code);
    this.name = 'BrowserLaunchError';
    // Keep no raw cause, stderr, path, command, environment, or source error.
    classified.set(this, diagnostic);
  }
}

export async function withBrowserLaunchDiagnostics(operation) {
  try { return await operation(); }
  catch (error) { throw new BrowserLaunchError(error); }
}

/** Only this module's branded wrapper can contribute a diagnostic to a report. */
export function browserLaunchFailureReport(error) {
  const value = (typeof error === 'object' && error !== null) || typeof error === 'function'
    ? classified.get(error) : undefined;
  return { ...(value ?? unknown) };
}
