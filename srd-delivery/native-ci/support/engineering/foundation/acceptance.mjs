#!/usr/bin/env node
/** Native F1 API acceptance candidate. Starts no app, runs no migrations, calls no provider. */
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, lstatSync, realpathSync, mkdirSync, existsSync, openSync, closeSync, fsyncSync, ftruncateSync, writeSync } from 'node:fs';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { validateEnvironment } from './bootstrap.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const app = resolve(root, 'srd-ai-ops');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const NATIVE_INSPECTOR = Symbol('native-foundation-inspector');
const REQUEST_TIMEOUT_MS = 12000;
const CONVERGENCE_DEADLINE_MS = 10000;
const LOCK_HEADER = 'x-om-ext-optimistic-lock-expected-updated-at';
class AcceptanceError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const requireCondition = (value, code) => { if (!value) throw new AcceptanceError(code); };
const within = (base, target) => {
  const child = relative(base, target);
  return child !== '..' && !child.startsWith('../') && !isAbsolute(child);
};

export function validateBaseUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new AcceptanceError('EXPLICIT_LOOPBACK_APP_ORIGIN_REQUIRED'); }
  requireCondition(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
    url.port && url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash,
  'EXPLICIT_LOOPBACK_APP_ORIGIN_REQUIRED');
  return url.origin;
}

export function validateBootstrap(value) {
  requireCondition(value?.kind === 'isolated-synthetic-native-bootstrap' &&
    value.status === 'initialized-not-accepted' && value.mode === 'apply' && value.configurationValidated === true &&
    Array.isArray(value.tenants) && value.tenants.length === 2, 'SUCCESSFUL_TWO_TENANT_BOOTSTRAP_REQUIRED');
  const tenants = new Map();
  for (const tenant of value.tenants) {
    requireCondition(['A', 'B'].includes(tenant.label) && !tenants.has(tenant.label) &&
      ['tenantId', 'organizationId', 'adminUserId', 'ownerUserId'].every((key) => UUID.test(tenant[key] ?? '')) &&
      tenant.adminUserId !== tenant.ownerUserId, 'ORDINARY_ADMIN_FIXTURE_REQUIRED');
    tenants.set(tenant.label, tenant);
  }
  requireCondition(tenants.size === 2 && tenants.get('A').tenantId !== tenants.get('B').tenantId &&
    tenants.get('A').organizationId !== tenants.get('B').organizationId, 'DISTINCT_BUSINESS_SCOPES_REQUIRED');
  return tenants;
}

export function readTokenClaims(token, fixture) {
  let claims;
  try { claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); } catch { throw new AcceptanceError('ORDINARY_ADMIN_TOKEN_REQUIRED'); }
  requireCondition(claims?.sub === fixture.adminUserId && claims.tenantId === fixture.tenantId &&
    claims.orgId === fixture.organizationId && Array.isArray(claims.roles) &&
    claims.roles.includes('admin') && !claims.roles.includes('superadmin'), 'ORDINARY_ADMIN_TOKEN_REQUIRED');
  // Decoding is a fixture check. Subsequent actual requests verify server authentication.
  return claims;
}

export function encryptedEnvelope(value) {
  if (typeof value !== 'string') return false;
  const parts = value.split(':');
  return parts.length === 4 && parts[3] === 'v1' && /^[A-Za-z0-9+/]+={0,2}$/.test(parts[0]) &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(parts[1]) && /^[A-Za-z0-9+/]+={0,2}$/.test(parts[2]) &&
    Buffer.from(parts[0], 'base64').length === 12 && Buffer.from(parts[1], 'base64').length > 0 &&
    Buffer.from(parts[2], 'base64').length === 16;
}

export function assertOrdinaryAdminRows(rows, elevatedUserAcl, fixture) {
  // Conservative fresh-fixture contract: reject any elevated ACL, even a restricted or inactive one.
  requireCondition(elevatedUserAcl === false && rows.length > 0 && rows.every((row) =>
    row.tenant_id === fixture.tenantId && row.organization_id === fixture.organizationId &&
    row.role_tenant_id === fixture.tenantId && row.name !== 'superadmin' && row.is_super_admin !== true) &&
    rows.some((row) => row.name === 'admin'), 'SCOPED_ADMIN_DATABASE_FIXTURE_REQUIRED');
}

export function createNativeInspector(config) {
  const requireFromApp = createRequire(resolve(app, 'package.json'));
  const { Client } = requireFromApp('pg');
  let client;
  const query = async (sql, values = []) => client.query(sql, values);
  return {
    [NATIVE_INSPECTOR]: true,
    async open() {
      client = new Client({ connectionString: config.DATABASE_URL, connectionTimeoutMillis: REQUEST_TIMEOUT_MS });
      await client.connect();
      const result = await query("SELECT current_database() AS database, current_setting('server_version_num')::int AS version");
      requireCondition(result.rows[0]?.database === 'srd_ops_f1' &&
        result.rows[0]?.version >= 170000 && result.rows[0]?.version < 180000, 'NATIVE_POSTGRES17_DATABASE_REQUIRED');
      return { kind: 'native-postgres17-direct-read', serverVersionNumber: result.rows[0].version };
    },
    async operator(fixture) {
      const result = await query(
        'SELECT u.tenant_id, u.organization_id, r.tenant_id AS role_tenant_id, r.name, a.is_super_admin FROM users u JOIN user_roles ur ON ur.user_id=u.id JOIN roles r ON r.id=ur.role_id LEFT JOIN role_acls a ON a.role_id=r.id WHERE u.id=$1 AND u.deleted_at IS NULL AND ur.deleted_at IS NULL AND r.deleted_at IS NULL',
        [fixture.adminUserId]);
      const elevated = await query('SELECT EXISTS (SELECT 1 FROM user_acls WHERE user_id=$1 AND is_super_admin=true) AS elevated', [fixture.adminUserId]);
      assertOrdinaryAdminRows(result.rows, elevated.rows[0]?.elevated, fixture);
    },
    async snapshot(id) {
      requireCondition(UUID.test(id ?? ''), 'INVALID_CREATED_CONTACT_ID');
      const result = await query('SELECT to_jsonb(e) AS snapshot FROM customer_entities e WHERE e.id=$1', [id]);
      return result.rows[0]?.snapshot ?? null;
    },
    async runContacts(source) {
      const result = await query('SELECT id, tenant_id, organization_id, deleted_at FROM customer_entities WHERE source=$1 ORDER BY id', [source]);
      return result.rows;
    },
    async close() { if (client) await client.end(); },
  };
}

export async function runAcceptance({ baseUrl, config, bootstrap, sourceRevision, inspector, fetchImpl = globalThis.fetch }) {
  const report = {
    schemaVersion: 1, kind: 'native-foundation-api-acceptance-candidate',
    runId: randomUUID(), startedAtUtc: new Date().toISOString(), status: 'blocked',
    sourceRevision: REVISION.test(sourceRevision ?? '') ? sourceRevision : null,
    executionKind: inspector?.[NATIVE_INSPECTOR] === true && fetchImpl === globalThis.fetch ? 'native-api-and-database' : 'harness-unit-simulation',
    phaseAccepted: false, productionAccepted: false, backgroundJobsAccepted: false, databaseLeastPrivilegeAccepted: false,
    providerCallsMadeByHarness: false, credentialsIncluded: false, rawBodiesRetained: false,
    cases: [], requests: [], cleanup: { contactsRemoved: 0, contactsRemaining: null, sessionsRevoked: 0, databaseClosed: false },
  };
  let origin;
  let tenants;
  let stage = 'input';
  const sessions = new Map();
  const issuedTokens = new Map();
  const contacts = new Map();
  const source = 'foundation-acceptance:' + report.runId;
  let opened = false;
  const record = async (id, action) => {
    stage = id;
    try { await action(); report.cases.push({ id, status: 'passed' }); }
    catch (error) {
      report.cases.push({ id, status: 'failed', code: error instanceof AcceptanceError ? error.code : 'ACCEPTANCE_OPERATION_FAILED' });
      throw error;
    }
  };
  const request = async (label, method, route, { body, version, cookie, form = false, bearer } = {}) => {
    requireCondition(route.startsWith('/api/'), 'API_ROUTE_REQUIRED');
    const target = new URL(route, origin);
    requireCondition(target.origin === origin, 'CROSS_ORIGIN_REQUEST_DENIED');
    const headers = { accept: 'application/json' };
    const token = bearer ?? sessions.get(label);
    if (token) headers.authorization = 'Bearer ' + token;
    if (cookie) headers.cookie = cookie;
    if (version) headers[LOCK_HEADER] = version;
    if (body !== undefined) headers['content-type'] = form ? 'application/x-www-form-urlencoded' : 'application/json';
    let response;
    try {
      response = await fetchImpl(target.href, {
        method, headers, body: body === undefined ? undefined : form ? new URLSearchParams(body).toString() : JSON.stringify(body),
        redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch { throw new AcceptanceError('APPLICATION_REQUEST_UNAVAILABLE'); }
    report.requests.push({ actor: ['A', 'B'].includes(label) ? label : 'anonymous', method,
      route: target.pathname.replace(/[a-f0-9]{8}-[a-f0-9-]{27,}/gi, ':id'), status: response.status });
    let json = null;
    try {
      const text = await response.text();
      requireCondition(text.length <= 2_000_000, 'RESPONSE_SIZE_LIMIT');
      if (text) { try { json = JSON.parse(text); } catch { /* A status assertion may accept an empty redirect. */ } }
    } catch (error) { if (error instanceof AcceptanceError) throw error; throw new AcceptanceError('APPLICATION_RESPONSE_UNAVAILABLE'); }
    return { status: response.status, body: json };
  };
  const rememberIssuedToken = (label, response) => {
    if (typeof response.body?.token === 'string' && response.body.token.length > 0) issuedTokens.set(response.body.token, label);
  };
  const detail = async (label, id) => {
    const value = await request(label, 'GET', '/api/customers/people/' + id);
    requireCondition(value.status === 200 && value.body?.person?.id === id, 'CONTACT_DETAIL_UNAVAILABLE');
    const fixture = tenants.get(label);
    requireCondition(value.body.person.tenantId === fixture.tenantId && value.body.person.organizationId === fixture.organizationId, 'CONTACT_DETAIL_SCOPE_MISMATCH');
    requireCondition(typeof value.body.person.updatedAt === 'string' && Number.isFinite(Date.parse(value.body.person.updatedAt)), 'CONTACT_VERSION_REQUIRED');
    return value.body;
  };
  const unchanged = async (id, snapshot) => {
    requireCondition(JSON.stringify(await inspector.snapshot(id)) === JSON.stringify(snapshot), 'FOREIGN_MUTATION_CHANGED_DATABASE');
  };
  try {
    origin = validateBaseUrl(baseUrl);
    config = validateEnvironment(config);
    tenants = validateBootstrap(bootstrap);
    requireCondition(report.sourceRevision && inspector && typeof inspector.open === 'function', 'SOURCE_AND_DATABASE_INSPECTOR_REQUIRED');
    stage = 'database-runtime';
    report.database = await inspector.open();
    opened = true;
    await record('native-admin-fixtures', async () => {
      for (const label of ['A', 'B']) await inspector.operator(tenants.get(label));
    });
    await record('application-health', async () => {
      const value = await request(null, 'GET', '/api/healthz');
      requireCondition(value.status === 200 && value.body?.status === 'ok', 'APPLICATION_HEALTH_NOT_READY');
    });
    await record('unauthenticated-crm-denied', async () => {
      const value = await request(null, 'GET', '/api/customers/people?page=1&pageSize=1');
      requireCondition(value.status === 401, 'UNAUTHENTICATED_CRM_NOT_DENIED');
    });
    await record('incorrect-password-denied', async () => {
      const value = await request(null, 'POST', '/api/auth/login', {
        form: true, body: { email: config.SRD_F1_EMAIL_A, password: randomUUID() + '-deliberately-incorrect', tenantId: tenants.get('A').tenantId },
      });
      rememberIssuedToken('A', value);
      requireCondition(value.status === 401 && !value.body?.token, 'INCORRECT_PASSWORD_NOT_DENIED');
    });
    for (const label of ['A', 'B']) await record('ordinary-admin-' + label.toLowerCase() + '-login', async () => {
      const fixture = tenants.get(label);
      const value = await request(null, 'POST', '/api/auth/login', {
        form: true, body: { email: config['SRD_F1_EMAIL_' + label], password: config['SRD_F1_PASSWORD_' + label], tenantId: fixture.tenantId },
      });
      rememberIssuedToken(label, value);
      requireCondition(value.status === 200 && value.body?.ok === true && typeof value.body.token === 'string', 'ADMIN_LOGIN_FAILED');
      readTokenClaims(value.body.token, fixture);
      sessions.set(label, value.body.token);
    });
    for (const label of ['A', 'B']) await record('contact-' + label.toLowerCase() + '-create-and-persist', async () => {
      const firstName = 'Synthetic';
      const lastName = 'Foundation ' + label + ' ' + report.runId.slice(0, 8);
      const displayName = firstName + ' ' + lastName;
      const description = 'Initial synthetic contact ' + label + ' ' + report.runId;
      const primaryEmail = report.runId + '.' + label.toLowerCase() + '@srd-foundation.invalid';
      const created = await request(label, 'POST', '/api/customers/people', { body: { firstName, lastName, displayName, description, primaryEmail, source } });
      requireCondition(created.status === 201 && UUID.test(created.body?.id ?? '') && UUID.test(created.body?.personId ?? ''), 'CONTACT_CREATE_RESPONSE_INVALID');
      contacts.set(label, created.body.id);
      const value = await detail(label, created.body.id);
      requireCondition(value.person.displayName === displayName && value.person.description === description && value.person.primaryEmail === primaryEmail &&
        value.profile?.firstName === firstName && value.profile?.lastName === lastName, 'CONTACT_ROUNDTRIP_MISMATCH');
      const stored = await inspector.snapshot(created.body.id);
      const fixture = tenants.get(label);
      requireCondition(stored && stored.source === source && stored.tenant_id === fixture.tenantId && stored.organization_id === fixture.organizationId &&
        stored.deleted_at === null, 'CONTACT_DATABASE_SCOPE_MISMATCH');
      requireCondition(encryptedEnvelope(stored.description) && encryptedEnvelope(stored.display_name) && encryptedEnvelope(stored.primary_email) &&
        stored.description !== description && stored.primary_email !== primaryEmail, 'CONTACT_AT_REST_ENCRYPTION_NOT_OBSERVED');
    });
    await record('contact-own-list-converges', async () => {
      for (const label of ['A', 'B']) {
        const id = contacts.get(label);
        const deadline = Date.now() + CONVERGENCE_DEADLINE_MS;
        let found = false;
        while (Date.now() < deadline) {
          const value = await request(label, 'GET', '/api/customers/people?id=' + id);
          requireCondition(value.status === 200 && Array.isArray(value.body?.items), 'CONTACT_LIST_RESPONSE_INVALID');
          if (value.body.items.some((row) => row.id === id)) { found = true; break; }
          await new Promise((done) => setTimeout(done, 50));
        }
        requireCondition(found, 'CONTACT_LIST_DID_NOT_CONVERGE');
      }
    });
    await record('cross-tenant-list-and-detail-denied', async () => {
      for (const [actor, owner] of [['B', 'A'], ['A', 'B']]) {
        const id = contacts.get(owner);
        const list = await request(actor, 'GET', '/api/customers/people?id=' + id);
        requireCondition(list.status === 200 && Array.isArray(list.body?.items) && list.body.items.length === 0, 'FOREIGN_CONTACT_LIST_LEAK');
        const value = await request(actor, 'GET', '/api/customers/people/' + id);
        requireCondition(value.status === 404, 'FOREIGN_CONTACT_DETAIL_NOT_HIDDEN');
      }
    });
    await record('forged-scope-cookie-denied', async () => {
      const fixture = tenants.get('A');
      const value = await request('B', 'GET', '/api/customers/people/' + contacts.get('A'), {
        cookie: 'om_selected_tenant=' + fixture.tenantId + '; om_selected_org=' + fixture.organizationId,
      });
      requireCondition([403, 404].includes(value.status), 'FORGED_SCOPE_COOKIE_EXPOSED_CONTACT');
    });
    await record('foreign-contact-update-denied-and-unchanged', async () => {
      const id = contacts.get('A');
      const snapshot = await inspector.snapshot(id);
      const value = await request('B', 'PUT', '/api/customers/people', { body: { id, description: 'Forbidden synthetic modification' } });
      requireCondition([403, 404].includes(value.status), 'FOREIGN_CONTACT_UPDATE_NOT_DENIED');
      await unchanged(id, snapshot);
      const fixture = tenants.get('A');
      const forged = await request('B', 'PUT', '/api/customers/people', {
        body: { id, description: 'Forbidden forged scope', tenantId: fixture.tenantId, organizationId: fixture.organizationId },
      });
      requireCondition([403, 404].includes(forged.status), 'FORGED_SCOPE_UPDATE_NOT_DENIED');
      await unchanged(id, snapshot);
    });
    await record('contact-update-reload-stale-conflict-and-clear', async () => {
      const id = contacts.get('A');
      const before = await detail('A', id);
      const updatedDescription = 'Updated synthetic note ' + report.runId;
      const update = await request('A', 'PUT', '/api/customers/people', { version: before.person.updatedAt, body: { id, description: updatedDescription } });
      requireCondition(update.status === 200 && update.body?.ok === true, 'CONTACT_UPDATE_FAILED');
      const after = await detail('A', id);
      requireCondition(after.person.description === updatedDescription && after.person.updatedAt !== before.person.updatedAt, 'CONTACT_UPDATE_VERSION_OR_RELOAD_FAILED');
      const snapshot = await inspector.snapshot(id);
      const stale = await request('A', 'PUT', '/api/customers/people', { version: before.person.updatedAt, body: { id, description: 'Stale synthetic note' } });
      requireCondition(stale.status === 409, 'STALE_CONTACT_UPDATE_NOT_REJECTED');
      await unchanged(id, snapshot);
      const clear = await request('A', 'PUT', '/api/customers/people', { version: after.person.updatedAt, body: { id, description: null } });
      requireCondition(clear.status === 200 && clear.body?.ok === true, 'CONTACT_CLEAR_FAILED');
      requireCondition((await detail('A', id)).person.description === null && (await inspector.snapshot(id)).description === null, 'CONTACT_CLEAR_NOT_PERSISTED');
    });
    await record('invalid-and-forged-create-have-no-side-effect', async () => {
      const count = (await inspector.runContacts(source)).length;
      const invalid = await request('A', 'POST', '/api/customers/people', { body: { firstName: '', lastName: 'Invalid synthetic fixture', source } });
      requireCondition(invalid.status === 400, 'INVALID_CONTACT_CREATE_NOT_REJECTED');
      const foreign = tenants.get('A');
      const forged = await request('B', 'POST', '/api/customers/people', {
        body: { firstName: 'Forbidden', lastName: 'Synthetic', source, tenantId: foreign.tenantId, organizationId: foreign.organizationId },
      });
      requireCondition([403, 404].includes(forged.status), 'FORGED_SCOPE_CREATE_NOT_REJECTED');
      requireCondition((await inspector.runContacts(source)).length === count, 'DENIED_CREATE_CHANGED_DATABASE');
    });
    report.status = 'checks-passed-cleanup-pending';
  } catch (error) {
    report.status = 'failed';
    report.failedStage = stage;
    report.errorCode = error instanceof AcceptanceError ? error.code : 'ACCEPTANCE_OPERATION_FAILED';
  } finally {
    if (opened && tenants) {
      try {
        const rows = await inspector.runContacts(source);
        for (const row of rows.filter((row) => row.deleted_at === null)) {
          try {
            const label = ['A', 'B'].find((value) => tenants.get(value).tenantId === row.tenant_id && tenants.get(value).organizationId === row.organization_id);
            requireCondition(label && sessions.has(label) && UUID.test(row.id), 'OWNED_CONTACT_CLEANUP_SCOPE_UNAVAILABLE');
            const value = await detail(label, row.id);
            const deleted = await request(label, 'DELETE', '/api/customers/people', { version: value.person.updatedAt, body: { id: row.id } });
            requireCondition(deleted.status === 200 && deleted.body?.ok === true, 'OWNED_CONTACT_DELETE_FAILED');
            requireCondition((await request(label, 'GET', '/api/customers/people/' + row.id)).status === 404, 'DELETED_CONTACT_STILL_READABLE');
            report.cleanup.contactsRemoved++;
          } catch (error) {
            report.cleanup.errorCode ??= error instanceof AcceptanceError ? error.code : 'CONTACT_CLEANUP_FAILED';
          }
        }
        report.cleanup.contactsRemaining = (await inspector.runContacts(source)).filter((row) => row.deleted_at === null).length;
        requireCondition(report.cleanup.contactsRemaining === 0, 'OWNED_CONTACT_CLEANUP_INCOMPLETE');
      } catch (error) {
        report.cleanup.errorCode ??= error instanceof AcceptanceError ? error.code : 'CONTACT_CLEANUP_FAILED';
      }
    }
    for (const [token, label] of issuedTokens) {
      try {
        const value = await request(label, 'POST', '/api/auth/logout', { bearer: token, cookie: 'auth_token=' + encodeURIComponent(token) });
        requireCondition([302, 303, 307, 308].includes(value.status), 'SESSION_LOGOUT_FAILED');
        requireCondition((await request(label, 'GET', '/api/customers/people?page=1&pageSize=1', { bearer: token })).status === 401, 'LOGGED_OUT_TOKEN_STILL_AUTHORIZED');
        report.cleanup.sessionsRevoked++;
      } catch {
        report.cleanup.sessionError = 'SESSION_REVOCATION_NOT_VERIFIED';
      }
    }
    try { await inspector?.close?.(); report.cleanup.databaseClosed = true; } catch { report.cleanup.databaseClosed = false; }
    if (report.status === 'checks-passed-cleanup-pending') {
      report.status = report.cleanup.contactsRemaining === 0 && report.cleanup.sessionsRevoked === 2 && report.cleanup.databaseClosed &&
        !report.cleanup.errorCode && !report.cleanup.sessionError
        ? report.executionKind === 'native-api-and-database' ? 'passed-native-api-foundation-subset' : 'passed-harness-simulation'
        : 'failed-cleanup';
    }
    report.endedAtUtc = new Date().toISOString();
  }
  report.apiPersistenceAndTenantSubsetAccepted = report.status === 'passed-native-api-foundation-subset';
  return report;
}

export function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    requireCondition(['--env-file', '--bootstrap-report', '--base-url', '--source-revision', '--output'].includes(flag) &&
      values[flag] === undefined && argv[index + 1] && !argv[index + 1].startsWith('--'), 'INVALID_ARGUMENTS');
    values[flag] = argv[index + 1];
  }
  requireCondition(['--env-file', '--bootstrap-report', '--base-url', '--source-revision'].every((key) => values[key]), 'EXPLICIT_ACCEPTANCE_INPUTS_REQUIRED');
  validateBaseUrl(values['--base-url']);
  requireCondition(REVISION.test(values['--source-revision']), 'EXACT_SOURCE_REVISION_REQUIRED');
  return values;
}

function readPrivateFixture(path) {
  const metadata = lstatSync(path);
  requireCondition(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size <= 65536 && !(metadata.mode & 0o077) &&
    within(realpathSync(resolve(root, 'runtime/.secrets')), realpathSync(path)), 'OWNED_PRIVATE_FIXTURE_REQUIRED');
  return validateEnvironment(parseEnv(readFileSync(path, 'utf8')));
}

export function reserveEvidence(path) {
  const directory = resolve(root, 'evidence');
  requireCondition(within(directory, path), 'OWNED_EVIDENCE_PATH_REQUIRED');
  let current = directory;
  if (!existsSync(current)) mkdirSync(current);
  requireCondition(lstatSync(current).isDirectory() && !lstatSync(current).isSymbolicLink(), 'OWNED_EVIDENCE_PATH_REQUIRED');
  for (const part of relative(directory, dirname(path)).split('/').filter(Boolean)) {
    current = resolve(current, part);
    if (!existsSync(current)) mkdirSync(current);
    requireCondition(lstatSync(current).isDirectory() && !lstatSync(current).isSymbolicLink(), 'OWNED_EVIDENCE_PATH_REQUIRED');
  }
  return openSync(path, 'wx', 0o600);
}

export function writeReservedEvidence(descriptor, report) {
  const data = Buffer.from(JSON.stringify(report, null, 2) + '\n');
  ftruncateSync(descriptor, 0);
  let offset = 0;
  while (offset < data.length) {
    const written = writeSync(descriptor, data, offset, data.length - offset, offset);
    requireCondition(written > 0, 'ACCEPTANCE_EVIDENCE_WRITE_FAILED');
    offset += written;
  }
  fsyncSync(descriptor);
}

export async function main(argv = process.argv.slice(2)) {
  let evidenceFile;
  let output;
  try {
    const values = parseArguments(argv);
    const config = readPrivateFixture(resolve(values['--env-file']));
    const bootstrapPath = realpathSync(resolve(values['--bootstrap-report']));
    requireCondition(within(realpathSync(resolve(root, 'evidence')), bootstrapPath), 'OWNED_BOOTSTRAP_EVIDENCE_REQUIRED');
    const bootstrap = JSON.parse(readFileSync(bootstrapPath, 'utf8'));
    validateBootstrap(bootstrap);
    output = values['--output'] ? resolve(values['--output']) :
      resolve(root, 'evidence/2026-10-31/f1-development/api-acceptance-' + randomUUID() + '.json');
    // Reserve the owned evidence file before connecting to the database or making mutations.
    evidenceFile = reserveEvidence(output);
    writeReservedEvidence(evidenceFile, { kind: 'native-foundation-api-acceptance-candidate', status: 'starting', phaseAccepted: false, productionAccepted: false });
    const report = await runAcceptance({ baseUrl: values['--base-url'], config, bootstrap,
      sourceRevision: values['--source-revision'], inspector: createNativeInspector(config) });
    writeReservedEvidence(evidenceFile, report);
    return { report, output: relative(root, output).split('\\').join('/') };
  } catch (error) {
    const report = { status: 'blocked', kind: 'native-foundation-api-acceptance-candidate', phaseAccepted: false,
      productionAccepted: false, errorCode: error instanceof AcceptanceError ? error.code : 'ACCEPTANCE_INPUT_OR_RUNTIME_UNAVAILABLE',
      credentialsIncluded: false, rawBodiesRetained: false };
    if (evidenceFile !== undefined) {
      try { writeReservedEvidence(evidenceFile, report); return { report, output: relative(root, output).split('\\').join('/') }; } catch {}
    }
    return { report, output: null };
  } finally {
    if (evidenceFile !== undefined) { try { closeSync(evidenceFile); } catch {} }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await main();
  process.stdout.write(JSON.stringify({ status: result.report.status, errorCode: result.report.errorCode ?? null,
    failedStage: result.report.failedStage ?? null, cases: result.report.cases?.length ?? 0,
    report: result.output, phaseAccepted: false, productionAccepted: false }) + '\n');
  process.exitCode = result.report.status === 'passed-native-api-foundation-subset' ? 0 : 2;
}
