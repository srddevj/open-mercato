#!/usr/bin/env node
/** Isolated synthetic bootstrap using reviewed public native CLI commands only. */
import { readFileSync, lstatSync, writeFileSync, mkdirSync, readdirSync, existsSync, realpathSync } from 'node:fs';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { parseEnv } from 'node:util';
import { randomUUID } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const app = resolve(root, 'srd-ai-ops');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const required = [
  'SRD_FOUNDATION_RUNTIME', 'DATABASE_URL', 'JWT_SECRET', 'TENANT_DATA_ENCRYPTION_FALLBACK_KEY',
  'SRD_F1_EMAIL_A', 'SRD_F1_PASSWORD_A', 'SRD_F1_EMAIL_B', 'SRD_F1_PASSWORD_B',
  'SRD_F1_BOOTSTRAP_PASSWORD_A', 'SRD_F1_BOOTSTRAP_PASSWORD_B',
];
const optional = [
  'REDIS_URL', 'QUEUE_REDIS_URL', 'CACHE_REDIS_URL', 'APP_URL', 'NEXT_PUBLIC_APP_URL',
  'DB_POOL_MIN', 'DB_POOL_MAX', 'CACHE_STRATEGY', 'QUEUE_STRATEGY', 'PGSSLMODE',
];
const safeRuntime = Object.freeze({
  TENANT_DATA_ENCRYPTION: 'yes', QUEUE_STRATEGY: 'local', CACHE_STRATEGY: 'memory',
  RATE_LIMIT_STRATEGY: 'memory', DB_POOL_MIN: '1', DB_POOL_MAX: '1',
  OM_DEV_WITH_MCP: '0', OM_ENABLE_ENTERPRISE_MODULES: 'false',
  NEXT_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1',
  TELEMETRY_BACKEND: 'noop',
  SEARCH_FULLTEXT_ENABLED: 'false', SEARCH_VECTOR_ENABLED: 'false', OM_SEARCH_ENABLED: 'false',
});
const allowed = new Set([...required, ...optional, ...Object.keys(safeRuntime)]);
class FoundationError extends Error {
  constructor(code, diagnostic) { super(code); this.code = code; this.diagnostic = diagnostic; }
}
const fail = (code) => { throw new FoundationError(code); };

export function validateEnvironment(env) {
  for (const name of required) if (typeof env[name] !== 'string' || !env[name].trim()) fail('REQUIRED_CONFIGURATION_MISSING');
  if (Object.keys(env).some((name) => !allowed.has(name))) fail('UNEXPECTED_CONFIGURATION_KEY');
  for (const [name, value] of Object.entries(safeRuntime)) {
    if (env[name] !== undefined && env[name] !== value) fail('UNSAFE_RUNTIME_CONFIGURATION');
  }
  if (env.SRD_FOUNDATION_RUNTIME !== 'isolated-synthetic') fail('ISOLATED_RUNTIME_MARKER_REQUIRED');
  let target;
  try { target = new URL(env.DATABASE_URL); } catch { fail('INVALID_DATABASE_TARGET'); }
  if (!['postgres:', 'postgresql:'].includes(target.protocol) ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) ||
      target.pathname !== '/srd_ops_f1' || target.search || target.hash) fail('LOOPBACK_SYNTHETIC_DATABASE_REQUIRED');
  if (env.JWT_SECRET.length < 32 || env.TENANT_DATA_ENCRYPTION_FALLBACK_KEY.length < 32) fail('APPLICATION_SECRETS_TOO_SHORT');
  const passwordKeys = ['SRD_F1_PASSWORD_A', 'SRD_F1_PASSWORD_B', 'SRD_F1_BOOTSTRAP_PASSWORD_A', 'SRD_F1_BOOTSTRAP_PASSWORD_B'];
  const passwords = passwordKeys.map((key) => env[key]);
  if (passwords.some((value) => value.length < 16) || new Set(passwords).size !== passwords.length) fail('DISTINCT_STRONG_PASSWORDS_REQUIRED');
  const emails = [env.SRD_F1_EMAIL_A, env.SRD_F1_EMAIL_B];
  if (emails.some((value) => !/^[A-Za-z0-9.!#$%&'*+/=?^_{}|~-]+@(?:[A-Za-z0-9-]+\.)+(?:test|invalid)$/.test(value)) ||
      new Set(emails.map((value) => value.toLowerCase())).size !== 2 ||
      emails.some((value) => /^bootstrap-[ab]@srd-foundation\.invalid$/i.test(value))) fail('DISTINCT_SYNTHETIC_EMAILS_REQUIRED');
  return { ...env };
}

export function buildSetupArgs(config, suffix) {
  const lower = suffix.toLowerCase();
  return [
    'auth', 'setup', '--orgName', 'SRD DEV Synthetic Business ' + suffix,
    '--orgSlug', 'srd-foundation-' + lower, '--email', 'bootstrap-' + lower + '@srd-foundation.invalid',
    '--password', config['SRD_F1_BOOTSTRAP_PASSWORD_' + suffix],
    '--roles', 'superadmin,admin,employee', '--json',
  ];
}

export function buildAdminArgs(config, suffix, organizationId) {
  if (!UUID.test(organizationId ?? '')) fail('INVALID_ORGANIZATION_RESULT');
  return [
    'auth', 'add-user', '--email', config['SRD_F1_EMAIL_' + suffix],
    '--password', config['SRD_F1_PASSWORD_' + suffix], '--organizationId', organizationId,
    '--roles', 'admin',
  ];
}

export function safeFailure(error) {
  return error instanceof FoundationError ? error.code : 'NATIVE_BOOTSTRAP_STEP_FAILED';
}

export function nativeDiagnostic(error, captured = '', secrets = []) {
  const raw = [error?.message ?? '', captured].join('\n');
  const categories = [
    ['connection-lifecycle', /ECONNREFUSED|ECONNRESET|connection.*(?:closed|terminated|limit|timeout)|max.?connections|too many clients|timeout.*connect/i],
    ['module-resolution', /Cannot find (?:module|package)|Module not found|ERR_MODULE_NOT_FOUND|Unknown file extension|ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING/i],
    ['sql-feature', /syntax error|not implemented|not supported|CONCURRENTLY.*transaction/i],
    ['missing-relation', /relation .*does not exist|undefined table/i],
    ['permission', /permission denied|EACCES|EPERM/i],
  ];
  const category = categories.find(([, pattern]) => pattern.test(raw))?.[0] ?? 'unclassified-native-failure';
  const nodeCodes = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ERR_MODULE_NOT_FOUND', 'ERR_UNKNOWN_FILE_EXTENSION', 'ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING']);
  const rawCode = typeof error?.code === 'string' ? error.code : '';
  const code = /^(?:[0-9]{2}[A-Z0-9]{3})$/.test(rawCode) || nodeCodes.has(rawCode) ? rawCode : null;
  const extracted = raw.split('\n').filter((line) => /(?:Failed:|Error:|error:)/.test(line)).slice(-1)[0];
  let message = String(error?.message ?? extracted ?? '').replace(/\x1b\[[0-9;]*m/g, '');
  for (const secret of [...secrets].filter((value) => typeof value === 'string' && value.length >= 4).sort((a, b) => b.length - a.length)) message = message.split(secret).join('[redacted]');
  message = message.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s)]+/gi, '[url]')
    .replace(/\b(?:authorization|password|token|secret|api[_ -]?key)\s*[:=][^\n]*/gi, '[sensitive field omitted]')
    .replace(/\b(?:parameters|params|bindings)\s*[:=][\s\S]*/gi, '[query parameters omitted]')
    .replace(/\b(?:select|insert|update|delete|alter|create|drop)\b[\s\S]*/gi, '[SQL omitted]')
    .replace(/[\r\n\t]+/g, ' ').slice(0, 600);
  const name = ['Error', 'TypeError', 'SyntaxError', 'RangeError', 'AggregateError'].includes(error?.name) ? error.name : null;
  return { category, code, name, message: message || 'Native command failed; raw output omitted.' };
}

export function validateResumeReport(value) {
  if (value?.kind !== 'isolated-synthetic-native-bootstrap' || value?.status !== 'blocked' ||
      value?.mode !== 'apply' || value?.failedStage !== 'native-db-migrate' ||
      !Array.isArray(value.tenants) || value.tenants.length ||
      !value.steps?.some((step) => step.step === 'database-precheck' && step.status === 'passed')) fail('TRUSTED_MIGRATION_FAILURE_REPORT_REQUIRED');
}

function knownMigrationTables() {
  const source = readFileSync(resolve(app, 'src/modules.ts'), 'utf8').split('const enterpriseModulesEnabled')[0];
  const tables = new Set();
  for (const match of source.matchAll(/\{ id: '([a-z][a-z0-9_]*)', from: '(@open-mercato\/[a-z][a-z0-9-]*)' \}/g)) {
    const [, moduleId, packageName] = match;
    const directory = resolve(app, 'node_modules', packageName, 'src/modules', moduleId, 'migrations');
    if (!existsSync(directory)) continue;
    tables.add('mikro_orm_migrations_' + moduleId);
    for (const name of readdirSync(directory).filter((name) => /^Migration.*\.ts$/.test(name))) {
      const migration = readFileSync(resolve(directory, name), 'utf8');
      for (const table of migration.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?["\\]+([a-z][a-z0-9_]*)/gi)) tables.add(table[1]);
    }
  }
  return tables;
}

/** Mirrors bin.ts full bootstrap through the public loader, including generated aliases/DI. */
export async function prepareNativeApplication(bootstrapFromAppRoot, registerCliModules, appDir = app) {
  const data = await bootstrapFromAppRoot(appDir);
  if (!data || !Array.isArray(data.modules) || data.modules.length === 0) fail('NATIVE_MODULE_REGISTRY_MISSING');
  registerCliModules(data.modules);
}

export function waitForDevelopmentDatabaseIdle(channel = process, timeoutMs = 10000) {
  if (typeof channel.send !== 'function' || channel.connected !== true) return Promise.reject(new FoundationError('DEVELOPMENT_DB_IDLE_IPC_REQUIRED'));
  const id = randomUUID();
  return new Promise((done, reject) => {
    let timer;
    const finish = (error) => {
      clearTimeout(timer);
      channel.removeListener('message', onMessage);
      channel.removeListener('disconnect', onDisconnect);
      if (error) reject(error); else done();
    };
    const onMessage = (message) => {
      if (message?.type !== 'srd-dev-db-idle-result' || message.id !== id) return;
      if (message.ok === true) finish();
      else finish(new FoundationError('DEVELOPMENT_DB_IDLE_NOT_CONFIRMED'));
    };
    const onDisconnect = () => finish(new FoundationError('DEVELOPMENT_DB_IDLE_IPC_DISCONNECTED'));
    channel.on('message', onMessage);
    channel.once('disconnect', onDisconnect);
    timer = setTimeout(() => finish(new FoundationError('DEVELOPMENT_DB_IDLE_TIMEOUT')), timeoutMs);
    try {
      channel.send({ type: 'srd-dev-db-idle-request', id }, (error) => {
        if (error) finish(new FoundationError('DEVELOPMENT_DB_IDLE_IPC_FAILED'));
      });
    } catch { finish(new FoundationError('DEVELOPMENT_DB_IDLE_IPC_FAILED')); }
  });
}

/** Public native migration runner with a fresh narrowed resolver; development transport only. */
export async function runDevelopmentModuleMigrations({ createResolver, dbMigrate, waitForIdle, onModule = () => {}, appDir = app }) {
  if (typeof waitForIdle !== 'function') fail('DEVELOPMENT_DB_IDLE_IPC_REQUIRED');
  const entries = createResolver(appDir).loadEnabledModules().slice().sort((a, b) => a.id.localeCompare(b.id));
  if (!entries.length || new Set(entries.map((entry) => entry.id)).size !== entries.length ||
      entries.some((entry) => !/^[a-z][a-z0-9_]*$/.test(entry.id) ||
        (entry.from !== undefined && entry.from !== '@app' && !/^@open-mercato\/[a-z][a-z0-9-]*$/.test(entry.from)))) fail('INVALID_NATIVE_MODULE_LIST');
  await waitForIdle();
  const identity = (items) => items.map((entry) => entry.id + ':' + (entry.from ?? '')).sort().join('|');
  const expectedIdentity = identity(entries);
  for (const entry of entries) {
    const nativeResolver = createResolver(appDir);
    const current = nativeResolver.loadEnabledModules();
    if (identity(current) !== expectedIdentity) fail('NATIVE_MODULE_LIST_CHANGED');
    const reducedResolver = { ...nativeResolver, loadEnabledModules: () => [{ ...entry }] };
    await dbMigrate(reducedResolver, { quiet: true });
    await waitForIdle();
    onModule(entry.id);
  }
}

/** Raw native diagnostics stay in memory and are never written to evidence or tool output. */
export async function captureNative(run, args, { secrets = [] } = {}) {
  let stdout = '';
  let stderr = '';
  let truncated = false;
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  const previousExitCode = process.exitCode;
  const append = (chunk, encoding, callback) => {
    const next = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    if (stdout.length + next.length <= 2_000_000) stdout += next;
    else truncated = true;
    const done = typeof encoding === 'function' ? encoding : callback;
    if (typeof done === 'function') done();
    return true;
  };
  process.stdout.write = append;
  process.stderr.write = (chunk, encoding, callback) => {
    if (stderr.length < 2_000_000) stderr += String(chunk).slice(0, 2_000_000 - stderr.length);
    const done = typeof encoding === 'function' ? encoding : callback;
    if (typeof done === 'function') done();
    return true;
  };
  process.exitCode = undefined;
  try {
    const code = await run([process.execPath, 'mercato', ...args]);
    if ((typeof code === 'number' && code !== 0) || (process.exitCode && process.exitCode !== 0) || truncated) throw new FoundationError('NATIVE_BOOTSTRAP_STEP_FAILED', nativeDiagnostic(null, stdout + '\n' + stderr, secrets));
    return stdout;
  } catch (error) {
    if (error instanceof FoundationError && error.diagnostic) throw error;
    throw new FoundationError('NATIVE_BOOTSTRAP_STEP_FAILED', nativeDiagnostic(error, stdout + '\n' + stderr, secrets));
  }
  finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
    process.exitCode = previousExitCode;
  }
}

function parseSetupOutput(output) {
  for (const line of output.split('\n').reverse()) {
    try {
      const value = JSON.parse(line);
      if (value.reusedExistingUser === false && UUID.test(value.tenantId) && UUID.test(value.organizationId) && UUID.test(value.adminUserId)) {
        return { tenantId: value.tenantId, organizationId: value.organizationId, ownerUserId: value.adminUserId };
      }
    } catch { /* Never echo untrusted native output. */ }
  }
  fail('INVALID_NATIVE_SETUP_RESULT');
}

export async function precheckDatabase(config, requireFromApp, resume = false, tableAllowlist = knownMigrationTables) {
  const { Client } = requireFromApp('pg');
  const client = new Client({ connectionString: config.DATABASE_URL, connectionTimeoutMillis: 6000 });
  try {
    await client.connect();
    const identity = await client.query('SELECT current_database() AS name');
    if (identity.rows[0]?.name !== 'srd_ops_f1') fail('DATABASE_IDENTITY_MISMATCH');
    const extensions = await client.query("SELECT extname FROM pg_extension WHERE extname IN ('vector','pgcrypto')");
    if (!['vector', 'pgcrypto'].every((name) => extensions.rows.some((row) => row.extname === name))) fail('REQUIRED_DATABASE_EXTENSIONS_MISSING');
    const tables = await client.query("SELECT table_name AS name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'");
    if (!resume && tables.rows.length) fail('EXISTING_TABLES_REQUIRE_REVIEW_NO_RESET');
    if (resume) {
      const allowedTables = tableAllowlist();
      if (!tables.rows.length) fail('NO_PARTIAL_MIGRATIONS_TO_RESUME');
      for (const { name } of tables.rows) {
        if (!allowedTables.has(name) || !/^[a-z][a-z0-9_]*$/.test(name)) fail('UNKNOWN_TABLE_RESUME_DENIED');
        if (!name.startsWith('mikro_orm_migrations_')) {
          const rows = await client.query('SELECT COUNT(*)::int AS count FROM "' + name + '"');
          if (rows.rows[0]?.count !== 0) fail('BUSINESS_ROWS_RESUME_DENIED');
        }
      }
    }
  } finally { await client.end().catch(() => {}); }
}

export async function main(argv = process.argv.slice(2)) {
  const report = {
    schemaVersion: 1, kind: 'isolated-synthetic-native-bootstrap',
    mode: argv.includes('--apply') ? 'apply' : 'plan', status: 'blocked',
    productionAccepted: false, tenantIsolationAccepted: false,
    rawNativeOutputRetained: false, credentialsIncluded: false,
    steps: [], tenants: [],
  };
  let outputPath;
  let cleanupOrm;
  let stage = 'input';
  try {
    let envPath;
    let requestedOutput;
    let resumePath;
    if (Number.parseInt(process.versions.node.split('.')[0], 10) < 24) fail('NODE_24_REQUIRED');
    const seen = new Set();
    for (let index = 0; index < argv.length; index++) {
      const flag = argv[index];
      if (!['--env-file', '--output', '--apply', '--plan', '--resume-migrations-from', '--embedded-migrations'].includes(flag) || seen.has(flag)) fail('INVALID_ARGUMENTS');
      seen.add(flag);
      if (flag === '--env-file' || flag === '--output' || flag === '--resume-migrations-from') {
        if (!argv[index + 1] || argv[index + 1].startsWith('--')) fail('INVALID_ARGUMENTS');
        const value = argv[++index];
        if (flag === '--env-file') envPath = resolve(value);
        else if (flag === '--output') requestedOutput = resolve(value);
        else resumePath = resolve(value);
      }
    }
    if (!envPath || (seen.has('--apply') && seen.has('--plan'))) fail('INVALID_ARGUMENTS');
    if (requestedOutput) {
      const child = relative(resolve(root, 'evidence'), requestedOutput);
      if (isAbsolute(child) || child === '..' || child.startsWith('../')) fail('EVIDENCE_OUTPUT_OUTSIDE_PROJECT');
      outputPath = requestedOutput;
    }
    const metadata = lstatSync(envPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 65536 || (metadata.mode & 0o077)) fail('PRIVATE_CONFIGURATION_FILE_REQUIRED');
    const config = validateEnvironment(parseEnv(readFileSync(envPath, 'utf8')));
    report.developmentModuleMigrationAdapter = seen.has('--embedded-migrations');
    if (resumePath) {
      const trusted = realpathSync(resumePath);
      const child = relative(realpathSync(resolve(root, 'evidence')), trusted);
      if (isAbsolute(child) || child === '..' || child.startsWith('../')) fail('TRUSTED_MIGRATION_FAILURE_REPORT_REQUIRED');
      validateResumeReport(JSON.parse(readFileSync(trusted, 'utf8')));
      report.resumingReviewedPartialMigrations = true;
    }
    report.configurationValidated = true;
    report.plan = ['exact-database-empty-tables-and-extension-precheck', 'native-db-migrate', 'native-app-bootstrap', 'native-config-defaults', 'native-tenant-a-owner-and-admin', 'native-tenant-b-owner-and-admin'];
    if (report.mode === 'plan') { report.status = 'plan-validated'; return report; }
    if (report.developmentModuleMigrationAdapter && (typeof process.send !== 'function' || process.connected !== true)) fail('DEVELOPMENT_DB_IDLE_IPC_REQUIRED');
    stage = 'database-precheck';
    const requireFromApp = createRequire(resolve(app, 'package.json'));
    await precheckDatabase(config, requireFromApp, Boolean(resumePath));
    report.steps.push({ step: stage, status: 'passed' });
    for (const [key, value] of Object.entries(config)) if (!key.startsWith('SRD_')) process.env[key] = value;
    Object.assign(process.env, safeRuntime, {
      NODE_ENV: 'production', TENANT_DATA_ENCRYPTION: 'yes', QUEUE_STRATEGY: 'local',
      CACHE_STRATEGY: 'memory', DB_POOL_MIN: '1', DB_POOL_MAX: '1',
      OM_DEV_WITH_MCP: '0', OM_DISABLE_EMAIL_DELIVERY: '1', OM_MIGRATION_REINDEX: 'off',
      OM_ENABLE_ENTERPRISE_MODULES: 'false', OM_ENABLE_ENTERPRISE_MODULES_SSO: 'false',
      OM_ENABLE_ENTERPRISE_MODULES_SECURITY: 'false', OM_ENABLE_ENTERPRISE_MODULES_AGENTS: 'false',
      OM_CLI_QUIET: '1', OM_LOG_LEVEL: 'error',
    });
    process.chdir(app);
    const { run, registerCliModules } = await import(pathToFileURL(requireFromApp.resolve('@open-mercato/cli/mercato')).href);
    cleanupOrm = async () => {
      const { getOrm } = await import(pathToFileURL(requireFromApp.resolve('@open-mercato/shared/lib/db/mikro')).href);
      await (await getOrm()).close(true);
    };
    stage = 'native-db-migrate';
    const capture = (action, args) => captureNative(action, args, { secrets: Object.values(config) });
    if (report.developmentModuleMigrationAdapter) {
      report.migrationModules = [];
      await capture(async () => {
        const { createResolver } = await import(pathToFileURL(requireFromApp.resolve('@open-mercato/cli/lib/resolver')).href);
        const { dbMigrate } = await import(pathToFileURL(requireFromApp.resolve('@open-mercato/cli/lib/db/index')).href);
        await runDevelopmentModuleMigrations({
          createResolver, dbMigrate, waitForIdle: waitForDevelopmentDatabaseIdle,
          onModule: (id) => report.migrationModules.push({ id, status: 'native-pending-migrations-completed' }),
        });
      }, []);
    } else await capture(run, ['db', 'migrate']);
    report.steps.push({ step: stage, status: 'passed' });
    stage = 'native-app-bootstrap';
    await capture(async () => {
      const { bootstrapFromAppRoot } = await import(pathToFileURL(requireFromApp.resolve('@open-mercato/shared/lib/bootstrap/dynamicLoader')).href);
      await prepareNativeApplication(bootstrapFromAppRoot, registerCliModules);
    }, []);
    report.steps.push({ step: stage, status: 'passed' });
    stage = 'native-config-defaults';
    await capture(run, ['configs', 'restore-defaults']);
    report.steps.push({ step: stage, status: 'passed' });
    for (const suffix of ['A', 'B']) {
      stage = 'native-tenant-' + suffix.toLowerCase() + '-owner';
      const tenant = parseSetupOutput(await capture(run, buildSetupArgs(config, suffix)));
      report.steps.push({ step: stage, status: 'passed' });
      stage = 'native-tenant-' + suffix.toLowerCase() + '-admin';
      const result = await capture(run, buildAdminArgs(config, suffix, tenant.organizationId));
      const adminId = /^User created with id ([a-f0-9-]{36})\s*$/im.exec(result)?.[1];
      if (!UUID.test(adminId ?? '')) fail('INVALID_NATIVE_ADMIN_RESULT');
      report.tenants.push({ label: suffix, ...tenant, adminUserId: adminId });
      report.steps.push({ step: stage, status: 'passed' });
    }
    if (report.tenants[0].tenantId === report.tenants[1].tenantId || report.tenants[0].organizationId === report.tenants[1].organizationId) fail('SCOPES_NOT_DISTINCT');
    await capture(async () => {
      const { flushBeforeExit } = await import(pathToFileURL(requireFromApp.resolve('@open-mercato/cli/lib/flush-before-exit')).href);
      await flushBeforeExit();
    }, []);
    report.nativeExitFlushAttempted = true;
    report.status = 'initialized-not-accepted';
  } catch (error) {
    report.status = 'blocked';
    report.failedStage = stage;
    report.errorCode = safeFailure(error);
    if (error instanceof FoundationError && error.diagnostic) report.nativeDiagnostic = error.diagnostic;
  } finally {
    if (cleanupOrm) { try { await captureNative(cleanupOrm, []); } catch { report.cleanupWarning = 'ORM_CLOSE_NOT_VERIFIED'; } }
    if (outputPath) {
      try { mkdirSync(dirname(outputPath), { recursive: true }); writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); }
      catch { report.outputWarning = 'EVIDENCE_WRITE_FAILED'; }
    }
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await main();
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exitCode = ['initialized-not-accepted', 'plan-validated'].includes(report.status) ? 0 : 2;
}
